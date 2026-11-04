/**
 * 合成的上游模型服务（M1-02a，由 S8 移入）：按三种接口格式输出流式响应，作为 CI 中可重新录制的录制来源。
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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Format } from './scenarios.js'

interface ToolCallSpec {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

interface ReplySpec {
  readonly thinking?: string
  readonly text?: string
  readonly toolCalls?: readonly ToolCallSpec[]
  readonly usage: { readonly input: number; readonly output: number }
}

/** 错误响应，各格式的状态码与响应体按该服务的实际格式给出。 */
type ErrorSpec = { readonly error: Readonly<Record<Format, { status: number; body: unknown }>> }

const CALC_TOOL: readonly ReplySpec[] = [
  {
    thinking: 'The user wants 2 + 3. I should call the add tool.',
    text: 'Let me add those.',
    toolCalls: [{ id: 'call_add_1', name: 'add', args: { a: 2, b: 3 } }],
    usage: { input: 52, output: 31 },
  },
  { text: '2 + 3 = 5。结果是五。', usage: { input: 96, output: 12 } },
]

export const TURNS: Readonly<Record<string, readonly (ReplySpec | ErrorSpec)[]>> = {
  'calc-tool': CALC_TOOL,
  /** pi-ai 对 Gemini 3 起的模型会在下一次请求中带回（自己生成的）工具调用 id。 */
  'gemini-3-calc-tool': CALC_TOOL,
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
  'auth-fail': [
    {
      error: {
        openai: {
          status: 401,
          body: {
            error: {
              message: 'Incorrect API key provided.',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
        },
        anthropic: {
          status: 401,
          body: {
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          },
        },
        // Gemini 对无效的 Key 返回 400，原因在 details 中
        gemini: {
          status: 400,
          body: {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'API_KEY_INVALID',
                  domain: 'googleapis.com',
                },
              ],
            },
          },
        },
      },
    },
  ],
}

/** 把字符串切成固定长度的片段（按字符，不切开多字节字符），模拟逐 token 到达。 */
function pieces(text: string, size = 6): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) ?? []
}

function encodeOpenAI(reply: ReplySpec, model: string): string[] {
  const base = {
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    created: 1767225600,
    model,
  }
  const chunk = (delta: object, finish: string | null = null) =>
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

function encodeAnthropic(reply: ReplySpec, model: string): string[] {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
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

function encodeGemini(reply: ReplySpec, model: string): string[] {
  const chunk = (parts: object[]) =>
    `data: ${JSON.stringify({
      candidates: [{ content: { parts, role: 'model' }, index: 0 }],
      modelVersion: model,
      responseId: 'resp-mock-1',
    })}\r\n\r\n`
  const events: string[] = []
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

const ENCODERS: Readonly<Record<Format, (reply: ReplySpec, model: string) => string[]>> = {
  openai: encodeOpenAI,
  anthropic: encodeAnthropic,
  gemini: encodeGemini,
}

/** 不规则分块：按 7、13、29 字节循环切开，不考虑事件边界。 */
function irregularChunks(text: string): string[] {
  const sizes = [7, 13, 29] as const
  const chunks: string[] = []
  for (let i = 0, n = 0; i < text.length; n++) {
    const size = sizes[n % sizes.length]!
    chunks.push(text.slice(i, i + size))
    i += size
  }
  return chunks
}

interface Target {
  readonly format: Format
  readonly model: string
  readonly turn: number
}

type Body = {
  readonly model?: string
  readonly messages?: readonly { readonly role: string }[]
  readonly contents?: readonly { readonly role: string }[]
}

function classify(path: string, body: Body): Target | undefined {
  const assistantTurns = (list: readonly { readonly role: string }[] | undefined, role: string) =>
    (list ?? []).filter((m) => m.role === role).length
  if (path === '/v1/chat/completions') {
    return {
      format: 'openai',
      model: body.model ?? '',
      turn: assistantTurns(body.messages, 'assistant'),
    }
  }
  if (path === '/v1/messages') {
    return {
      format: 'anthropic',
      model: body.model ?? '',
      turn: assistantTurns(body.messages, 'assistant'),
    }
  }
  const gemini = /^\/v1beta\/models\/([^:]+):streamGenerateContent$/.exec(path)
  if (gemini?.[1]) {
    return { format: 'gemini', model: gemini[1], turn: assistantTurns(body.contents, 'model') }
  }
  return undefined
}

export interface UpstreamMock {
  readonly baseUrl: string
  close(): Promise<void>
}

export async function startUpstreamMock(): Promise<UpstreamMock> {
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const target = classify(url.pathname, raw === '' ? {} : (JSON.parse(raw) as Body))
      const reply = target && TURNS[target.model]?.[target.turn]
      if (!target || !reply) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `no scripted reply for ${req.url}` } }))
        return
      }
      if ('error' in reply) {
        const { status, body } = reply.error[target.format]
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of irregularChunks(ENCODERS[target.format](reply, target.model).join(''))) {
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
