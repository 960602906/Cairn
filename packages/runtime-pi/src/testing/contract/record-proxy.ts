/**
 * 录制代理（M1-02a，由 S8 移入）：模型的 `baseUrl` 指向这里，请求原样转发到上游（合成上游或真实服务），
 * 响应边转发边记录分块。凭据只经过、不记录（见 `cassette.ts`）。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { recordRequest, type Interaction, type RecordedResponse } from './cassette.js'

/** 转发时不带的请求头（由 fetch 重新计算，或要求上游不压缩以便记录原文）。 */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

export interface RecordingProxy {
  readonly baseUrl: string
  readonly interactions: Interaction[]
  close(): Promise<void>
}

/**
 * @param upstream 上游地址，如 `https://api.deepseek.com`；可带路径前缀，如 `https://api.deepseek.com/anthropic`
 */
export async function startRecordingProxy(upstream: string): Promise<RecordingProxy> {
  const interactions: Interaction[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
    req.on('end', async () => {
      const request = recordRequest(req, raw)
      const headers: Record<string, string> = { 'accept-encoding': 'identity' }
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && typeof value === 'string') headers[name] = value
      }
      const response: RecordedResponse = { status: 0, headers: {}, chunks: [] }
      interactions.push({ request, response })
      try {
        // 保留上游地址自带的路径前缀：new URL('/v1/messages', upstream) 会丢掉它
        const target = upstream.replace(/\/+$/, '') + (req.url ?? '/')
        const upstreamRes = await fetch(target, {
          method: req.method ?? 'GET',
          headers,
          ...(raw === '' ? {} : { body: raw }),
        })
        response.status = upstreamRes.status
        const contentType = upstreamRes.headers.get('content-type')
        if (contentType) response.headers['content-type'] = contentType
        res.writeHead(upstreamRes.status, response.headers)
        if (upstreamRes.body) {
          const decoder = new TextDecoder()
          for await (const bytes of upstreamRes.body) {
            const text = decoder.decode(bytes, { stream: true })
            if (text) response.chunks.push(text)
            res.write(bytes)
          }
          const rest = decoder.decode()
          /* v8 ignore next -- 只在响应以不完整的多字节字符结尾时出现 */
          if (rest) response.chunks.push(rest)
        }
        res.end()
      } catch (e) {
        response.status = 502
        response.headers = { 'content-type': 'application/json' }
        response.chunks = [JSON.stringify({ error: { message: String(e) } })]
        /* v8 ignore next -- 上游在发出响应头后断开时才会已发送 */
        if (!res.headersSent) res.writeHead(502, response.headers)
        res.end(response.chunks[0])
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    interactions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
