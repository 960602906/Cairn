import type { ModelRef } from '@nexus/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FakeRuntime,
  parseFakeScript,
  type FakeScript,
  type ResolvedModel,
  type RuntimeEvent,
  type RuntimeHooks,
  type RuntimeSession,
  type RuntimeToolResult,
  type RuntimeToolSpec,
  type UserMessage,
} from './index.js'

const ref: ModelRef = { providerId: 'fake', modelId: 'fake-1' }
const model: ResolvedModel = {
  ref,
  providerKind: 'openai',
  baseUrl: 'http://localhost:0',
  profile: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
  },
}
const user = (text: string): UserMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ts: 1,
})
const ok: RuntimeToolResult = { status: 'ok', content: [{ type: 'text', text: '文件内容' }] }

interface Setup {
  hooks?: Partial<RuntimeHooks>
  signal?: AbortSignal
  tools?: RuntimeToolSpec[]
}

async function open(script: FakeScript, setup: Setup = {}) {
  const runtime = new FakeRuntime(script, { now: () => 100 })
  const session = await runtime.createSession({
    model,
    systemPrompt: '',
    tools: setup.tools ?? [],
    history: [],
    signal: setup.signal ?? new AbortController().signal,
    hooks: {
      beforeToolCall: async () => ({ action: 'allow' }),
      executeTool: async () => ok,
      ...setup.hooks,
    },
  })
  const events: RuntimeEvent[] = []
  session.onEvent((e) => events.push(e))
  return { runtime, session, events }
}

const types = (events: readonly RuntimeEvent[]) => events.map((e) => e.type)
const textOf = (events: readonly RuntimeEvent[], type: 'text.delta' | 'reasoning.delta') =>
  events.flatMap((e) => (e.type === type ? [e.text] : []))

afterEach(() => {
  vi.useRealTimers()
})

describe('FakeRuntime：脚本输出', () => {
  it('逐字流式回复', async () => {
    const { session, events } = await open({
      turns: [
        { steps: [{ kind: 'reply', text: '你好！', usage: { inputTokens: 3, outputTokens: 2 } }] },
      ],
    })
    await session.prompt(user('嗨'))
    expect(types(events)).toEqual([
      'step.started',
      'text.delta',
      'text.delta',
      'text.delta',
      'message.completed',
      'step.completed',
      'loop.ended',
    ])
    expect(textOf(events, 'text.delta')).toEqual(['你', '好', '！'])
    expect(events.at(-2)).toEqual({
      type: 'step.completed',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    expect(session.exportHistory()).toEqual([
      user('嗨'),
      { role: 'assistant', content: [{ type: 'text', text: '你好！' }], model: ref, ts: 100 },
    ])
  })

  it('推理内容先于文本，按 chunkSize 切分', async () => {
    const { session, events } = await open({
      chunkSize: 2,
      turns: [{ steps: [{ kind: 'reply', text: 'abcde', reasoning: '想一想' }] }],
    })
    await session.prompt(user('?'))
    expect(textOf(events, 'reasoning.delta')).toEqual(['想一', '想'])
    expect(textOf(events, 'text.delta')).toEqual(['ab', 'cd', 'e'])
    expect(types(events).indexOf('reasoning.delta')).toBeLessThan(
      types(events).indexOf('text.delta'),
    )
    const completed = events.find((e) => e.type === 'message.completed')
    expect(completed).toMatchObject({
      message: { reasoning: { text: '想一想', providerId: 'fake' } },
    })
  })

  it('模拟一次工具调用后回复', async () => {
    const executeTool = vi.fn(async () => ok)
    const { session, events } = await open(
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'read_file', input: { path: 'a.ts' }, text: '我先看看' },
              { kind: 'reply', text: '看完了' },
            ],
          },
        ],
      },
      { hooks: { executeTool } },
    )
    await session.prompt(user('读 a.ts'))
    expect(executeTool).toHaveBeenCalledWith(
      { id: 'fake-call-1', name: 'read_file', input: { path: 'a.ts' } },
      expect.objectContaining({ aborted: false }),
    )
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(2)
    expect(events.find((e) => e.type === 'step.completed')).toEqual({
      type: 'step.completed',
      finishReason: 'tool_calls',
    })
    expect(session.exportHistory().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(session.exportHistory()[2]).toEqual({
      role: 'tool',
      toolCallId: 'fake-call-1',
      content: ok.content,
      status: 'ok',
      ts: 100,
    })
  })

  describe('一步多个工具调用', () => {
    const spec = (name: string, parallel?: boolean): RuntimeToolSpec => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      ...(parallel === undefined ? {} : { parallel }),
    })
    const script = (names: string[]): FakeScript => ({
      turns: [
        {
          steps: [
            { kind: 'tools', calls: names.map((name) => ({ name, input: {} })) },
            { kind: 'reply', text: '好了' },
          ],
        },
      ],
    })
    function tracking() {
      const log: string[] = []
      const executeTool: RuntimeHooks['executeTool'] = async (call) => {
        log.push(`start ${call.id}`)
        await Promise.resolve()
        log.push(`end ${call.id}`)
        return { status: 'ok', content: [{ type: 'text', text: call.id }] }
      }
      return { log, executeTool }
    }

    it('全部可并行：同时执行，结果按调用顺序进入历史', async () => {
      const t = tracking()
      const { session } = await open(script(['read', 'read']), {
        tools: [spec('read', true)],
        hooks: { executeTool: t.executeTool },
      })
      await session.prompt(user('x'))
      expect(t.log.slice(0, 2)).toEqual(['start fake-call-1', 'start fake-call-2'])
      const history = session.exportHistory()
      expect(history[1]).toMatchObject({
        toolCalls: [{ id: 'fake-call-1' }, { id: 'fake-call-2' }],
      })
      expect(history.slice(2, 4).map((m) => (m.role === 'tool' ? m.toolCallId : ''))).toEqual([
        'fake-call-1',
        'fake-call-2',
      ])
    })

    it('有不可并行或未知的工具：按顺序执行', async () => {
      for (const tools of [[spec('read', true), spec('write', false)], [spec('read', true)]]) {
        const t = tracking()
        const { session } = await open(script(['read', 'write']), {
          tools,
          hooks: { executeTool: t.executeTool },
        })
        await session.prompt(user('x'))
        expect(t.log).toEqual([
          'start fake-call-1',
          'end fake-call-1',
          'start fake-call-2',
          'end fake-call-2',
        ])
      }
    })
  })

  it('工具被拒绝时不执行，结果为 denied', async () => {
    const executeTool = vi.fn(async () => ok)
    const { session } = await open(
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'rm', input: {} },
              { kind: 'reply', text: '好的' },
            ],
          },
        ],
      },
      {
        hooks: { beforeToolCall: async () => ({ action: 'deny', reason: '不允许' }), executeTool },
      },
    )
    await session.prompt(user('删'))
    expect(executeTool).not.toHaveBeenCalled()
    expect(session.exportHistory()[2]).toMatchObject({
      status: 'denied',
      content: [{ type: 'text', text: '不允许' }],
    })
    // 没有文本的工具步骤：助手消息内容为空
    expect(session.exportHistory()[1]).toMatchObject({ content: [], toolCalls: [{ name: 'rm' }] })
  })

  it('模拟失败', async () => {
    const { session, events } = await open({
      turns: [
        {
          steps: [
            { kind: 'tool', name: 't', input: null },
            { kind: 'fail', error: { code: 'model.rate_limited' }, retryable: true },
          ],
        },
      ],
    })
    await session.prompt(user('?'))
    expect(events.slice(-2)).toEqual([
      { type: 'step.completed', finishReason: 'error' },
      {
        type: 'loop.ended',
        outcome: 'failed',
        error: { code: 'model.rate_limited' },
        retryable: true,
      },
    ])
    expect(session.exportHistory().map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('retry() 从失败之后的步骤继续；最后一步失败时再次失败', async () => {
    const { session, events } = await open({
      turns: [
        {
          steps: [
            { kind: 'fail', error: { code: 'model.server_error' }, retryable: true },
            { kind: 'fail', error: { code: 'model.rate_limited' }, retryable: true },
            { kind: 'reply', text: '好' },
          ],
        },
        { steps: [{ kind: 'fail', error: { code: 'model.network_error' }, retryable: true }] },
      ],
    })
    await expect(session.retry!()).rejects.toThrow('没有可重试的失败')
    await session.prompt(user('?'))
    events.length = 0
    await session.retry!()
    expect(events.at(-1)).toMatchObject({ error: { code: 'model.rate_limited' } })
    events.length = 0
    await session.retry!()
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    expect(session.exportHistory().map((m) => m.role)).toEqual(['user', 'assistant'])
    await expect(session.retry!()).rejects.toThrow('没有可重试的失败')

    await session.prompt(user('第二轮'))
    events.length = 0
    await session.retry!()
    expect(events).toEqual([
      { type: 'step.started', model: expect.anything() },
      { type: 'step.completed', finishReason: 'error' },
      {
        type: 'loop.ended',
        outcome: 'failed',
        error: { code: 'model.network_error' },
        retryable: true,
      },
    ])
  })

  it('按轮次消费脚本，用尽后回声回复', async () => {
    const { session } = await open({ turns: [{ steps: [{ kind: 'reply', text: '第一轮' }] }] })
    await session.prompt(user('一'))
    await session.prompt(user('原样返回'))
    const history = session.exportHistory()
    expect(history[1]).toMatchObject({ content: [{ type: 'text', text: '第一轮' }] })
    expect(history[3]).toMatchObject({ content: [{ type: 'text', text: '原样返回' }] })
  })

  it('默认脚本为空：直接回声', async () => {
    const runtime = new FakeRuntime()
    expect(runtime.id).toBe('fake')
    const session = await runtime.createSession({
      model,
      systemPrompt: '',
      tools: [],
      history: [user('之前的消息')],
      signal: new AbortController().signal,
      hooks: { beforeToolCall: async () => ({ action: 'allow' }), executeTool: async () => ok },
    })
    await session.prompt(user('在吗'))
    expect(session.exportHistory().map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('回声时忽略非文本内容', async () => {
    const { session } = await open({ turns: [] })
    await session.prompt({
      role: 'user',
      content: [
        { type: 'image', blobRef: 'b1', mimeType: 'image/png' },
        { type: 'text', text: '看图' },
      ],
      ts: 1,
    })
    expect(session.exportHistory()[1]).toMatchObject({ content: [{ type: 'text', text: '看图' }] })
  })

  it('steer 追加到历史；取消订阅后不再收到事件', async () => {
    const { session, events } = await open({ turns: [] })
    await session.steer(user('补充'))
    const off = session.onEvent(() => {})
    off()
    await session.prompt(user('x'))
    expect(session.exportHistory().map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('FakeRuntime：延迟与中止', () => {
  const slow: FakeScript = {
    delayMs: 50,
    turns: [{ steps: [{ kind: 'reply', text: 'abcdef', reasoning: 'r' }] }],
  }

  it('按 delayMs 逐个输出', async () => {
    vi.useFakeTimers()
    const { session, events } = await open(slow)
    const done = session.prompt(user('?'))
    await vi.advanceTimersByTimeAsync(50)
    expect(textOf(events, 'reasoning.delta')).toEqual(['r'])
    await vi.advanceTimersByTimeAsync(100)
    expect(textOf(events, 'text.delta')).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })

  it('abort() 中止流式输出，未完成的消息不进入历史', async () => {
    vi.useFakeTimers()
    const { session, events } = await open(slow)
    const done = session.prompt(user('?'))
    await vi.advanceTimersByTimeAsync(120)
    await session.abort()
    await done
    expect(events.slice(-2)).toEqual([
      { type: 'step.completed', finishReason: 'aborted' },
      { type: 'loop.ended', outcome: 'aborted' },
    ])
    expect(types(events)).not.toContain('message.completed')
    expect(session.exportHistory()).toEqual([user('?')])
    // 中止后可以开始新一轮（脚本已用尽，回声）
    const again = session.prompt(user('再来'))
    await vi.advanceTimersByTimeAsync(1000)
    await again
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
  })

  it('重复 abort 只生效一次', async () => {
    vi.useFakeTimers()
    const { session, events } = await open(slow)
    const done = session.prompt(user('?'))
    await vi.advanceTimersByTimeAsync(60)
    await session.abort()
    await session.abort()
    await done
    expect(types(events).filter((t) => t === 'loop.ended')).toHaveLength(1)
  })

  it('会话级 AbortSignal 同样中止', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { session, events } = await open(slow, { signal: controller.signal })
    const done = session.prompt(user('?'))
    await vi.advanceTimersByTimeAsync(60)
    controller.abort()
    await done
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'aborted' })
  })

  it('信号已中止时，prompt 不开始任何步骤', async () => {
    const controller = new AbortController()
    controller.abort()
    const { session, events } = await open(slow, { signal: controller.signal })
    await session.prompt(user('?'))
    expect(events).toEqual([{ type: 'loop.ended', outcome: 'aborted' }])
  })

  it('工具执行中中止：工具收到信号，本轮不再开始下一步', async () => {
    let toolSignal: { aborted: boolean } | undefined
    const holder: { session?: RuntimeSession } = {}
    const opened = await open(
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 't', input: {} },
              { kind: 'reply', text: '不会出现' },
            ],
          },
        ],
      },
      {
        hooks: {
          executeTool: async (_call, signal) => {
            toolSignal = signal
            await holder.session?.abort()
            return { status: 'cancelled', content: [] }
          },
        },
      },
    )
    const session = opened.session
    holder.session = session
    await session.prompt(user('?'))
    expect(toolSignal?.aborted).toBe(true)
    expect(types(opened.events).filter((t) => t === 'step.started')).toHaveLength(1)
    expect(opened.events.slice(-2)).toEqual([
      { type: 'step.completed', finishReason: 'tool_calls' },
      { type: 'loop.ended', outcome: 'aborted' },
    ])
    expect(session.exportHistory().map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('空闲时 abort 无效果；运行中不能再次 prompt；释放后不能 prompt', async () => {
    vi.useFakeTimers()
    const { session } = await open(slow)
    await session.abort()
    const done = session.prompt(user('一'))
    await expect(session.prompt(user('二'))).rejects.toThrow('正在运行')
    await session.dispose()
    await done
    await expect(session.prompt(user('三'))).rejects.toThrow('已释放')
  })

  it('钩子抛出的异常原样传出', async () => {
    const { session } = await open(
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 't', input: {} },
              { kind: 'reply', text: 'x' },
            ],
          },
        ],
      },
      {
        hooks: {
          beforeToolCall: async () => {
            throw new Error('boom')
          },
        },
      },
    )
    await expect(session.prompt(user('?'))).rejects.toThrow('boom')
    // 异常后会话回到空闲
    await session.prompt(user('again'))
  })
})

describe('parseFakeScript', () => {
  it('合法脚本', () => {
    const script = {
      chunkSize: 3,
      delayMs: 0,
      turns: [
        {
          steps: [
            {
              kind: 'tool',
              name: 'a',
              input: 1,
              text: 't',
              reasoning: 'r',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
            {
              kind: 'reply',
              text: 'x',
              reasoning: 'r',
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          ],
        },
        { steps: [{ kind: 'fail', error: { code: 'x' }, retryable: false }] },
        {
          steps: [
            { kind: 'tools', calls: [{ name: 'a', input: 1 }], text: 't', reasoning: 'r' },
            { kind: 'reply', text: 'x' },
          ],
        },
      ],
    }
    expect(parseFakeScript(script)).toEqual({ ok: true, script })
  })

  it.each([
    [null, '脚本必须是对象'],
    [[], '脚本必须是对象'],
    [{ turns: {} }, 'turns: 必须是数组'],
    [{ turns: [], chunkSize: 0 }, 'chunkSize: 必须是正整数'],
    [{ turns: [], chunkSize: 1.5 }, 'chunkSize: 必须是正整数'],
    [{ turns: [], delayMs: -1 }, 'delayMs: 必须是非负整数'],
    [{ turns: [{}] }, 'turns[0].steps: 必须是非空数组'],
    [{ turns: [{ steps: [] }] }, 'turns[0].steps: 必须是非空数组'],
    [{ turns: [{ steps: ['x'] }] }, 'turns[0].steps[0]: 必须是对象'],
    [
      { turns: [{ steps: [{ kind: 'dance' }] }] },
      'turns[0].steps[0].kind: 必须是 reply、tool、tools 或 fail',
    ],
    [
      { turns: [{ steps: [{ kind: 'tools', calls: [] }] }] },
      'turns[0].steps[0].calls: 必须是非空数组',
    ],
    [
      { turns: [{ steps: [{ kind: 'tools', calls: [{ name: '' }, 'x'] }] }] },
      'turns[0].steps[0].calls[1]: 需要非空 name 与 input',
    ],
    [
      { turns: [{ steps: [{ kind: 'tools', calls: [{ name: 'a', input: 1 }] }] }] },
      'turns[0].steps[0]: tools 不能是最后一步',
    ],
    [{ turns: [{ steps: [{ kind: 'reply' }] }] }, 'turns[0].steps[0].text: 必须是字符串'],
    [
      { turns: [{ steps: [{ kind: 'reply', text: '', reasoning: 1 }] }] },
      'turns[0].steps[0].reasoning: 必须是字符串',
    ],
    [
      {
        turns: [
          { steps: [{ kind: 'reply', text: '', usage: { inputTokens: -1, outputTokens: 0 } }] },
        ],
      },
      'turns[0].steps[0].usage: 需要非负整数 inputTokens 与 outputTokens',
    ],
    [
      { turns: [{ steps: [{ kind: 'reply', text: '', usage: 'x' }] }] },
      'turns[0].steps[0].usage: 需要非负整数 inputTokens 与 outputTokens',
    ],
    [
      {
        turns: [
          {
            steps: [
              { kind: 'reply', text: '' },
              { kind: 'reply', text: '' },
            ],
          },
        ],
      },
      'turns[0].steps[0]: reply 只能是最后一步',
    ],
    [
      { turns: [{ steps: [{ kind: 'tool', name: 'a', input: 1 }] }] },
      'turns[0].steps[0]: tool 不能是最后一步',
    ],
    [
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: '', input: 1 },
              { kind: 'reply', text: '' },
            ],
          },
        ],
      },
      'turns[0].steps[0].name: 必须是非空字符串',
    ],
    [
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'a' },
              { kind: 'reply', text: '' },
            ],
          },
        ],
      },
      'turns[0].steps[0].input: 缺失',
    ],
    [
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'a', input: 1, text: 2 },
              { kind: 'reply', text: '' },
            ],
          },
        ],
      },
      'turns[0].steps[0].text: 必须是字符串',
    ],
    [
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'a', input: 1, usage: {} },
              { kind: 'reply', text: '' },
            ],
          },
        ],
      },
      'turns[0].steps[0].usage: 需要非负整数 inputTokens 与 outputTokens',
    ],
    [
      { turns: [{ steps: [{ kind: 'fail', error: {}, retryable: true }] }] },
      'turns[0].steps[0].error.code: 必须是非空字符串',
    ],
    [
      { turns: [{ steps: [{ kind: 'fail', error: 'x', retryable: true }] }] },
      'turns[0].steps[0].error.code: 必须是非空字符串',
    ],
    [
      { turns: [{ steps: [{ kind: 'fail', error: { code: 'x' } }] }] },
      'turns[0].steps[0].retryable: 必须是布尔值',
    ],
  ])('非法：%j', (input, message) => {
    const result = parseFakeScript(input)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors).toContain(message)
  })

  it('构造 FakeRuntime 时校验脚本', () => {
    expect(() => new FakeRuntime({ turns: [{ steps: [] }] })).toThrow('FakeRuntime 脚本无效')
  })
})
