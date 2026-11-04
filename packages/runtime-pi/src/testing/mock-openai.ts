/**
 * 测试用的 OpenAI Chat Completions 兼容端点（M1-01c）。
 *
 * 按顺序回放预设的响应：流式分块（SSE）、HTTP 错误，或一直不结束的流（测试中止）。
 * 记录每次请求的路径、请求头与请求体，供测试检查实际发出的内容（如 DeepSeek 的 `reasoning_content`）。
 * 只用于测试，不随应用分发。
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockResponse =
  | { readonly kind: 'stream'; readonly chunks: readonly unknown[] }
  | { readonly kind: 'error'; readonly status: number; readonly body: unknown }
  /** 先发出这些分块，然后既不结束也不再发送，直到客户端断开。 */
  | { readonly kind: 'hang'; readonly chunks: readonly unknown[] }

export interface RecordedRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

export interface MockOpenAI {
  /** 形如 `http://127.0.0.1:port/v1`。 */
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

export async function startMockOpenAI(responses: readonly MockResponse[]): Promise<MockOpenAI> {
  const queue = [...responses]
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        headers: req.headers,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      })
      const next = queue.shift()
      if (!next) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock: no more responses' } }))
        return
      }
      if (next.kind === 'error') {
        res.writeHead(next.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(next.body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of next.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (next.kind === 'stream') res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** 构造流式分块的辅助函数。 */
export const sse = {
  delta(delta: Record<string, unknown>, finishReason: string | null = null) {
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
  },
  reasoning(text: string) {
    return sse.delta({ role: 'assistant', reasoning_content: text })
  },
  text(text: string) {
    return sse.delta({ role: 'assistant', content: text })
  },
  toolCall(index: number, id: string, name: string, args: string) {
    return sse.delta({
      tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
    })
  },
  finish(reason: 'stop' | 'tool_calls' | 'length', usage = { prompt: 10, completion: 5 }) {
    return {
      ...sse.delta({}, reason),
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    }
  },
}
