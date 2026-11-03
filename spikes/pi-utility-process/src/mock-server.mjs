// @ts-check
/**
 * 本地 mock 的 OpenAI 兼容端点（Chat Completions，流式 SSE）。按请求体中的 `model` 选择剧本：
 *
 * - `tool-model`：第一次请求先流式输出推理内容（`reasoning_content`，DeepSeek 风格）与一句话，再分片返回
 *   一次 `add` 工具调用；带工具结果的第二次请求返回最终回复。
 * - `slow-model`：慢速流式输出长文本（每 40 ms 一段），用于测试中止时连接是否被关闭。
 * - `auth-fail-model`：返回 401，用于测试错误路径。
 *
 * 所有请求都记录下来（方法、路径、鉴权头、消息角色、工具结果、连接是否在响应完成前关闭）。
 */
import http from 'node:http'

export const API_KEY = 'sk-spike-0123456789'
export const TOOL_REPLY = '2 + 3 = 5'
export const REASONING = 'The user wants a sum, so I should call the add tool.'

/** @param {unknown} delta @param {string | null} [finish] */
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-spike',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const usage = (prompt, completion) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-spike',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  })}\n\n`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {string | undefined} authorization
 * @property {string} model
 * @property {string[]} roles
 * @property {{ toolCallId: string, content: unknown }[]} toolResults
 * @property {boolean} stream
 * @property {boolean} closedEarly 响应完成前客户端关闭了连接
 */

/** 启动 mock 端点，监听 127.0.0.1 的随机端口。 */
export async function startMockServer() {
  /** @type {RecordedRequest[]} */
  const requests = []

  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    /** @type {any} */
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      // 记录为无效请求
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    /** @type {RecordedRequest} */
    const record = {
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      model: String(body.model ?? ''),
      roles: messages.map((m) => String(m.role)),
      toolResults: messages
        .filter((m) => m.role === 'tool')
        .map((m) => ({ toolCallId: String(m.tool_call_id), content: m.content })),
      stream: body.stream === true,
      closedEarly: false,
    }
    requests.push(record)
    let finished = false
    res.on('close', () => {
      if (!finished) record.closedEarly = true
    })

    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      finished = true
      return
    }
    if (record.authorization !== `Bearer ${API_KEY}` || record.model === 'auth-fail-model') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }),
      )
      finished = true
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const write = (text) => {
      if (!res.destroyed) res.write(text)
    }

    if (record.model === 'tool-model') {
      write(chunk({ role: 'assistant', content: '' }))
      if (record.toolResults.length === 0) {
        for (const piece of REASONING.match(/.{1,12}/g) ?? []) {
          write(chunk({ reasoning_content: piece }))
          await sleep(5)
        }
        write(chunk({ content: 'Let me calculate.' }))
        write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_add_1',
                type: 'function',
                function: { name: 'add', arguments: '' },
              },
            ],
          }),
        )
        for (const piece of ['{"a":', ' 2, "b"', ': 3}']) {
          write(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
          await sleep(5)
        }
        write(chunk({}, 'tool_calls'))
        write(usage(40, 12))
      } else {
        for (const piece of TOOL_REPLY.split(/(?<= )/)) {
          write(chunk({ content: piece }))
          await sleep(5)
        }
        write(chunk({}, 'stop'))
        write(usage(60, 6))
      }
    } else if (record.model === 'slow-model') {
      write(chunk({ role: 'assistant', content: '' }))
      for (let i = 0; i < 100 && !res.destroyed; i++) {
        write(chunk({ content: `part ${i}. ` }))
        await sleep(40)
      }
      write(chunk({}, 'stop'))
    } else {
      write(chunk({ role: 'assistant', content: '' }))
      write(chunk({ content: 'unknown model' }))
      write(chunk({}, 'stop'))
    }
    write('data: [DONE]\n\n')
    finished = true
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
