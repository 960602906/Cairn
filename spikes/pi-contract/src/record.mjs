// @ts-check
/**
 * 录制：pi → 录制代理 → 上游，写出 `cassettes/<名称>.json`；随后回放一次，确认回放得到的
 * 事件轨迹与录制时（直连上游）完全一致。黄金文件由测试生成与比对（`npm run test:update`）。
 *
 * 用法：
 *   node src/record.mjs                                    # 用合成上游录制全部场景
 *   node src/record.mjs --only=openai-tool                 # 只录制一个场景
 *   node src/record.mjs --only=openai-tool --upstream=https://api.deepseek.com \
 *     --model=deepseek-chat --api-key-env=DEEPSEEK_API_KEY --name=deepseek-tool   # 真实服务
 */
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  CASSETTE_VERSION,
  PLACEHOLDER_KEY,
  installedPiVersions,
  saveCassette,
} from './cassette.mjs'
import { startRecordingProxy } from './record-proxy.mjs'
import { startReplayServer } from './replay-server.mjs'
import { SCENARIOS, runScenario } from './scenarios.mjs'
import { normalizeEvents } from './trace.mjs'
import { startUpstreamMock } from './upstream-mock.mjs'

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match?.[1]) args[match[1]] = match[2] ?? ''
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const real = Boolean(args['upstream'])
if (real && !(args['only'] && args['model'] && args['api-key-env'])) {
  console.error('--upstream requires --only, --model and --api-key-env')
  process.exit(2)
}
const apiKey = real ? process.env[args['api-key-env'] ?? ''] : PLACEHOLDER_KEY
if (!apiKey) {
  console.error(`environment variable ${args['api-key-env']} is empty`)
  process.exit(2)
}

const selected = SCENARIOS.filter((s) => !args['only'] || s.name === args['only'])
if (selected.length === 0) {
  console.error(`unknown scenario ${args['only']}`)
  process.exit(2)
}

const mock = real ? null : await startUpstreamMock()
const upstream = args['upstream'] ?? mock?.baseUrl ?? ''
const dir = path.resolve(import.meta.dirname, '../cassettes')
let failed = false

for (const base of selected) {
  const scenario = args['model'] ? { ...base, model: args['model'] } : base
  const name = args['name'] ?? scenario.name
  const proxy = await startRecordingProxy({ upstream })
  const live = await runScenario(scenario, { baseUrl: proxy.baseUrl, apiKey })
  await proxy.close()
  /** @type {import('./cassette.mjs').Cassette} */
  const cassette = {
    version: CASSETTE_VERSION,
    name,
    scenario: base.name,
    model: scenario.model,
    source: real ? upstream : 'synthetic',
    pi: installedPiVersions(),
    interactions: proxy.interactions,
  }
  saveCassette(path.join(dir, `${name}.json`), cassette)

  const replay = await startReplayServer(cassette)
  const replayed = await runScenario(scenario, { baseUrl: replay.baseUrl, apiKey })
  await replay.close()
  const same = isDeepStrictEqual(normalizeEvents(live.events), normalizeEvents(replayed.events))
  const ok = same && replay.mismatches.length === 0 && replay.remaining() === 0
  if (!ok) failed = true
  console.log(
    `${ok ? 'OK  ' : 'DIFF'}  ${name}  ${cassette.interactions.length} request(s), ${live.events.length} events`,
  )
  if (replay.mismatches.length > 0) console.log(JSON.stringify(replay.mismatches, null, 2))
}

await mock?.close()
process.exit(failed ? 1 : 0)
