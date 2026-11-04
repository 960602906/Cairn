/**
 * 回放服务（M1-02a，由 S8 移入）：按录制顺序逐个响应请求。每个请求与录制的请求比对（方法、路径、
 * 查询参数、录制的请求头、JSON 请求体，均经 `recordRequest` 同样规范化），不一致时返回 500 并记入
 * `mismatches`，测试据此失败；这能发现 pi 升级后请求格式的变化。
 *
 * 响应分块方式（`Chunking`）：
 * - `recorded`：按录制时的分块；
 * - `whole`：整个响应一次写出；
 * - `{ bytes: n }`：按 n 字节切分（会切开多字节字符）；
 * - `{ seed: n }`：1～64 字节的随机长度，同一 seed 结果相同。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { recordRequest, type Cassette, type RecordedRequest } from './cassette.js'

export type Chunking = 'recorded' | 'whole' | { readonly bytes: number } | { readonly seed: number }

export interface Mismatch {
  readonly index: number
  readonly fields: readonly string[]
  readonly expected: RecordedRequest | null
  readonly actual: RecordedRequest
}

export interface ReplayServer {
  readonly baseUrl: string
  readonly mismatches: Mismatch[]
  /** 尚未被请求的录制交互数。 */
  remaining(): number
  close(): Promise<void>
}

/** mulberry32：可复现的伪随机数。 */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function rechunk(
  chunks: readonly string[],
  chunking: Chunking,
): readonly (string | Buffer)[] {
  if (chunking === 'recorded') return chunks
  const all = Buffer.from(chunks.join(''), 'utf8')
  if (chunking === 'whole') return [all]
  let next: () => number
  if ('bytes' in chunking) {
    next = () => chunking.bytes
  } else {
    const rand = random(chunking.seed)
    next = () => 1 + Math.floor(rand() * 64)
  }
  const out: Buffer[] = []
  for (let i = 0; i < all.length;) {
    const size = next()
    out.push(all.subarray(i, i + size))
    i += size
  }
  return out
}

const FIELDS = ['method', 'path', 'query', 'headers', 'body'] as const

function diffRequest(expected: RecordedRequest, actual: RecordedRequest): string[] {
  return FIELDS.filter((field) => !isDeepStrictEqual(expected[field], actual[field]))
}

export async function startReplayServer(
  cassette: Cassette,
  { chunking = 'recorded' }: { readonly chunking?: Chunking } = {},
): Promise<ReplayServer> {
  const mismatches: Mismatch[] = []
  let cursor = 0
  const server = createServer((req, res) => {
    res.on('error', () => {})
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    mismatches,
    remaining: () => Math.max(0, cassette.interactions.length - cursor),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
