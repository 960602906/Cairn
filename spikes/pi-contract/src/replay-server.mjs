// @ts-check
/**
 * 回放服务：按录制顺序逐个响应请求。每个请求与录制的请求比对（方法、路径、查询参数、
 * 录制的请求头、JSON 请求体，均经 `recordRequest` 同样规范化），不一致时返回 500 并记入
 * `mismatches`，测试据此失败；这能发现 pi 升级后请求格式的变化。
 *
 * 响应分块方式（`chunking`）：
 * - `recorded`：按录制时的分块；
 * - `whole`：整个响应一次写出；
 * - `{ bytes: n }`：按 n 字节切分（会切开多字节字符）；
 * - `{ seed: n }`：1～64 字节的随机长度，同一 seed 结果相同。
 */
import http from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { recordRequest } from './cassette.mjs'

/** @typedef {'recorded' | 'whole' | { bytes: number } | { seed: number }} Chunking */

/** mulberry32：可复现的伪随机数。 */
function random(/** @type {number} */ seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @param {string[]} chunks 录制的分块
 * @param {Chunking} chunking
 * @returns {(string | Buffer)[]}
 */
export function rechunk(chunks, chunking) {
  if (chunking === 'recorded') return chunks
  const all = Buffer.from(chunks.join(''), 'utf8')
  if (chunking === 'whole') return [all]
  const next =
    'bytes' in chunking
      ? () => chunking.bytes
      : (
          (rand) => () =>
            1 + Math.floor(rand() * 64)
        )(random(chunking.seed))
  /** @type {Buffer[]} */
  const out = []
  for (let i = 0; i < all.length;) {
    const size = next()
    out.push(all.subarray(i, i + size))
    i += size
  }
  return out
}

/**
 * @param {import('./cassette.mjs').RecordedRequest} expected
 * @param {import('./cassette.mjs').RecordedRequest} actual
 * @returns {string[]} 不一致的字段
 */
function diffRequest(expected, actual) {
  /** @type {(keyof import('./cassette.mjs').RecordedRequest)[]} */
  const fields = ['method', 'path', 'query', 'headers', 'body']
  return fields.filter((field) => !isDeepStrictEqual(expected[field], actual[field]))
}

/**
 * @param {import('./cassette.mjs').Cassette} cassette
 * @param {{ chunking?: Chunking }} [options]
 */
export async function startReplayServer(cassette, { chunking = 'recorded' } = {}) {
  /** @type {{ index: number, fields: string[], expected: unknown, actual: unknown }[]} */
  const mismatches = []
  let cursor = 0
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      const actual = recordRequest(req, raw)
      const index = cursor++
      const interaction = cassette.interactions[index]
      const fields = interaction ? diffRequest(interaction.request, actual) : ['unexpected request']
      if (!interaction || fields.length > 0) {
        mismatches.push({ index, fields, expected: interaction?.request ?? null, actual })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `cassette mismatch: ${fields.join(', ')}` } }))
        return
      }
      const { response } = interaction
      res.writeHead(response.status, response.headers)
      for (const chunk of rechunk(response.chunks, chunking)) {
        if (res.destroyed) return
        res.write(chunk)
        await new Promise((resolve) => setImmediate(resolve))
      }
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mismatches,
    /** 尚未被请求的录制交互数。 */
    remaining: () => Math.max(0, cassette.interactions.length - cursor),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve(undefined))
      }),
  }
}
