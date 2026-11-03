// @ts-check
/**
 * 合成的上游模型服务，按三种接口格式输出流式响应（容器中没有真实 API Key 时用作录制来源）。
 *
 * 每个模型有一组按轮次编排的回复（`TURNS`），轮次 = 请求中已有的助手消息数。回复与格式无关，
 * 由各格式的编码器转成该格式的 SSE 事件；写出时故意把事件切成不规则的分块（行中间断开），
 * 模拟真实网络上的到达方式。
 *
 * - OpenAI Chat Completions：`POST /v1/chat/completions`，`reasoning_content` 表示思考，工具参数分段到达；
 * - Anthropic Messages：`POST /v1/messages`，thinking / text / tool_use 内容块与 `signature_delta`；
 * - Gemini：`POST /v1beta/models/<model>:streamGenerateContent?alt=sse`，`thought: true` 表示思考，
 *   `functionCall` 不带 id（与 Gemini 2.x 一致）。
 */
import http from 'node:http'

/**
 * @typedef {object} ToolCallSpec
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} args
 *
 * @typedef {object} ReplySpec
 * @property {string} [thinking]
 * @property {string} [text]
 * @property {ToolCallSpec[]} [toolCalls]
 * @property {{ input: number, output: number }} usage
 *
 * @typedef {{ status: number, body: unknown }} ErrorSpec
 */

/** @type {Record<string, (ReplySpec | ErrorSpec)[]>} */
export const TURNS = {
  'calc-tool': [
    {
      thinking: 'The user wants 2 + 3. I should call the add tool.',
      text: 'Let me add those.',
      toolCalls: [{ id: 'call_add_1', name: 'add', args: { a: 2, b: 3 } }],
      usage: { input: 52, output: 31 },
    },
    { text: '2 + 3 = 5。结果是五。', usage: { input: 96, output: 12 } },
  ],
  'calc-parallel': [
    {
      toolCalls: [
        { id: 'call_add_1', name: 'add', args: { a: 2, b: 3 } },
        { id: 'call_add_2', name: 'add', args: { a: 10, b: 20 } },
      ],
      usage: { input: 60, output: 40 },
    },
    { text: 'The results are 5 and 30.', usage: { input: 120, output: 9 } },
  ],
  /** pi-ai 对 Gemini 3 起的模型会在下一次请求的 `functionResponse` 中带回工具调用 id。 */
  get 'gemini-3-calc-tool'() {
    return this['calc-tool']
  },
  'auth-fail': [
    {
      status: 401,
      body: { error: { message: 'Invalid API key', type: 'invalid_request_error' } },
    },
  ],
}

/** 把字符串切成固定长度的片段，模拟逐 token 到达。 */
const pieces = (/** @type {string} */ text, size = 6) => {
  const out = []
  for (const ch of text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) ?? []) out.push(ch)
  return out
}

/** @param {ReplySpec} reply @param {string} model @returns {string[]} SSE 事件文本 */
function encodeOpenAI(reply, model) {
  const base = {
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    created: 1767225600,
    model,
  }
  /** @param {object} delta @param {string | null} finish */
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const events = [chunk({ role: 'assistant', content: '' })]
  for (const p of pieces(reply.thinking ?? '')) events.push(chunk({ reasoning_content: p }))
  for (const p of pieces(reply.text ?? '')) events.push(chunk({ content: p }))
  ;(reply.toolCalls ?? []).forEach((call, index) => {
    events.push(
      chunk({
        tool_calls: [
          { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
        ],
      }),
    )
    for (const p of pieces(JSON.stringify(call.args), 5)) {
      events.push(chunk({ tool_calls: [{ index, function: { arguments: p } }] }))
    }
  })
  events.push(chunk({}, reply.toolCalls?.length ? 'tool_calls' : 'stop'))
  events.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: reply.usage.input,
        completion_tokens: reply.usage.output,
        total_tokens: reply.usage.input + reply.usage.output,
      },
    })}\n\n`,
  )
  events.push('data: [DONE]\n\n')
  return events
}

/** @param {ReplySpec} reply @param {string} model @returns {string[]} */
function encodeAnthropic(reply, model) {
  /** @param {string} type @param {object} data */
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const events = [
    event('message_start', {
      message: {
        id: 'msg_mock_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: reply.usage.input, output_tokens: 1 },
      },
    }),
  ]
  let index = 0
  if (reply.thinking) {
    events.push(
      event('content_block_start', {
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
    )
    for (const p of pieces(reply.thinking)) {
      events.push(
        event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: p } }),
      )
    }
    events.push(
      event('content_block_delta', {
        index,
        delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJlLW1vY2s=' },
      }),
    )
    events.push(event('content_block_stop', { index }))
    index++
  }
  if (reply.text) {
    events.push(event('content_block_start', { index, content_block: { type: 'text', text: '' } }))
    for (const p of pieces(reply.text)) {
      events.push(event('content_block_delta', { index, delta: { type: 'text_delta', text: p } }))
    }
    events.push(event('content_block_stop', { index }))
    index++
  }
  for (const call of reply.toolCalls ?? []) {
    events.push(
      event('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      }),
    )
    for (const p of pieces(JSON.stringify(call.args), 5)) {
      events.push(
        event('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: p },
        }),
      )
    }
    events.push(event('content_block_stop', { index }))
    index++
  }
  events.push(
    event('message_delta', {
      delta: {
        stop_reason: reply.toolCalls?.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: reply.usage.output },
    }),
  )
  events.push(event('message_stop', {}))
  return events
}

/** @param {ReplySpec} reply @param {string} model @returns {string[]} */
function encodeGemini(reply, model) {
  /** @param {object[]} parts @param {object} [extra] */
  const chunk = (parts, extra = {}) =>
    `data: ${JSON.stringify({
      candidates: [{ content: { parts, role: 'model' }, index: 0, ...extra }],
      modelVersion: model,
      responseId: 'resp-mock-1',
    })}\r\n\r\n`
  const events = []
  for (const p of pieces(reply.thinking ?? '', 12)) events.push(chunk([{ text: p, thought: true }]))
  for (const p of pieces(reply.text ?? '', 12)) events.push(chunk([{ text: p }]))
  const calls = (reply.toolCalls ?? []).map((call) => ({
    functionCall: { name: call.name, args: call.args },
  }))
  events.push(
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: calls, role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: reply.usage.input,
        candidatesTokenCount: reply.usage.output,
        totalTokenCount: reply.usage.input + reply.usage.output,
      },
      modelVersion: model,
      responseId: 'resp-mock-1',
    })}\r\n\r\n`,
  )
  return events
}

/** 不规则分块：按 7、13、29 字节循环切开，不考虑事件边界。 */
function irregularChunks(/** @type {string} */ text) {
  const sizes = [7, 13, 29]
  const chunks = []
  let i = 0
  for (let n = 0; i < text.length; n++) {
    const size = sizes[n % sizes.length] ?? 7
    chunks.push(text.slice(i, i + size))
    i += size
  }
  return chunks
}

/**
 * @param {string} path
 * @param {any} body
 * @returns {{ format: 'openai' | 'anthropic' | 'gemini', model: string, turn: number } | null}
 */
function classify(path, body) {
  if (path === '/v1/chat/completions') {
    const turn = body.messages.filter((/** @type {any} */ m) => m.role === 'assistant').length
    return { format: 'openai', model: body.model, turn }
  }
  if (path === '/v1/messages') {
    const turn = body.messages.filter((/** @type {any} */ m) => m.role === 'assistant').length
    return { format: 'anthropic', model: body.model, turn }
  }
  const gemini = /^\/v1beta\/models\/([^:]+):streamGenerateContent$/.exec(path)
  if (gemini?.[1]) {
    const turn = body.contents.filter((/** @type {any} */ c) => c.role === 'model').length
    return { format: 'gemini', model: gemini[1], turn }
  }
  return null
}

const ENCODERS = { openai: encodeOpenAI, anthropic: encodeAnthropic, gemini: encodeGemini }

/** 启动合成上游，返回 `{ baseUrl, close }`。 */
export async function startUpstreamMock() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const target = classify(url.pathname, raw ? JSON.parse(raw) : {})
      const reply = target && TURNS[target.model]?.[target.turn]
      if (!target || !reply) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `no scripted reply for ${req.url}` } }))
        return
      }
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const text = ENCODERS[target.format](reply, target.model).join('')
      for (const chunk of irregularChunks(text)) {
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
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
