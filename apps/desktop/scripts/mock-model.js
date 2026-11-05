// @ts-check
/**
 * 冒烟测试与端到端测试用的 OpenAI Chat Completions 兼容端点（M1-01d、M1-04b）：只监听 127.0.0.1，
 * 校验 Key（给出 `apiKey` 时）后以 SSE 流式回复固定文本，并记录每次请求的 Key、模型、是否流式与消息。
 *
 * 给出 `toolCall` 时（M1-11b），第一次请求改为调用这个工具，之后的请求回复固定文本。
 */
import { createServer } from 'node:http'

/**
 * @typedef {{ authorization: string | undefined, model: unknown, stream: unknown, messages: unknown }} MockModelRequest
 * @param {{ apiKey?: string, reply: string, toolCall?: { name: string, arguments: object } }} options
 * @returns {Promise<{ baseUrl: string, requests: MockModelRequest[], close: () => Promise<void> }>}
 */
export async function startMockModel({ apiKey, reply, toolCall }) {
  /** @type {MockModelRequest[]} */
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      requests.push({
        authorization: req.headers.authorization,
        model: body.model,
        stream: body.stream,
        messages: body.messages,
      })
      if (apiKey !== undefined && req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      /** @param {Record<string, unknown>} delta @param {string | null} finish */
      const chunk = (delta, finish = null) => ({
        id: 'smoke',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (toolCall && requests.length === 1) {
        const call = {
          index: 0,
          id: 'call_mock_1',
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [call] }))}\n\n`)
        const end = {
          ...chunk({}, 'tool_calls'),
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }
        res.write(`data: ${JSON.stringify(end)}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      for (const piece of reply.split(' ')) {
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: `${piece} ` }))}\n\n`)
      }
      const done = {
        ...chunk({}, 'stop'),
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }
      res.write(`data: ${JSON.stringify(done)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve(undefined))
      }),
  }
}
