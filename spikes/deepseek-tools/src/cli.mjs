// @ts-check
/**
 * S2 入口：
 *
 *   node src/cli.mjs [--targets=deepseek,gateway-openai,gateway-anthropic,gateway-gemini]
 *                    [--scenarios=chain,parallel] [--thinking=high,off] [--runs=10] [--out=results/result.json]
 *
 * 每个目标 × 思考等级 × 场景运行 `--runs` 次，结果写入 JSON（含每次运行的消息摘要，不含 Key）。
 * 判定：思考开启时 `chain` 10 次中成功 ≥ 9 次，且有思考内容、与正文分开。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { SCENARIOS, runOnce } from './scenarios.mjs'
import { TARGETS, apiKeyFor } from './targets.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const list = (/** @type {string | undefined} */ v) => v?.split(',').filter(Boolean)
const targets = TARGETS.filter((t) =>
  (list(args['targets']) ?? TARGETS.map((x) => x.id)).includes(t.id),
)
const scenarios = SCENARIOS.filter((s) =>
  (list(args['scenarios']) ?? SCENARIOS.map((x) => x.id)).includes(s.id),
)
const levels = /** @type {('high' | 'off')[]} */ (list(args['thinking']) ?? ['high', 'off'])
const runs = Number(args['runs'] ?? 10)
const out = path.resolve(args['out'] ?? 'results/result.json')

const piVersion = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../node_modules/@earendil-works/pi-ai/package.json'),
    'utf8',
  ),
).version

const result = {
  date: new Date().toISOString(),
  node: process.version,
  pi: piVersion,
  runs,
  targets: /** @type {unknown[]} */ ([]),
}

let failed = 0
for (const target of targets) {
  if (!apiKeyFor(target)) {
    console.log(`== ${target.id}：跳过（未设置 ${target.keyEnv}）`)
    continue
  }
  const model = target.model()
  console.log(`== ${target.id} ${model.baseUrl} ${model.id}`)
  /** @type {unknown[]} */
  const rows = []
  for (const thinking of levels) {
    for (const scenario of scenarios) {
      /** @type {any[]} */
      const attempts = []
      for (let i = 0; i < runs; i++) {
        try {
          attempts.push(await runOnce(target, scenario, thinking))
        } catch (e) {
          attempts.push({
            ok: false,
            detail: `异常：${/** @type {Error} */ (e).message}`,
            ms: 0,
            requests: 0,
            thinkingChars: 0,
          })
        }
        const a = attempts.at(-1)
        process.stdout.write(a.ok ? '.' : 'x')
      }
      const passed = attempts.filter((a) => a.ok).length
      const withThinking = attempts.filter((a) => a.thinkingChars > 0).length
      const required = thinking === 'high' && scenario.id === 'chain'
      const ok = !required || (passed >= Math.ceil(runs * 0.9) && withThinking > 0)
      if (!ok) failed++
      const median = (/** @type {number[]} */ xs) =>
        xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
      const row = {
        thinking,
        scenario: scenario.id,
        required,
        passed,
        runs,
        withThinking,
        medianMs: median(attempts.map((a) => a.ms)),
        medianRequests: median(attempts.map((a) => a.requests)),
        failures: attempts.filter((a) => !a.ok).map((a) => a.detail),
        details: attempts.filter((a) => a.ok).map((a) => a.detail),
        attempts,
      }
      rows.push(row)
      console.log(
        ` ${thinking.padEnd(4)} ${scenario.id.padEnd(8)} ${passed}/${runs} 有思考 ${withThinking}/${runs} 中位 ${row.medianMs} ms ${required ? (ok ? '✓' : '✗ 未达标') : ''}`,
      )
      for (const f of row.failures.slice(0, 3)) console.log(`     ✗ ${f}`)
    }
  }
  result.targets.push({
    id: target.id,
    title: target.title,
    baseUrl: model.baseUrl,
    model: model.id,
    rows,
  })
}

mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
console.log(failed ? `${failed} 项未达标` : '达标')
process.exit(failed ? 1 : 0)
