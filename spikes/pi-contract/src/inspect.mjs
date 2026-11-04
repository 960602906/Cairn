// @ts-check
/**
 * 查看录制内容：回放目录中的每个录制，打印每轮助手回复的 stopReason、用量、文本（前 120 字）、
 * 思考内容长度与工具调用。用于检查真实服务录制的结果是否合理（例如是否真的调用了工具）。
 *
 * 用法：
 *   node src/inspect.mjs <目录> [文件名前缀]
 *   node src/inspect.mjs ../../.local/magpie magpie-
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadCassette } from './cassette.mjs'
import { startReplayServer } from './replay-server.mjs'
import { SCENARIOS, runScenario } from './scenarios.mjs'

const [dir, prefix = ''] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node src/inspect.mjs <dir> [prefix]')
  process.exit(2)
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
  .sort()

for (const file of files) {
  const cassette = loadCassette(path.join(dir, file))
  const base = SCENARIOS.find((s) => s.name === cassette.scenario)
  if (!base) {
    console.log(`== ${cassette.name}  未知场景 ${cassette.scenario}`)
    continue
  }
  const replay = await startReplayServer(cassette)
  const run = await runScenario(
    { ...base, model: cassette.model },
    { baseUrl: replay.baseUrl, apiKey: 'x' },
  )
  await replay.close()
  const status = cassette.interactions.map((i) => i.response.status).join(',')
  console.log(`== ${cassette.name}  source=${cassette.source}  status=${status}`)
  for (const event of run.events) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue
    const m = event.message
    const parts = (m.content ?? []).map((/** @type {any} */ p) =>
      p.type === 'text'
        ? `text:${JSON.stringify(p.text.slice(0, 120))}`
        : p.type === 'thinking'
          ? `thinking(${p.thinking.length} 字符)`
          : p.type === 'toolCall'
            ? `toolCall ${p.name}${JSON.stringify(p.arguments)}`
            : p.type,
    )
    const err = m.errorMessage ? ` err=${m.errorMessage}` : ''
    console.log(
      `  stop=${m.stopReason}${err} usage=${m.usage?.input}/${m.usage?.output} | ${parts.join(' | ')}`,
    )
  }
}
