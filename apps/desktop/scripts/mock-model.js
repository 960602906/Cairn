// @ts-check
/**
 * 冒烟测试与端到端测试用的 OpenAI Chat Completions 兼容端点（M1-01d、M1-04b）：只监听 127.0.0.1，
 * 校验 Key（给出 `apiKey` 时）后以 SSE 流式回复固定文本，并记录每次请求的 Key、模型、是否流式与消息。
 *
 * 给出 `toolCall` 时（M1-11b），第一次请求改为调用这个工具，之后的请求回复固定文本。给出 `toolCalls` 时
 * （M1-15a），第 n 次请求调用其中第 n 个工具，用完后回复固定文本。
 * 给出 `toolCallsByPrompt` 时（M3-14），按最后一条用户消息匹配脚本：消息包含某个键时使用对应的一组，
 * 组内按本轮已发生的工具调用次数推进，用完后回复固定文本。用于同一个会话里逐轮验证不同工具。
 * 给出 `replyByPrompt` 时（M7-07），同样按最后一条用户消息选回复文本（最长匹配优先）；用于让
 * 父运行、maker 与 checker 子运行各自拿到不同的回复，例如审查循环里 checker 的 JSON 判定。
 * 给出 `failByPrompt` 时（M7-08），命中的请求以 500 结束，用来验证流水线的失败传播。
 */
import { createServer } from 'node:http'

/**
 * @typedef {{ authorization: string | undefined, model: unknown, stream: unknown, messages: unknown }} MockModelRequest
 * @typedef {{ name: string, arguments: object }} MockToolCall
 * `title`（M3-01）：请求内容里带有自动标题的系统提示时，改回这段文字，用来区分对话回复。
 * `summary`（M3-03）：请求内容里带有压缩摘要的系统提示时，改回这段文字。
 * `brief`（M3-04）：请求内容里带有会话要点的系统提示时，改回这段文字。
 * `parallelToolCalls`（M4-05）：第一次对话请求同时返回多个工具调用，用于端到端验证并行委派。
 * @param {{ apiKey?: string, reply: string, toolCall?: MockToolCall, toolCalls?: readonly MockToolCall[], parallelToolCalls?: readonly MockToolCall[], toolCallsByPrompt?: Readonly<Record<string, readonly MockToolCall[]>>, replyByPrompt?: Readonly<Record<string, string>>, failByPrompt?: Readonly<Record<string, boolean>>, title?: string, summary?: string, brief?: string }} options
 * @returns {Promise<{ baseUrl: string, requests: MockModelRequest[], close: () => Promise<void> }>}
 */
export async function startMockModel({
  apiKey,
  reply,
  toolCall,
  toolCalls,
  parallelToolCalls,
  toolCallsByPrompt,
  replyByPrompt,
  failByPrompt,
  title,
  summary,
  brief,
}) {
  const script = toolCalls ?? (toolCall ? [toolCall] : [])
  /**
   * 按最后一条用户消息选脚本，再按本轮已发生的工具调用次数推进。
   * @param {readonly { role?: string, content?: unknown, tool_calls?: readonly unknown[] }[]} messages
   */
  const promptStep = (messages) => {
    let lastUser = -1
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.role === 'user') lastUser = i
    }
    if (lastUser < 0) return undefined
    const content = messages[lastUser]?.content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    // 批准计划后的消息会带上整份计划，可能同时命中多个键；取最长（最具体）的那个。
    const key = Object.keys(toolCallsByPrompt ?? {})
      .filter((candidate) => text.includes(candidate))
      .sort((a, b) => b.length - a.length)[0]
    if (key === undefined) return undefined
    const used = messages
      .slice(lastUser + 1)
      .filter(
        (message) =>
          message?.role === 'assistant' &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0,
      ).length
    return toolCallsByPrompt?.[key]?.[used]
  }
  /**
   * 按最后一条用户消息选回复文本（M7-07）；最长的键优先，和工具脚本的匹配规则一致。
   * @param {readonly { role?: string, content?: unknown }[]} messages
   */
  const promptReply = (messages) => {
    let lastUser = -1
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.role === 'user') lastUser = i
    }
    if (lastUser < 0) return undefined
    const content = messages[lastUser]?.content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    const key = Object.keys(replyByPrompt ?? {})
      .filter((candidate) => text.includes(candidate))
      .sort((a, b) => b.length - a.length)[0]
    return key === undefined ? undefined : replyByPrompt?.[key]
  }
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
      /** @param {Readonly<Record<string, unknown>> | undefined} map */
      const promptMatches = (map) => {
        const list = Array.isArray(body.messages) ? body.messages : []
        let lastUser = -1
        for (let i = 0; i < list.length; i += 1) {
          if (list[i]?.role === 'user') lastUser = i
        }
        if (lastUser < 0) return undefined
        const content = list[lastUser]?.content
        const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
        return Object.keys(map ?? {})
          .filter((candidate) => text.includes(candidate))
          .sort((a, b) => b.length - a.length)[0]
      }
      // 失败注入必须在写 SSE 头之前（M7-08）：之后写 500 会破坏连接。
      if (failByPrompt !== undefined) {
        const failKey = promptMatches(failByPrompt)
        if (failKey !== undefined && failByPrompt[failKey]) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `mock failure: ${failKey}` } }))
          return
        }
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
      const messages = JSON.stringify(body.messages ?? '')
      const auxiliary = messages.includes('You name a conversation.')
        ? (title ?? reply)
        : messages.includes('You keep a session brief.')
          ? (brief ?? reply)
          : messages.includes('You summarize an earlier part of a coding session')
            ? (summary ?? reply)
            : undefined
      // 标题、要点、摘要不是对话，不能占掉工具脚本的位置（M3-05）
      if (auxiliary !== undefined) {
        for (const piece of auxiliary.split(' ')) {
          res.write(
            `data: ${JSON.stringify(chunk({ role: 'assistant', content: `${piece} ` }))}\n\n`,
          )
        }
        const done = {
          ...chunk({}, 'stop'),
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }
        res.write(`data: ${JSON.stringify(done)}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const chatIndex =
        requests.filter((request) => {
          const text = JSON.stringify(request.messages ?? '')
          return (
            !text.includes('You name a conversation.') &&
            !text.includes('You keep a session brief.') &&
            !text.includes('You summarize an earlier part of a coding session')
          )
        }).length - 1
      if (parallelToolCalls && chatIndex === 0) {
        const calls = parallelToolCalls.map((item, index) => ({
          index,
          id: `call_mock_${requests.length}_${index}`,
          type: 'function',
          function: { name: item.name, arguments: JSON.stringify(item.arguments) },
        }))
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: calls }))}\n\n`)
        const end = {
          ...chunk({}, 'tool_calls'),
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }
        res.write(`data: ${JSON.stringify(end)}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const step = toolCallsByPrompt
        ? promptStep(Array.isArray(body.messages) ? body.messages : [])
        : script[chatIndex]
      if (step) {
        const call = {
          index: 0,
          id: `call_mock_${requests.length}`,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments) },
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
      const text = promptReply(Array.isArray(body.messages) ? body.messages : []) ?? reply
      for (const piece of text.split(' ')) {
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
