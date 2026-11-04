/**
 * 录制契约测试用的录制文件（M1-02a）。只在本地经 `pnpm contract:record` 运行，普通测试中跳过。
 *
 * 每个场景：模型 → 录制代理 → 上游，写出 `contract/cassettes/<名称>.json`；随后回放一次，确认轨迹与
 * 直连时完全一致，并打印每一步的结果（结束原因、用量、文本、推理长度、工具调用）供检查。
 * 黄金文件随后用 `pnpm vitest run -u packages/runtime-pi/src/contract.test.ts` 生成，审阅后提交。
 *
 * 参数（环境变量）：
 * - 不带参数：用合成上游重新录制全部场景；
 * - `NEXUS_CONTRACT_ONLY`：只录制这个场景（如 `openai-tool`）；
 * - `NEXUS_CONTRACT_UPSTREAM`：真实服务的根地址（可带路径前缀，如 `https://api.deepseek.com/anthropic`），
 *   此时必须同时给出 `NEXUS_CONTRACT_ONLY`、`NEXUS_CONTRACT_MODEL`、`NEXUS_CONTRACT_KEY_ENV`；
 * - `NEXUS_CONTRACT_KEY_ENV`：保存 Key 的环境变量名。Key 只从环境变量读取，不写入录制文件；
 * - `NEXUS_CONTRACT_NAME`：录制文件名（默认为场景名）；
 * - `NEXUS_CONTRACT_REASONING=0`：按不支持推理配置模型（默认支持）。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_KEY, saveCassette } from './testing/contract/cassette.js'
import { recordScenario } from './testing/contract/record.js'
import { startReplayServer } from './testing/contract/replay-server.js'
import { SCENARIOS, runScenario, type ScenarioRun } from './testing/contract/scenarios.js'
import { normalizeRun } from './testing/contract/trace.js'
import { startUpstreamMock } from './testing/contract/upstream-mock.js'

const env = process.env
const enabled = env['npm_lifecycle_event'] === 'contract:record'

function summarize(run: ScenarioRun): string[] {
  const lines: string[] = []
  for (const event of run.events) {
    if (event.type === 'message.completed') {
      const m = event.message
      const text = m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('')
      const calls = (m.toolCalls ?? []).map((c) => `${c.name}${JSON.stringify(c.input)}`)
      lines.push(
        `  message: text=${JSON.stringify(text.slice(0, 120))} reasoning=${m.reasoning?.text.length ?? 0} chars tools=[${calls.join(', ')}]`,
      )
    } else if (event.type === 'step.completed') {
      lines.push(`  step: ${event.finishReason} usage=${JSON.stringify(event.usage ?? null)}`)
    } else if (event.type === 'loop.ended') {
      lines.push(`  loop: ${event.outcome}${event.error ? ` ${JSON.stringify(event.error)}` : ''}`)
    }
  }
  return lines
}

describe.skipIf(!enabled)('录制', () => {
  it('录制并回放确认', async () => {
    const upstreamUrl = env['NEXUS_CONTRACT_UPSTREAM']
    const only = env['NEXUS_CONTRACT_ONLY']
    const model = env['NEXUS_CONTRACT_MODEL']
    const keyEnv = env['NEXUS_CONTRACT_KEY_ENV']
    if (upstreamUrl && !(only && model && keyEnv)) {
      throw new Error('NEXUS_CONTRACT_UPSTREAM requires NEXUS_CONTRACT_ONLY, _MODEL and _KEY_ENV')
    }
    const apiKey = upstreamUrl ? env[keyEnv!] : PLACEHOLDER_KEY
    if (!apiKey) throw new Error(`environment variable ${keyEnv} is empty`)
    const selected = SCENARIOS.filter((s) => !only || s.name === only)
    if (selected.length === 0) throw new Error(`unknown scenario ${only}`)
    const reasoning = env['NEXUS_CONTRACT_REASONING'] !== '0'

    const mock = upstreamUrl ? undefined : await startUpstreamMock()
    const dir = path.resolve(import.meta.dirname, '../contract/cassettes')
    try {
      for (const scenario of selected) {
        const { cassette, live } = await recordScenario(scenario, {
          upstream: upstreamUrl ?? mock!.baseUrl,
          apiKey,
          reasoning,
          source: upstreamUrl ?? 'synthetic',
          ...(env['NEXUS_CONTRACT_NAME'] ? { name: env['NEXUS_CONTRACT_NAME'] } : {}),
          ...(model ? { model } : {}),
        })
        saveCassette(path.join(dir, `${cassette.name}.json`), cassette)

        const server = await startReplayServer(cassette)
        const replayed = await runScenario(scenario, {
          baseUrl: server.baseUrl,
          apiKey: PLACEHOLDER_KEY,
          model: cassette.model,
          reasoning,
        })
        await server.close()
        const status = cassette.interactions.map((i) => i.response.status).join(',')
        console.log(
          [`${cassette.name} (${cassette.source}) status=${status}`, ...summarize(live)].join('\n'),
        )
        expect(server.mismatches, cassette.name).toEqual([])
        expect(normalizeRun(replayed), cassette.name).toEqual(normalizeRun(live))
      }
    } finally {
      await mock?.close()
    }
  })
})
