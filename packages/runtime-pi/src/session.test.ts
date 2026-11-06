import type {
  AbortSignalLike,
  ResolvedModel,
  RuntimeEvent,
  RuntimeHooks,
  RuntimeSession,
  RuntimeToolCall,
  RuntimeToolResult,
  RuntimeToolSpec,
  UserMessage,
} from '@nexus/core'
import type { CanonicalMessage } from '@nexus/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiErrorCode } from './errors.js'
import { PiRuntime } from './session.js'
import { sse, startMockOpenAI, type MockOpenAI, type MockResponse } from './testing/mock-openai.js'

const KEY = 'test-key-not-real'

let mock: MockOpenAI | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const model = (baseUrl: string, over: Partial<ResolvedModel['profile']> = {}): ResolvedModel => ({
  ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  providerKind: 'openai',
  baseUrl,
  apiKey: KEY,
  profile: {
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    ...over,
  },
})

const user = (text: string, ts = 1): UserMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ts,
})

const TOOLS = [
  {
    name: 'get_order',
    description: '按订单号查询订单',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    },
  },
]

interface Harness {
  session: RuntimeSession
  events: RuntimeEvent[]
  calls: RuntimeToolCall[]
  controller: AbortController
}

async function setup(
  responses: readonly MockResponse[],
  options: {
    hooks?: Partial<RuntimeHooks>
    history?: CanonicalMessage[]
    profile?: Partial<ResolvedModel['profile']>
    tools?: readonly RuntimeToolSpec[]
  } = {},
): Promise<Harness> {
  mock = await startMockOpenAI(responses)
  const calls: RuntimeToolCall[] = []
  const controller = new AbortController()
  const hooks: RuntimeHooks = {
    beforeToolCall: async (call) => {
      calls.push(call)
      return { action: 'allow' }
    },
    executeTool: async (): Promise<RuntimeToolResult> => ({
      status: 'ok',
      content: [{ type: 'text', text: '{"customer_id":"C-77"}' }],
    }),
    ...options.hooks,
  }
  const session = await new PiRuntime().createSession({
    model: model(mock.baseUrl, options.profile),
    systemPrompt: '你是客服助手。',
    tools: options.tools ?? TOOLS,
    history: options.history ?? [],
    signal: controller.signal,
    hooks,
  })
  const events: RuntimeEvent[] = []
  session.onEvent((e) => events.push(e))
  return { session, events, calls, controller }
}

const TOOL_TURN: MockResponse = {
  kind: 'stream',
  chunks: [
    sse.reasoning('先查订单。'),
    sse.toolCall(0, 'call_1', 'get_order', '{"order_id":'),
    sse.toolCall(0, '', '', '"A-1024"}'),
    sse.finish('tool_calls', { prompt: 50, completion: 12 }),
  ],
}
const ANSWER_TURN: MockResponse = {
  kind: 'stream',
  chunks: [
    sse.text('客户编号'),
    sse.text('是 C-77。'),
    sse.finish('stop', { prompt: 80, completion: 6 }),
  ],
}

const types = (events: RuntimeEvent[]) => events.map((e) => e.type)
type Sent = { role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown[] }
const sentMessages = (i: number) => mock!.requests[i]!.body['messages'] as Sent[]

describe('PiRuntime：带工具调用的对话（openai 格式 mock 端点）', () => {
  it('事件顺序、工具钩子、历史与请求内容', async () => {
    const h = await setup([TOOL_TURN, ANSWER_TURN])
    await h.session.prompt(user('订单 A-1024 的客户是谁？'))

    expect(types(h.events)).toEqual([
      'step.started',
      'reasoning.delta',
      'message.completed',
      'step.completed',
      'step.started',
      'text.delta',
      'text.delta',
      'message.completed',
      'step.completed',
      'loop.ended',
    ])
    expect(
      h.events
        .filter((e) => e.type === 'reasoning.delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('先查订单。')
    expect(h.events[0]).toEqual({ type: 'step.started', model: model('').ref })
    expect(h.events.find((e) => e.type === 'step.completed')).toEqual({
      type: 'step.completed',
      finishReason: 'tool_calls',
      usage: { inputTokens: 50, outputTokens: 12, reasoningTokens: 0 },
    })
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    expect(h.calls).toEqual([{ id: 'call_1', name: 'get_order', input: { order_id: 'A-1024' } }])

    const history = h.session.exportHistory()
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history[1]).toMatchObject({
      reasoning: { text: '先查订单。', blocks: [{ signature: 'reasoning_content' }] },
      toolCalls: [{ id: 'call_1', name: 'get_order', input: { order_id: 'A-1024' } }],
    })
    expect(history[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1', status: 'ok' })
    expect(history[3]).toMatchObject({ content: [{ type: 'text', text: '客户编号是 C-77。' }] })

    // 请求：Key 只出现在请求头；第二次请求带回上一步的 reasoning_content（S2）
    expect(mock!.requests).toHaveLength(2)
    expect(mock!.requests[0]!.path).toBe('/v1/chat/completions')
    expect(mock!.requests[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(mock!.requests[0]!.body['tools']).toMatchObject([{ function: { name: 'get_order' } }])
    expect(sentMessages(0)[0]).toMatchObject({ content: expect.stringContaining('你是客服助手。') })
    const assistant = sentMessages(1).find((m) => m.role === 'assistant')
    expect(assistant).toMatchObject({ reasoning_content: '先查订单。' })
    expect(sentMessages(1).find((m) => m.role === 'tool')).toMatchObject({
      content: '{"customer_id":"C-77"}',
    })
  })

  it('beforeToolCall 拒绝：不执行工具，结果为 denied，原因发给模型', async () => {
    const executeTool = vi.fn()
    const h = await setup([TOOL_TURN, ANSWER_TURN], {
      hooks: {
        beforeToolCall: async () => ({ action: 'deny', reason: 'The user denied this tool call.' }),
        executeTool,
      },
    })
    await h.session.prompt(user('查订单'))
    expect(executeTool).not.toHaveBeenCalled()
    expect(h.session.exportHistory()[2]).toMatchObject({ role: 'tool', status: 'denied' })
    expect(JSON.stringify(sentMessages(1).find((m) => m.role === 'tool'))).toContain(
      'The user denied this tool call.',
    )
  })

  it('从历史恢复：上一轮的推理与签名带回给同一模型', async () => {
    const history: CanonicalMessage[] = [
      user('之前的问题', 1),
      {
        role: 'assistant',
        content: [],
        reasoning: {
          text: '旧的推理',
          providerId: 'deepseek',
          blocks: [{ text: '旧的推理', signature: 'reasoning_content' }],
        },
        toolCalls: [{ id: 'old_1', name: 'get_order', input: { order_id: 'X' } }],
        model: model('').ref,
        ts: 2,
      },
      {
        role: 'tool',
        toolCallId: 'old_1',
        content: [{ type: 'text', text: '{}' }],
        status: 'ok',
        ts: 3,
      },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }], model: model('').ref, ts: 4 },
    ]
    const h = await setup([ANSWER_TURN], { history })
    await h.session.prompt(user('继续', 5))
    const sent = sentMessages(0)
    expect(sent.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ])
    expect(sent[2]).toMatchObject({ reasoning_content: '旧的推理' })
    expect(h.session.exportHistory().slice(0, 4)).toEqual(history)
  })

  it('不支持推理的模型不请求思考', async () => {
    const h = await setup([ANSWER_TURN], { profile: { supportsReasoning: false } })
    await h.session.prompt(user('hi'))
    expect(JSON.stringify(mock!.requests[0]!.body)).not.toContain('"enabled"')
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })
})

describe('PiRuntime：并行工具调用（Runtime §6.2）', () => {
  const READ = { ...TOOLS[0]!, parallel: true }
  const REFUND = { ...TOOLS[0]!, name: 'refund' }
  const batch = (...calls: [string, string][]): MockResponse => ({
    kind: 'stream',
    chunks: [
      ...calls.map(([id, name], i) => sse.toolCall(i, id, name, `{"order_id":"${id}"}`)),
      sse.finish('tool_calls', { prompt: 50, completion: 12 }),
    ],
  })

  /** 记录执行区间：每个调用先登记开始，等一轮事件循环后结束。 */
  function tracking() {
    const log: string[] = []
    const executeTool: RuntimeHooks['executeTool'] = async (call) => {
      log.push(`start ${call.id}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      log.push(`end ${call.id}`)
      return { status: 'ok', content: [{ type: 'text', text: call.id }] }
    }
    return { log, executeTool }
  }

  it('一批全是可并行的工具：同时执行，结果按模型给出的顺序回填', async () => {
    const t = tracking()
    const h = await setup([batch(['c1', 'get_order'], ['c2', 'get_order']), ANSWER_TURN], {
      tools: [READ],
      hooks: { executeTool: t.executeTool },
    })
    await h.session.prompt(user('查两个订单'))
    expect(t.log.slice(0, 2)).toEqual(['start c1', 'start c2'])
    const history = h.session.exportHistory()
    expect(history.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c1', 'c2'])
  })

  it('一批中有不可并行的工具：整批按顺序执行', async () => {
    const t = tracking()
    const h = await setup([batch(['c1', 'get_order'], ['c2', 'refund']), ANSWER_TURN], {
      tools: [READ, REFUND],
      hooks: { executeTool: t.executeTool },
    })
    await h.session.prompt(user('查订单并退款'))
    expect(t.log).toEqual(['start c1', 'end c1', 'start c2', 'end c2'])
    const body = mock!.requests[0]!.body['tools'] as unknown[]
    expect(body).toHaveLength(2)
  })
})

describe('PiRuntime：失败', () => {
  const cases: [number, string, boolean][] = [
    [401, PiErrorCode.AuthFailed, false],
    [429, PiErrorCode.RateLimited, true],
    [500, PiErrorCode.ServerError, true],
    [400, PiErrorCode.BadRequest, false],
  ]
  for (const [status, code, retryable] of cases) {
    it(`HTTP ${status} → ${code}，${retryable ? '可' : '不可'}重试`, async () => {
      const h = await setup([
        { kind: 'error', status, body: { error: { message: 'mock failure', type: 'x' } } },
      ])
      await h.session.prompt(user('hi'))
      expect(types(h.events)).toEqual(['step.started', 'step.completed', 'loop.ended'])
      expect(h.events[1]).toMatchObject({ finishReason: 'error' })
      expect(h.events[2]).toEqual({
        type: 'loop.ended',
        outcome: 'failed',
        error: { code, params: { status } },
        retryable,
      })
      // 失败的助手消息不进入历史
      expect(h.session.exportHistory().map((m) => m.role)).toEqual(['user'])
    })
  }

  it('连接失败 → network_error，可重试', async () => {
    mock = await startMockOpenAI([])
    const baseUrl = mock.baseUrl
    await mock.close()
    mock = undefined
    const events: RuntimeEvent[] = []
    const session = await new PiRuntime().createSession({
      model: model(baseUrl),
      systemPrompt: '',
      tools: [],
      history: [],
      signal: new AbortController().signal,
      hooks: { beforeToolCall: vi.fn(), executeTool: vi.fn() },
    })
    session.onEvent((e) => events.push(e))
    await session.prompt(user('hi'))
    expect(events.at(-1)).toEqual({
      type: 'loop.ended',
      outcome: 'failed',
      error: { code: PiErrorCode.NetworkError },
      retryable: true,
    })
  })
})

describe('PiRuntime：非法工具调用', () => {
  const callTurn = (name: string, args: string): MockResponse => ({
    kind: 'stream',
    chunks: [sse.toolCall(0, 'call_1', name, args), sse.finish('tool_calls')],
  })
  const cases: [string, string, string, string, unknown][] = [
    ['工具不存在', 'drop_table', '{"order_id":"A"}', 'tool.not_found', { order_id: 'A' }],
    ['参数不是合法 JSON', 'get_order', '{"order_id":', 'tool.invalid_input', {}],
    ['参数不符合 schema', 'get_order', '{"id":"A"}', 'tool.invalid_input', { id: 'A' }],
  ]
  for (const [title, name, args, code, input] of cases) {
    it(`${title}：不执行工具，报告给上层，错误作为工具结果回给模型`, async () => {
      const rejected: unknown[] = []
      const executeTool = vi.fn()
      const h = await setup([callTurn(name, args), ANSWER_TURN], {
        hooks: { executeTool, toolCallRejected: (call, error) => rejected.push({ call, error }) },
      })
      await h.session.prompt(user('hi'))
      expect(executeTool).not.toHaveBeenCalled()
      expect(h.calls).toEqual([])
      expect(rejected).toEqual([
        { call: { id: 'call_1', name, input }, error: { code, params: { name } } },
      ])
      const sent = sentMessages(1)
      expect(sent.at(-1)?.role).toBe('tool')
      expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
      expect(h.session.exportHistory().map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ])
    })
  }

  it('没有 toolCallRejected 钩子时照常继续', async () => {
    const h = await setup([callTurn('drop_table', '{}'), ANSWER_TURN])
    await h.session.prompt(user('hi'))
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })
})

describe('PiRuntime：重试', () => {
  const FAIL_500: MockResponse = {
    kind: 'error',
    status: 500,
    body: { error: { message: 'mock failure', type: 'x' } },
  }

  it('失败后 retry() 从用户消息继续，失败的助手消息不回传', async () => {
    const h = await setup([FAIL_500, ANSWER_TURN])
    await h.session.prompt(user('hi'))
    expect(h.events.at(-1)).toMatchObject({ outcome: 'failed', retryable: true })
    h.events.length = 0
    await h.session.retry!()
    expect(types(h.events)).toEqual([
      'step.started',
      'text.delta',
      'text.delta',
      'message.completed',
      'step.completed',
      'loop.ended',
    ])
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
    expect(h.session.exportHistory().map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('工具执行后失败：retry() 带着工具结果继续，不重复执行工具', async () => {
    const h = await setup([TOOL_TURN, FAIL_500, ANSWER_TURN])
    await h.session.prompt(user('订单 A-1024 的客户是谁？'))
    expect(h.calls).toHaveLength(1)
    expect(h.events.at(-1)).toMatchObject({ outcome: 'failed', retryable: true })
    await h.session.retry!()
    expect(h.calls).toHaveLength(1)
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    expect(sentMessages(2).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(h.session.exportHistory().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('等待重试时的引导消息随重试一起发出', async () => {
    const h = await setup([FAIL_500, ANSWER_TURN])
    await h.session.prompt(user('hi'))
    await h.session.steer(user('用中文', 2))
    await h.session.retry!()
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })

  it('会话已中止时 retry() 直接以 aborted 结束', async () => {
    const h = await setup([FAIL_500])
    await h.session.prompt(user('hi'))
    h.controller.abort()
    h.events.length = 0
    await h.session.retry!()
    expect(h.events).toEqual([{ type: 'loop.ended', outcome: 'aborted' }])
    expect(mock!.requests).toHaveLength(1)
  })
})

describe('PiRuntime：异常', () => {
  it('事件监听器抛出：本步以 error 结束，恰好一个 loop.ended（failed）', async () => {
    const h = await setup([ANSWER_TURN])
    h.session.onEvent((e) => {
      if (e.type === 'text.delta') throw new Error('listener boom')
    })
    await h.session.prompt(user('hi'))
    expect(types(h.events)).toEqual(['step.started', 'text.delta', 'step.completed', 'loop.ended'])
    expect(h.events[2]).toMatchObject({ finishReason: 'error' })
    expect(h.events[3]).toEqual({
      type: 'loop.ended',
      outcome: 'failed',
      error: { code: PiErrorCode.Unknown },
      retryable: false,
    })
  })
})

describe('PiRuntime：中止', () => {
  it('流式输出中中止：本步 aborted，不发出 message.completed，部分回复不进入历史', async () => {
    const h = await setup([{ kind: 'hang', chunks: [sse.text('写到一半')] }])
    h.session.onEvent((e) => {
      if (e.type === 'text.delta') void h.session.abort()
    })
    await h.session.prompt(user('写一篇长文'))
    expect(types(h.events)).toEqual(['step.started', 'text.delta', 'step.completed', 'loop.ended'])
    expect(h.events[2]).toMatchObject({ finishReason: 'aborted' })
    expect(h.events[3]).toEqual({ type: 'loop.ended', outcome: 'aborted' })
    expect(h.session.exportHistory().map((m) => m.role)).toEqual(['user'])
  })

  it('中止后不再转发同一网络块中剩余的增量（第一步与工具调用之后的一步）', async () => {
    const burst: MockResponse = {
      kind: 'hang',
      chunks: [sse.text('一'), sse.text('二'), sse.text('三'), sse.text('四')],
    }
    for (const responses of [[burst], [TOOL_TURN, burst]]) {
      const h = await setup(responses)
      let deltas = 0
      h.session.onEvent((e) => {
        if (e.type === 'text.delta' && ++deltas === 2) void h.session.abort()
      })
      await h.session.prompt(user('写一篇长文'))
      expect(h.events.filter((e) => e.type === 'text.delta')).toHaveLength(2)
      expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'aborted' })
      await mock?.close()
      mock = undefined
    }
  })

  it('工具执行中中止：取消信号传给工具，本轮以 aborted 结束', async () => {
    let toolSignal: AbortSignalLike | undefined
    const h = await setup([TOOL_TURN, ANSWER_TURN], {
      hooks: {
        executeTool: (_call, signal) => {
          toolSignal = signal
          void h.session.abort()
          return new Promise((resolve) => {
            const done = () =>
              resolve({ status: 'cancelled', content: [{ type: 'text', text: 'cancelled' }] })
            if (signal.aborted) done()
            else signal.addEventListener('abort', done, { once: true })
          })
        },
      },
    })
    await h.session.prompt(user('查订单'))
    expect(toolSignal?.aborted).toBe(true)
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'aborted' })
    expect(mock!.requests).toHaveLength(1)
    const history = h.session.exportHistory()
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(history[2]).toMatchObject({ status: 'cancelled' })
  })

  it('会话信号中止：运行中的轮次结束；之后的 prompt 不再发请求', async () => {
    const h = await setup([{ kind: 'hang', chunks: [sse.text('…')] }])
    h.session.onEvent((e) => {
      if (e.type === 'text.delta') h.controller.abort()
    })
    await h.session.prompt(user('a'))
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'aborted' })

    h.events.length = 0
    await h.session.prompt(user('b'))
    expect(h.events).toEqual([{ type: 'loop.ended', outcome: 'aborted' }])
    expect(mock!.requests).toHaveLength(1)
  })

  it('空闲时 abort 没有效果', async () => {
    const h = await setup([ANSWER_TURN])
    await h.session.abort()
    await h.session.prompt(user('hi'))
    expect(h.events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })
})

describe('PiRuntime：steer 与生命周期', () => {
  it('空闲时 steer：进入历史，随下一次 prompt 发送', async () => {
    const h = await setup([ANSWER_TURN])
    await h.session.steer(user('请用中文回答', 1))
    await h.session.prompt(user('hi', 2))
    expect(sentMessages(0).filter((m) => m.role === 'user')).toHaveLength(2)
    expect(h.session.exportHistory().map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('运行中 steer：在下一次调用模型前生效', async () => {
    const steerMessage = user('改查 A-2048', 9)
    const h = await setup([TOOL_TURN, ANSWER_TURN], {
      hooks: {
        executeTool: async () => {
          await h.session.steer(steerMessage)
          return { status: 'ok', content: [{ type: 'text', text: '{}' }] }
        },
      },
    })
    await h.session.prompt(user('查订单', 1))
    expect(JSON.stringify(sentMessages(1))).toContain('改查 A-2048')
    const history = h.session.exportHistory()
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(history[3]).toBe(steerMessage)
  })

  it('运行中再次 prompt 抛出；释放后 prompt 抛出；释放可重复调用', async () => {
    const h = await setup([ANSWER_TURN])
    const running = h.session.prompt(user('a'))
    await expect(h.session.prompt(user('b'))).rejects.toThrow('正在运行')
    await running
    const unsubscribe = h.session.onEvent(() => {})
    unsubscribe()
    await h.session.dispose()
    await h.session.dispose()
    await expect(h.session.prompt(user('c'))).rejects.toThrow('已释放')
  })
})
