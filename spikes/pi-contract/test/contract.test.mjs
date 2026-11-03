// @ts-check
/**
 * 契约测试：用录制的响应驱动 pi，事件轨迹与黄金文件（`golden/<场景>.events.json`）比对。
 * 黄金文件由 `npm run test:update` 生成；pi 升级后有差异时，审阅 diff 后再更新。
 *
 * 另外验证"稳定复现"：同一录制在不同分块方式下、多次重复回放，轨迹完全相同。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_KEY, loadCassette } from '../src/cassette.mjs'
import { startReplayServer } from '../src/replay-server.mjs'
import { SCENARIOS, runScenario } from '../src/scenarios.mjs'
import { normalizeEvents } from '../src/trace.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cassetteFile = (/** @type {string} */ name) => path.join(root, 'cassettes', `${name}.json`)

/** @type {import('../src/replay-server.mjs').Chunking[]} */
const CHUNKINGS = [
  'whole',
  { bytes: 1 },
  { bytes: 2 },
  { bytes: 3 },
  { bytes: 64 },
  ...Array.from({ length: 10 }, (_, i) => ({ seed: i + 1 })),
]
const REPEATS = 5

/**
 * @param {import('../src/scenarios.mjs').Scenario} scenario
 * @param {import('../src/cassette.mjs').Cassette} cassette
 * @param {import('../src/replay-server.mjs').Chunking} [chunking]
 */
async function replay(scenario, cassette, chunking) {
  const server = await startReplayServer(cassette, { chunking })
  try {
    const { events, toolCalls } = await runScenario(scenario, {
      baseUrl: server.baseUrl,
      apiKey: PLACEHOLDER_KEY,
    })
    return {
      trace: normalizeEvents(events),
      toolCalls,
      mismatches: server.mismatches,
      remaining: server.remaining(),
    }
  } finally {
    await server.close()
  }
}

/** `cassettes/` 下的全部录制（含从真实服务录制的），按录制中记录的场景与模型回放。 */
const CASSETTES = readdirSync(path.join(root, 'cassettes'))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => loadCassette(path.join(root, 'cassettes', file)))

describe.each(CASSETTES.map((cassette) => ({ name: cassette.name, cassette })))(
  '$name',
  ({ cassette }) => {
    const base = SCENARIOS.find((s) => s.name === cassette.scenario)
    if (!base) throw new Error(`${cassette.name}: unknown scenario ${cassette.scenario}`)
    const scenario = { ...base, model: cassette.model }

    it('回放得到与黄金文件相同的事件轨迹', async () => {
      const result = await replay(scenario, cassette)
      expect(result.mismatches).toEqual([])
      expect(result.remaining).toBe(0)
      await expect(`${JSON.stringify(result.trace, null, 2)}\n`).toMatchFileSnapshot(
        path.join(root, 'golden', `${cassette.name}.events.json`),
      )
    })

    it('不同分块方式与重复回放的轨迹完全相同', async () => {
      const reference = await replay(scenario, cassette)
      const runs = [...CHUNKINGS, ...Array.from({ length: REPEATS }, () => 'recorded')]
      for (const chunking of /** @type {import('../src/replay-server.mjs').Chunking[]} */ (runs)) {
        const result = await replay(scenario, cassette, chunking)
        expect(result.mismatches, JSON.stringify(chunking)).toEqual([])
        expect(result.trace, JSON.stringify(chunking)).toEqual(reference.trace)
        expect(result.toolCalls, JSON.stringify(chunking)).toEqual(reference.toolCalls)
      }
    })
  },
)

describe('回放服务', () => {
  const scenario = /** @type {import('../src/scenarios.mjs').Scenario} */ (
    SCENARIOS.find((s) => s.name === 'openai-tool')
  )
  const cassette = loadCassette(cassetteFile('openai-tool'))

  it('请求与录制不一致时报告差异，pi 以 error 结束', async () => {
    const result = await replay({ ...scenario, prompt: 'What is 4 + 4?' }, cassette)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]?.fields).toEqual(['body'])
    const last = result.trace.at(-1)
    expect(last.type).toBe('agent_end')
    expect(last.messages.at(-1).stopReason).toBe('error')
  })

  it('录制之外的请求被报告', async () => {
    const truncated = { ...cassette, interactions: cassette.interactions.slice(0, 1) }
    const result = await replay(scenario, truncated)
    expect(result.mismatches.map((m) => m.fields)).toEqual([['unexpected request']])
  })
})

describe('录制文件', () => {
  // 黄金文件缺失时，CI 中（环境变量 CI）toMatchFileSnapshot 直接失败，本地则会新建
  it('每个场景都有录制', () => {
    for (const { name } of SCENARIOS) expect(existsSync(cassetteFile(name)), name).toBe(true)
  })

  it('不含凭据', () => {
    for (const cassette of CASSETTES) {
      const text = readFileSync(cassetteFile(cassette.name), 'utf8')
      expect(text, cassette.name).not.toContain(PLACEHOLDER_KEY)
      for (const interaction of cassette.interactions) {
        const headers = Object.keys(interaction.request.headers)
        expect(headers).not.toContain('authorization')
        expect(headers).not.toContain('x-api-key')
        expect(headers).not.toContain('x-goog-api-key')
        expect(Object.values(interaction.request.query)).not.toContain(PLACEHOLDER_KEY)
      }
    }
  })
})
