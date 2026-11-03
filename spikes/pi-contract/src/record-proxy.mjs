// @ts-check
/**
 * 录制代理：pi 的 `baseUrl` 指向这里，请求原样转发到上游（合成上游或真实服务），
 * 响应边转发边记录分块。凭据只经过、不记录（见 `cassette.mjs`）。
 */
import http from 'node:http'
import { recordRequest } from './cassette.mjs'

/** 转发时不带的请求头（由 fetch 重新计算，或要求上游不压缩以便记录原文）。 */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

/**
 * @param {{ upstream: string }} options 上游根地址，如 `https://api.deepseek.com`
 */
export async function startRecordingProxy({ upstream }) {
  /** @type {import('./cassette.mjs').Interaction[]} */
  const interactions = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      const request = recordRequest(req, raw)
      /** @type {Record<string, string>} */
      const headers = { 'accept-encoding': 'identity' }
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && typeof value === 'string') headers[name] = value
      }
      /** @type {import('./cassette.mjs').RecordedResponse} */
      const response = { status: 0, headers: {}, chunks: [] }
      interactions.push({ request, response })
      try {
        const upstreamRes = await fetch(new URL(req.url ?? '/', upstream), {
          method: req.method,
          headers,
          body: raw || undefined,
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
          if (rest) response.chunks.push(rest)
        }
        res.end()
      } catch (e) {
        response.status = 502
        response.chunks = [JSON.stringify({ error: { message: String(e) } })]
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(response.chunks[0])
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    interactions,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
