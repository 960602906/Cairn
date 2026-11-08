import {
  isPersistedEvent,
  type EventEnvelope,
  type ModelRef,
  type RunLimits,
  type RunState,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETRY_POLICY,
  FakeRuntime,
  RunEngine,
  retryDelay,
  RunEngineErrorCode,
  SESSION_BRIEF_PREFIX,
  createSessionView,
  rebuildHistory,
  reduceSessionEvents,
  sessionStatus,
  type AgentRuntime,
  type FakeScript,
  type ResolvedModel,
  type RunEngineOptions,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionInit,
  type ToolExecutor,
  type ToolPipeline,
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
    supportsParallelToolCalls: true,
    supportsReasoning: true,
  },
}
const limits: RunLimits = {
  maxStepsPerTurn: 10,
  maxTurnDurationMs: 60_000,
  maxConsecutiveToolErrors: 3,
}
const text = (t: string) => [{ type: 'text' as const, text: t }]

afterEach(() => {
  vi.useRealTimers()
})

async function start(
  runtime: AgentRuntime,
  extra: Partial<RunEngineOptions> = {},
): Promise<{ engine: RunEngine; events: UnsequencedEvent[]; controller: AbortController }> {
  const events: UnsequencedEvent[] = []
  const controller = new AbortController()
  const engine = await RunEngine.create({
    sessionId: 's1',
    runId: 'r1',
    agent: { id: 'builtin.coder', version: 1 },
    mode: 'interactive',
    limits,
    runtime,
    model,
    signal: controller.signal,
    emit: (e) => events.push(e),
    now: () => 1000,
    ...extra,
  })
  return { engine, events, controller }
}

const fake = (script: FakeScript) => new FakeRuntime(script, { now: () => 1000 })
const types = (events: readonly UnsequencedEvent[]) => events.map((e) => e.type)
const states = (events: readonly UnsequencedEvent[]) =>
  events.flatMap((e) => (e.type === 'run.state.changed' ? [e.payload.to] : []))

/** 模拟主进程：先落库 message.user，再分配 seq。 */
function sequenced(userText: string, events: readonly UnsequencedEvent[]): EventEnvelope[] {
  const user: UnsequencedEvent = {
    v: 1,
    sessionId: 's1',
    runId: 'r1',
    ts: 1,
    type: 'message.user',
    payload: { messageId: 'u1', content: text(userText) },
  }
  const created = events.filter((e) => e.type === 'run.created')
  const rest = events.filter((e) => e.type !== 'run.created')
  return [...created, user, ...rest].map((e, i) => ({ ...e, seq: i + 1 }) as EventEnvelope)
}

describe('RunEngine：项目说明', () => {
  it('在调用模型前换上 prepareTurn 的系统提示词，并写入 turn.started', async () => {
    const prompts: string[] = []
    const inner = fake({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] })
    const runtime: AgentRuntime = {
      id: 'wrap',
      async createSession(init) {
        const session = await inner.createSession(init)
        return {
          prompt: (input) => session.prompt(input),
          steer: (input) => session.steer(input),
          abort: (reason) => session.abort(reason),
          onEvent: (listener) => session.onEvent(listener),
          exportHistory: () => session.exportHistory(),
          setSystemPrompt: (prompt: string) => {
            prompts.push(prompt)
          },
          dispose: () => session.dispose(),
        }
      },
    }
    const agentsMd = { sha256: 'b'.repeat(64), bytes: 8, truncated: false, lines: 1 }
    const { engine, events } = await start(runtime, {
      prepareTurn: async () => ({ systemPrompt: 'with agents', context: { agentsMd } }),
    })
    await engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(prompts).toEqual(['with agents'])
    expect(events.find((event) => event.type === 'turn.started')?.payload).toEqual({
      context: { agentsMd },
    })
  })
})

describe('RunEngine：正常完成', () => {
  it('事件顺序、状态与投影', async () => {
    const { engine, events } = await start(
      fake({
        turns: [
          { steps: [{ kind: 'reply', text: '你好', usage: { inputTokens: 5, outputTokens: 2 } }] },
        ],
      }),
    )
    expect(types(events)).toEqual(['run.created'])
    expect(events[0]).toMatchObject({
      payload: {
        agent: { id: 'builtin.coder', version: 1 },
        model: ref,
        mode: 'interactive',
        limits,
      },
    })
    await engine.prompt({ messageId: 'u1', content: text('嗨') })
    expect(types(events)).toEqual([
      'run.created',
      'turn.started',
      'run.state.changed',
      'step.started',
      'message.assistant.delta',
      'message.assistant.delta',
      'message.assistant.completed',
      'step.completed',
      'usage.reported',
      'run.state.changed',
      'turn.completed',
    ])
    expect(states(events)).toEqual(['thinking', 'completed'])
    expect(engine.state).toBe('completed')

    // 信封头：轮次与步骤 id
    const turnId = events[1]!.turnId
    expect(turnId).toBeDefined()
    expect(events[0]!.turnId).toBeUndefined()
    const stepEvents = events.slice(3, 9)
    const stepId = stepEvents[0]!.stepId
    expect(stepId).toBeDefined()
    for (const e of stepEvents)
      expect(e).toMatchObject({ turnId, stepId, sessionId: 's1', runId: 'r1', v: 1, ts: 1000 })
    expect(events.at(-1)!.stepId).toBeUndefined()
    // 增量与完成事件使用同一个 messageId
    const ids = new Set(
      events.flatMap((e) =>
        e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed'
          ? [e.payload.messageId]
          : [],
      ),
    )
    expect(ids.size).toBe(1)
    expect(events[7]).toMatchObject({
      payload: {
        model: ref,
        finishReason: 'stop',
        durationMs: 0,
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    })

    // 与 core 的投影、历史重建配合
    const seq = sequenced('嗨', events)
    const view = reduceSessionEvents(createSessionView('s1'), seq)
    expect(view.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(view.runs.r1?.state).toBe('completed')
    expect(view.runs.r1?.turn?.status).toBe('completed')
    expect(view.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
    expect(sessionStatus(view)).toBe('idle')
    expect(
      rebuildHistory(seq.filter(isPersistedEvent), { runId: 'r1' }).map((m) => m.role),
    ).toEqual(['user', 'assistant'])
  })

  it('完成后可以开始下一轮', async () => {
    const { engine, events } = await start(fake({ turns: [] }))
    await engine.prompt({ messageId: 'u1', content: text('一') })
    await engine.prompt({ messageId: 'u2', content: text('二') })
    expect(states(events)).toEqual(['thinking', 'completed', 'thinking', 'completed'])
    const turnIds = events.flatMap((e) => (e.type === 'turn.started' ? [e.turnId] : []))
    expect(new Set(turnIds).size).toBe(2)
  })

  it('默认使用当前时间', async () => {
    const events: UnsequencedEvent[] = []
    const before = Date.now()
    await RunEngine.create({
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'a', version: 1 },
      mode: 'interactive',
      limits,
      runtime: fake({ turns: [] }),
      model,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    })
    expect(events[0]!.ts).toBeGreaterThanOrEqual(before)
  })

  it('默认 id 生成器与自定义 createId、parentRunId', async () => {
    let n = 0
    const { engine, events } = await start(fake({ turns: [] }), {
      createId: () => `id${++n}`,
      parentRunId: 'parent',
    })
    await engine.prompt({ messageId: 'u1', content: text('x') })
    expect(events[1]).toMatchObject({ turnId: 'id1', parentRunId: 'parent' })
    expect(events.find((e) => e.type === 'step.started')).toMatchObject({ stepId: 'id2' })
  })
})

describe('RunEngine：工具调用', () => {
  const script: FakeScript = {
    turns: [
      {
        steps: [
          { kind: 'tool', name: 'read_file', input: { path: 'a.ts' }, text: '我看看' },
          { kind: 'reply', text: '好了' },
        ],
      },
    ],
  }

  it('成功：tooling 往返，工具事件完整', async () => {
    const executeTool: ToolExecutor = vi.fn(async () => ({
      status: 'ok' as const,
      content: text('内容'),
    }))
    const { engine, events } = await start(fake(script), { executeTool })
    await engine.prompt({ messageId: 'u1', content: text('读 a.ts') })
    expect(states(events)).toEqual(['thinking', 'tooling', 'thinking', 'completed'])
    const tool = events.filter((e) => e.type.startsWith('tool.'))
    expect(tool.map((e) => e.type)).toEqual(['tool.requested', 'tool.started', 'tool.completed'])
    expect(tool[0]).toMatchObject({
      payload: { toolCallId: 'fake-call-1', name: 'read_file', input: { path: 'a.ts' } },
    })
    expect(tool[2]).toMatchObject({ payload: { output: text('内容'), durationMs: 0 } })
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(2)

    const seq = sequenced('读 a.ts', events)
    expect(
      rebuildHistory(seq.filter(isPersistedEvent), { runId: 'r1' }).map((m) => m.role),
    ).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('默认没有可用工具：tool.failed（tool.not_available）', async () => {
    const { engine, events } = await start(fake(script))
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.find((e) => e.type === 'tool.failed')).toMatchObject({
      payload: {
        toolCallId: 'fake-call-1',
        error: {
          code: RunEngineErrorCode.ToolNotAvailable,
          params: { message: 'Tool "read_file" is not available.' },
        },
      },
    })
    expect(engine.state).toBe('completed')
  })

  it.each([
    ['error', RunEngineErrorCode.ToolFailed],
    ['denied', RunEngineErrorCode.ToolDenied],
  ] as const)('执行结果 %s → tool.failed（%s）', async (status, code) => {
    const { engine, events } = await start(fake(script), {
      executeTool: async () => ({
        status,
        content: [{ type: 'image', blobRef: 'b', mimeType: 'image/png' }, ...text('原因')],
      }),
    })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.find((e) => e.type === 'tool.failed')).toMatchObject({
      payload: { error: { code, params: { message: '原因' } } },
    })
  })

  it('执行结果 cancelled → tool.cancelled（user）', async () => {
    const { engine, events } = await start(fake(script), {
      executeTool: async () => ({ status: 'cancelled', content: [] }),
    })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.find((e) => e.type === 'tool.cancelled')).toMatchObject({
      payload: { reason: 'user' },
    })
  })
})

describe('RunEngine：中止', () => {
  const slow: FakeScript = { delayMs: 50, turns: [{ steps: [{ kind: 'reply', text: 'abcdef' }] }] }

  it('用户停止：thinking → aborting → idle，turn.aborted(user)', async () => {
    vi.useFakeTimers()
    const { engine, events } = await start(fake(slow))
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.advanceTimersByTimeAsync(120)
    await engine.abort()
    await done
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'user' } })
    expect(engine.state).toBe('idle')

    // 已收到的部分回复保存为不完整的消息，在 step.completed 之前（Runtime §10.2）
    const deltas = events.flatMap((e) => (e.type === 'message.assistant.delta' ? [e] : []))
    expect(deltas.length).toBeGreaterThan(0)
    const partial = events.find((e) => e.type === 'message.assistant.completed')
    expect(partial?.payload).toEqual({
      messageId: deltas[0]!.payload.messageId,
      content: text(deltas.map((d) => d.payload.text).join('')),
      model: model.ref,
      incomplete: true,
    })
    const order = types(events)
    expect(order.indexOf('message.assistant.completed')).toBe(order.indexOf('step.completed') - 1)

    const view = reduceSessionEvents(createSessionView('s1'), sequenced('?', events))
    expect(view.live).toEqual({})
    expect(view.runs.r1?.turn?.status).toBe('aborted')
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant', incomplete: true })
  })

  it('还没有增量时停止：不保存空消息', async () => {
    vi.useFakeTimers()
    const { engine, events } = await start(fake(slow))
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.advanceTimersByTimeAsync(10)
    await engine.abort()
    await done
    expect(types(events)).not.toContain('message.assistant.completed')
  })

  it('只有推理增量时停止：保存推理内容，正文为空', async () => {
    vi.useFakeTimers()
    const { engine, events } = await start(
      fake({ delayMs: 50, turns: [{ steps: [{ kind: 'reply', text: 'abc', reasoning: 'xyz' }] }] }),
    )
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.advanceTimersByTimeAsync(70)
    await engine.abort()
    await done
    const partial = events.find((e) => e.type === 'message.assistant.completed')
    expect(partial?.payload).toMatchObject({
      content: [],
      reasoning: { text: 'x', providerId: model.ref.providerId },
      incomplete: true,
    })
  })

  it('运行时出错或直接结束循环时，同样保存部分回复', async () => {
    let listener: ((event: RuntimeEvent) => void) | undefined
    const scripted = (steps: readonly RuntimeEvent[][]): AgentRuntime => {
      let turn = 0
      return {
        id: 'scripted',
        createSession: async () => ({
          prompt: async () => {
            for (const event of steps[turn++] ?? []) listener?.(event)
          },
          steer: async () => {},
          abort: async () => {},
          onEvent: (l) => {
            listener = l
            return () => (listener = undefined)
          },
          exportHistory: () => [],
          dispose: async () => {},
        }),
      }
    }
    const failed = { code: 'model.unknown_error' }
    const { engine, events } = await start(
      scripted([
        [
          { type: 'step.started', model: model.ref },
          { type: 'text.delta', text: '半' },
          { type: 'step.completed', finishReason: 'error' },
          { type: 'loop.ended', outcome: 'failed', error: failed },
        ],
        [
          { type: 'step.started', model: model.ref },
          { type: 'text.delta', text: '截' },
          { type: 'loop.ended', outcome: 'aborted' },
        ],
      ]),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    await engine.prompt({ messageId: 'u2', content: text('?') })
    const partials = events.flatMap((e) =>
      e.type === 'message.assistant.completed' ? [e.payload] : [],
    )
    expect(partials.map((p) => [p.content, p.incomplete])).toEqual([
      [text('半'), true],
      [text('截'), true],
    ])
    expect(types(events).filter((t) => t.startsWith('turn.') && t !== 'turn.started')).toEqual([
      'turn.failed',
      'turn.aborted',
    ])
  })

  it('会话级信号中止：原因为 shutdown', async () => {
    vi.useFakeTimers()
    const { engine, events, controller } = await start(fake(slow))
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.advanceTimersByTimeAsync(60)
    controller.abort()
    await done
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'shutdown' } })
  })

  it('工具执行中停止：工具被取消（shutdown）', async () => {
    const holder: { engine?: RunEngine } = {}
    const { engine, events } = await start(
      fake({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 't', input: {} },
              { kind: 'reply', text: 'x' },
            ],
          },
        ],
      }),
      {
        executeTool: async (_call, signal) => {
          await holder.engine!.abort('shutdown')
          expect(signal.aborted).toBe(true)
          return { status: 'cancelled', content: [] }
        },
      },
    )
    holder.engine = engine
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(states(events)).toEqual(['thinking', 'tooling', 'aborting', 'idle'])
    expect(events.find((e) => e.type === 'tool.cancelled')).toMatchObject({
      payload: { reason: 'shutdown' },
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'shutdown' } })
  })

  it('空闲时停止无效果', async () => {
    const { engine, events } = await start(fake({ turns: [] }))
    await engine.abort()
    expect(types(events)).toEqual(['run.created'])
  })
})

describe('RunEngine：失败与限额', () => {
  it('模型失败：turn.failed，状态 failed，可以重试', async () => {
    const { engine, events } = await start(
      fake({
        turns: [
          { steps: [{ kind: 'fail', error: { code: 'model.rate_limited' }, retryable: true }] },
        ],
      }),
      { retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 0 } },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(states(events)).toEqual(['thinking', 'failed'])
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { code: 'model.rate_limited' }, retryable: true },
    })
    await engine.prompt({ messageId: 'u2', content: text('重试') })
    expect(engine.state).toBe('completed')
  })

  it('超过最大步数：turn.limit_reached + turn.failed(retryable)', async () => {
    const { engine, events } = await start(
      fake({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'a', input: {} },
              { kind: 'tool', name: 'b', input: {} },
              { kind: 'reply', text: '不会出现' },
            ],
          },
        ],
      }),
      { limits: { ...limits, maxStepsPerTurn: 2 } },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(2)
    expect(types(events).slice(-3)).toEqual([
      'turn.limit_reached',
      'run.state.changed',
      'turn.failed',
    ])
    expect(events.find((e) => e.type === 'turn.limit_reached')).toMatchObject({
      payload: { limit: 'maxStepsPerTurn', value: 2 },
    })
    expect(events.at(-1)).toMatchObject({
      payload: {
        error: { code: RunEngineErrorCode.LimitReached, params: { limit: 'maxStepsPerTurn' } },
        retryable: true,
      },
    })
    expect(states(events)).toEqual(['thinking', 'tooling', 'thinking', 'tooling', 'failed'])
    const view = reduceSessionEvents(createSessionView('s1'), sequenced('?', events))
    expect(view.runs.r1?.turn?.limitReached).toEqual({ limit: 'maxStepsPerTurn', value: 2 })
  })
})

describe('RunEngine：不设限额', () => {
  it('省略的限额不限制：步数、时长与连续工具失败都不会结束本轮', async () => {
    const steps = Array.from(
      { length: 30 },
      () => ({ kind: 'tool', name: 'a', input: {} }) as const,
    )
    let clock = 0
    const { engine, events } = await start(
      fake({ turns: [{ steps: [...steps, { kind: 'reply', text: '完成' }] }] }),
      {
        limits: {},
        executeTool: async () => {
          clock += 3_600_000
          return { status: 'error', content: text('坏了') }
        },
        now: () => clock,
      },
    )
    await engine.prompt({ messageId: 'u1', content: text('跑一整晚') })
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(31)
    expect(types(events)).not.toContain('turn.limit_reached')
    expect(types(events).at(-1)).toBe('turn.completed')
  })
})

describe('RunEngine：限额与非法工具调用', () => {
  const tool = (extra: object = {}) => ({ kind: 'tool', name: 'a', input: {}, ...extra }) as const
  const reply = { kind: 'reply', text: '好' } as const
  const fail: ToolExecutor = async () => ({ status: 'error', content: text('坏了') })
  const limitOf = (events: readonly UnsequencedEvent[]) =>
    events.find((e) => e.type === 'turn.limit_reached')?.payload
  const count = (events: readonly UnsequencedEvent[], type: string) =>
    types(events).filter((t) => t === type).length

  it('连续工具失败达到上限：结束本轮，不再调用模型', async () => {
    const { engine, events } = await start(
      fake({ turns: [{ steps: [tool(), tool(), tool(), tool(), reply] }] }),
      { executeTool: fail },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(count(events, 'tool.failed')).toBe(3)
    expect(count(events, 'step.started')).toBe(3)
    expect(limitOf(events)).toEqual({ limit: 'maxConsecutiveToolErrors', value: 3 })
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { params: { limit: 'maxConsecutiveToolErrors' } }, retryable: true },
    })
    const view = reduceSessionEvents(createSessionView('s1'), sequenced('?', events))
    expect(view.runs.r1?.turn?.limitReached).toEqual({
      limit: 'maxConsecutiveToolErrors',
      value: 3,
    })
    // “继续”开始新的一轮，计数重新开始
    await engine.prompt({ messageId: 'u2', content: text('继续') })
    expect(engine.state).toBe('completed')
  })

  it('成功的调用清零，被拒绝的调用不计', async () => {
    const results = ['error', 'error', 'ok', 'denied', 'error', 'error'] as const
    let i = 0
    const { engine, events } = await start(
      fake({ turns: [{ steps: [...results.map(() => tool()), reply] }] }),
      { executeTool: async () => ({ status: results[i++]!, content: text('x') }) },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(limitOf(events)).toBeUndefined()
    expect(engine.state).toBe('completed')
  })

  it('运行时拒绝的调用：tool.requested + tool.failed，计入连续失败', async () => {
    const executeTool = vi.fn<ToolExecutor>()
    const { engine, events } = await start(
      fake({
        turns: [
          {
            steps: [
              tool({ rejectedWith: 'tool.not_found' }),
              {
                kind: 'tools',
                calls: [
                  { name: 'a', input: {}, rejectedWith: 'tool.invalid_input' },
                  { name: 'b', input: { x: 1 }, rejectedWith: 'tool.invalid_input' },
                ],
              },
              reply,
            ],
          },
        ],
      }),
      { executeTool },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(executeTool).not.toHaveBeenCalled()
    expect(count(events, 'tool.started')).toBe(0)
    expect(
      events.flatMap((e) =>
        e.type === 'tool.requested' || e.type === 'tool.failed' ? [[e.type, e.payload]] : [],
      ),
    ).toEqual([
      ['tool.requested', { toolCallId: 'fake-call-1', name: 'a', input: {} }],
      [
        'tool.failed',
        { toolCallId: 'fake-call-1', error: { code: 'tool.not_found', params: { name: 'a' } } },
      ],
      ['tool.requested', { toolCallId: 'fake-call-2', name: 'a', input: {} }],
      [
        'tool.failed',
        { toolCallId: 'fake-call-2', error: { code: 'tool.invalid_input', params: { name: 'a' } } },
      ],
      ['tool.requested', { toolCallId: 'fake-call-3', name: 'b', input: { x: 1 } }],
      [
        'tool.failed',
        { toolCallId: 'fake-call-3', error: { code: 'tool.invalid_input', params: { name: 'b' } } },
      ],
    ])
    expect(states(events)).toEqual(['thinking', 'tooling', 'thinking', 'tooling', 'failed'])
    expect(limitOf(events)).toEqual({ limit: 'maxConsecutiveToolErrors', value: 3 })
    // 重建的历史中每个调用都有结果
    const history = rebuildHistory(sequenced('?', events), { runId: 'r1' })
    expect(history.filter((m) => m.role === 'tool').map((m) => m.status)).toEqual([
      'error',
      'error',
      'error',
    ])
  })

  it('单轮时长不含等待审批的时间', async () => {
    let clock = 0
    let waits = 0
    const pipeline: ToolPipeline = {
      async run(call, _signal, observer) {
        observer.started()
        if (call.input === 'approve') {
          observer.awaitingApproval(true)
          clock += 50_000
          waits += 1
          observer.awaitingApproval(false)
        } else {
          clock += 20_000
        }
        return { status: 'ok', content: text('ok'), truncated: false }
      },
    }
    const script = (input: string) =>
      fake({ turns: [{ steps: [tool({ input }), tool({ input }), tool({ input }), reply] }] })
    const run = async (input: string) => {
      clock = 0
      const r = await start(script(input), { toolPipeline: pipeline, now: () => clock })
      await r.engine.prompt({ messageId: 'u1', content: text('?') })
      return r.events
    }
    // 等待审批 3 × 50 秒，不计入 60 秒的上限
    expect(limitOf(await run('approve'))).toBeUndefined()
    expect(waits).toBe(3)
    // 执行 3 × 20 秒：第四次调用模型前超出
    const events = await run('work')
    expect(limitOf(events)).toEqual({ limit: 'maxTurnDurationMs', value: 60_000 })
    expect(count(events, 'step.started')).toBe(3)
  })

  it('流水线给出的 display 写进 tool.completed，不进入重建的历史（M2-06）', async () => {
    const display = {
      kind: 'terminal' as const,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      shell: 'bash',
      cwd: '/w',
      chunks: [{ stream: 'stdout' as const, text: '\x1b[32mok\x1b[0m' }],
      omittedChars: 0,
    }
    const pipeline: ToolPipeline = {
      run: async () => ({ status: 'ok', content: text('ok'), truncated: false, display }),
    }
    const { engine, events } = await start(fake({ turns: [{ steps: [tool(), reply] }] }), {
      toolPipeline: pipeline,
    })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ payload: { display } })
    const history = rebuildHistory(sequenced('?', events), { runId: 'r1' })
    expect(JSON.stringify(history)).not.toContain('\\u001b')
  })

  it('token 上限', async () => {
    const usage = { inputTokens: 40, outputTokens: 20 }
    const { engine, events } = await start(
      fake({ turns: [{ steps: [tool({ usage }), tool({ usage }), reply] }] }),
      {
        limits: { ...limits, maxTokensPerTurn: 100 },
        executeTool: async () => ({ status: 'ok', content: text('ok') }),
      },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(limitOf(events)).toEqual({ limit: 'maxTokensPerTurn', value: 100 })
    expect(count(events, 'step.started')).toBe(2)
  })

  it('费用上限：模型有单价时生效', async () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 }
    const script = () => fake({ turns: [{ steps: [tool({ usage }), tool({ usage }), reply] }] })
    const options = {
      limits: { ...limits, maxCostPerTurn: 1.5 },
      executeTool: (async () => ({ status: 'ok', content: text('ok') })) as ToolExecutor,
    }
    // 每次 1 + 0.1 × 2 = 1.2：第二次之后超出
    const priced = await start(script(), {
      ...options,
      model: {
        ...model,
        profile: { ...model.profile, pricing: { inputPerMillion: 1, outputPerMillion: 2 } },
      },
    })
    await priced.engine.prompt({ messageId: 'u1', content: text('?') })
    expect(limitOf(priced.events)).toEqual({ limit: 'maxCostPerTurn', value: 1.5 })
    expect(count(priced.events, 'step.started')).toBe(2)

    const unpriced = await start(script(), options)
    await unpriced.engine.prompt({ messageId: 'u1', content: text('?') })
    expect(limitOf(unpriced.events)).toBeUndefined()
    expect(unpriced.engine.state).toBe('completed')
  })

  it('轮次结束后收到的拒绝报告被忽略', async () => {
    let hooks!: RuntimeSessionInit['hooks']
    const inner = fake({ turns: [] })
    const runtime: AgentRuntime = {
      id: 'late',
      async createSession(init) {
        hooks = init.hooks
        return inner.createSession(init)
      },
    }
    const { engine, events } = await start(runtime)
    await engine.prompt({ messageId: 'u1', content: text('?') })
    const before = events.length
    hooks.toolCallRejected!({ id: 'c9', name: 'x', input: {} }, { code: 'tool.not_found' })
    expect(events).toHaveLength(before)
  })

  it('工具流水线重复报告开始只发出一次 tool.started', async () => {
    const pipeline: ToolPipeline = {
      async run(_call, _signal, observer) {
        observer.started()
        observer.started()
        return { status: 'ok', content: text('ok'), truncated: false }
      },
    }
    const { engine, events } = await start(
      fake({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'read', input: {} },
              { kind: 'reply', text: 'done' },
            ],
          },
        ],
      }),
      { toolPipeline: pipeline },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(types(events).filter((type) => type === 'tool.started')).toHaveLength(1)
  })
})

describe('RunEngine：模型请求重试', () => {
  const rateLimited = {
    kind: 'fail',
    error: { code: 'model.rate_limited' },
    retryable: true,
  } as const
  const policy = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 25 }
  const retries = (events: readonly UnsequencedEvent[]) =>
    events.flatMap((e) => (e.type === 'model.retry' ? [e.payload] : []))
  /** 假计时器下等到发出 model.retry（`vi.waitFor` 会推进假计时器，不能用）。 */
  let untilRetry: () => Promise<void>
  const watch = (events: readonly UnsequencedEvent[]) => {
    untilRetry = async () => {
      for (let i = 0; i < 100 && retries(events).length === 0; i++) await Promise.resolve()
      expect(retries(events)).toHaveLength(1)
    }
  }

  it('退避等待：base × 2^(n-1)，不超过上限', () => {
    expect([1, 2, 3, 4].map((n) => retryDelay(policy, n))).toEqual([10, 20, 25, 25])
    expect([1, 2, 3].map((n) => retryDelay(DEFAULT_RETRY_POLICY, n))).toEqual([1000, 2000, 4000])
  })

  it('可重试的失败：model.retry 后从失败处继续，本轮正常完成', async () => {
    const { engine, events } = await start(
      fake({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'a', input: {} },
              rateLimited,
              rateLimited,
              { kind: 'reply', text: '好' },
            ],
          },
        ],
      }),
      { retry: policy, executeTool: async () => ({ status: 'ok', content: text('ok') }) },
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(events)).toEqual([
      { attempt: 1, maxRetries: 3, delayMs: 10, error: { code: 'model.rate_limited' } },
      { attempt: 2, maxRetries: 3, delayMs: 20, error: { code: 'model.rate_limited' } },
    ])
    expect(types(events).filter((t) => t === 'tool.started')).toHaveLength(1)
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(4)
    const first = types(events).indexOf('model.retry')
    expect(types(events).slice(first - 1, first + 2)).toEqual([
      'step.completed',
      'model.retry',
      'step.started',
    ])
    expect(states(events)).toEqual(['thinking', 'tooling', 'thinking', 'completed'])
    expect(events.at(-1)?.type).toBe('turn.completed')
    // model.retry 属于本轮，持久化
    const retry = events.find((e) => e.type === 'model.retry')!
    expect(retry.turnId).toBe(events.find((e) => e.type === 'turn.started')!.turnId)
    expect(isPersistedEvent({ ...retry, seq: 1 } as EventEnvelope)).toBe(true)
    const view = reduceSessionEvents(createSessionView('s1'), sequenced('?', events))
    expect(view.runs.r1?.turn).toMatchObject({ status: 'completed', retry: undefined })
  })

  it('一直失败：重试耗尽后 turn.failed(retryable)', async () => {
    const { engine, events } = await start(fake({ turns: [{ steps: [rateLimited] }] }), {
      retry: { ...policy, maxRetries: 2 },
    })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(events).map((r) => [r.attempt, r.delayMs])).toEqual([
      [1, 10],
      [2, 20],
    ])
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(3)
    expect(states(events)).toEqual(['thinking', 'failed'])
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { code: 'model.rate_limited' }, retryable: true },
    })
    // 下一轮重新计数
    events.length = 0
    await engine.prompt({ messageId: 'u2', content: text('再来') })
    expect(engine.state).toBe('completed')
  })

  it('默认最多重试 3 次', async () => {
    vi.useFakeTimers()
    const { engine, events } = await start(fake({ turns: [{ steps: [rateLimited] }] }))
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.runAllTimersAsync()
    await done
    expect(retries(events).map((r) => [r.attempt, r.maxRetries, r.delayMs])).toEqual([
      [1, 3, 1000],
      [2, 3, 2000],
      [3, 3, 4000],
    ])
    expect(events.at(-1)?.type).toBe('turn.failed')
  })

  it('不可重试的失败不重试', async () => {
    const auth = await start(
      fake({
        turns: [
          { steps: [{ kind: 'fail', error: { code: 'model.auth_failed' }, retryable: false }] },
        ],
      }),
      { retry: policy },
    )
    await auth.engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(auth.events)).toEqual([])
    expect(auth.events.at(-1)).toMatchObject({ type: 'turn.failed', payload: { retryable: false } })
  })

  it('运行时没有 retry() 时不重试', async () => {
    const inner = fake({ turns: [{ steps: [rateLimited, { kind: 'reply', text: '好' }] }] })
    const runtime: AgentRuntime = {
      id: 'no-retry',
      async createSession(init) {
        const session = await inner.createSession(init)
        return {
          prompt: (m) => session.prompt(m),
          steer: (m) => session.steer(m),
          abort: () => session.abort(),
          onEvent: (l) => session.onEvent(l),
          exportHistory: () => session.exportHistory(),
          dispose: () => session.dispose(),
        }
      },
    }
    const { engine, events } = await start(runtime, { retry: policy })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(events)).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', payload: { retryable: true } })
  })

  it('等待重试时停止：turn.aborted，不再请求', async () => {
    vi.useFakeTimers()
    const runtime = fake({ turns: [{ steps: [rateLimited, { kind: 'reply', text: '好' }] }] })
    const { engine, events } = await start(runtime, { retry: { ...policy, baseDelayMs: 60_000 } })
    watch(events)
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await untilRetry()
    expect(engine.state).toBe('thinking')
    await engine.abort()
    await done
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(1)
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'user' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('等待重试时宿主关闭：turn.aborted(shutdown)', async () => {
    vi.useFakeTimers()
    const runtime = fake({ turns: [{ steps: [rateLimited, { kind: 'reply', text: '好' }] }] })
    const { engine, events, controller } = await start(runtime, {
      retry: { ...policy, baseDelayMs: 60_000 },
    })
    watch(events)
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await untilRetry()
    controller.abort()
    await done
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'shutdown' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('失败的同时被停止或宿主关闭：不等待，本轮以中止结束', async () => {
    let onFail: () => Promise<void> = async () => {}
    const runtime: AgentRuntime = {
      id: 'fail-then-stop',
      async createSession() {
        const listeners = new Set<(e: RuntimeEvent) => void>()
        return {
          prompt: async () => {
            for (const l of listeners) {
              l({ type: 'loop.ended', outcome: 'failed', error: { code: 'x' }, retryable: true })
            }
            await onFail()
          },
          retry: vi.fn(async () => {}),
          steer: async () => {},
          abort: async () => {},
          onEvent: (l) => {
            listeners.add(l)
            return () => listeners.delete(l)
          },
          exportHistory: () => [],
          dispose: async () => {},
        } satisfies RuntimeSession
      },
    }
    const slow = { ...policy, baseDelayMs: 60_000 }
    const stopped = await start(runtime, { retry: slow })
    onFail = () => stopped.engine.abort()
    await stopped.engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(stopped.events)).toEqual([])
    expect(stopped.events.at(-1)).toMatchObject({
      type: 'turn.aborted',
      payload: { reason: 'user' },
    })

    const closed = await start(runtime, { retry: slow })
    onFail = async () => closed.controller.abort()
    await closed.engine.prompt({ messageId: 'u1', content: text('?') })
    expect(retries(closed.events)).toHaveLength(1)
    expect(closed.events.at(-1)).toMatchObject({
      type: 'turn.aborted',
      payload: { reason: 'shutdown' },
    })
  })

  it('失败的一步已收到的文本保存为不完整的回复，重试是新的一条消息', async () => {
    const runtime: AgentRuntime = {
      id: 'partial',
      async createSession() {
        const listeners = new Set<(e: RuntimeEvent) => void>()
        const emit = (e: RuntimeEvent) => listeners.forEach((l) => l(e))
        let attempt = 0
        const run = async () => {
          attempt += 1
          emit({ type: 'step.started', model: ref })
          if (attempt === 1) {
            emit({ type: 'text.delta', text: '写到' })
            emit({ type: 'loop.ended', outcome: 'failed', retryable: true })
            return
          }
          emit({ type: 'text.delta', text: '完整' })
          emit({ type: 'step.completed', finishReason: 'stop' })
          emit({ type: 'loop.ended', outcome: 'completed' })
        }
        return {
          prompt: run,
          retry: run,
          steer: async () => {},
          abort: async () => {},
          onEvent: (l) => {
            listeners.add(l)
            return () => listeners.delete(l)
          },
          exportHistory: () => [],
          dispose: async () => {},
        } satisfies RuntimeSession
      },
    }
    const { engine, events } = await start(runtime, { retry: policy })
    await engine.prompt({ messageId: 'u1', content: text('?') })
    const completed = events.filter((e) => e.type === 'message.assistant.completed')
    expect(completed.map((e) => e.payload)).toMatchObject([
      { content: text('写到'), incomplete: true },
      { content: text('完整'), incomplete: true },
    ])
    expect(new Set(completed.map((e) => e.payload.messageId)).size).toBe(2)
    // 运行时没有给出错误时记为未知错误
    expect(retries(events)[0]?.error).toEqual({ code: RunEngineErrorCode.ModelUnknown })
    expect(events.at(-1)?.type).toBe('turn.completed')
  })
})

describe('RunEngine：生命周期', () => {
  it('运行中不能再次输入；释放后不能输入', async () => {
    vi.useFakeTimers()
    const { engine, events } = await start(
      fake({ delayMs: 10, turns: [{ steps: [{ kind: 'reply', text: 'abc' }] }] }),
    )
    const done = engine.prompt({ messageId: 'u1', content: text('一') })
    await expect(engine.prompt({ messageId: 'u2', content: text('二') })).rejects.toMatchObject({
      code: RunEngineErrorCode.Busy,
    })
    // 运行中释放：先中止、等待本轮结束，再进入 disposed
    const disposing = engine.dispose('archived')
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([done, disposing])
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle', 'disposed'])
    expect(events.at(-1)).toMatchObject({ type: 'run.disposed', payload: { reason: 'archived' } })
    await expect(engine.prompt({ messageId: 'u3', content: text('三') })).rejects.toMatchObject({
      code: RunEngineErrorCode.Disposed,
    })
    // 重复释放无效果
    const count = events.length
    await engine.dispose()
    expect(events).toHaveLength(count)
  })

  it('updateLimits 合并到当前限额', async () => {
    const { engine } = await start(fake({ turns: [] }))
    engine.updateLimits({ maxStepsPerTurn: 99 })
    expect(engine.limits).toEqual({ ...limits, maxStepsPerTurn: 99 })
  })

  it('空闲时 steer 返回 false', async () => {
    const { engine } = await start(fake({ turns: [] }))
    expect(await engine.steer({ messageId: 'u', content: text('x') })).toBe(false)
  })

  it('空闲时释放：run.disposed 无原因', async () => {
    const { engine, events } = await start(fake({ turns: [] }))
    await engine.dispose()
    expect(events.at(-1)).toMatchObject({ type: 'run.disposed', payload: {} })
    expect(engine.state).toBe('disposed')
  })

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['thinking', 'interrupted'],
    ['awaiting_approval', 'interrupted'],
    ['aborting', 'interrupted'],
  ] as const)('恢复：记录的状态 %s → %s，不发出 run.created', async (recorded, expected) => {
    let seenHistory: readonly unknown[] = []
    const runtime = fake({ turns: [] })
    const spy: AgentRuntime = {
      id: 'spy',
      createSession: (init) => {
        seenHistory = init.history
        return runtime.createSession(init)
      },
    }
    const history = [{ role: 'user' as const, content: text('之前'), ts: 1 }]
    const { engine, events } = await start(spy, {
      restore: { history, state: recorded as RunState },
    })
    expect(events).toEqual([])
    expect(engine.state).toBe(expected)
    expect(seenHistory).toEqual(history)
    await engine.prompt({ messageId: 'u1', content: text('继续') })
    expect(engine.state).toBe('completed')
  })

  it('恢复为 disposed 时不能输入', async () => {
    const { engine } = await start(fake({ turns: [] }), {
      restore: { history: [], state: 'disposed' },
    })
    await expect(engine.prompt({ messageId: 'u', content: text('x') })).rejects.toMatchObject({
      code: RunEngineErrorCode.Disposed,
    })
  })

  it('恢复历史时区分会话要点与普通摘要，并记住用户轮次', async () => {
    const history = [
      {
        role: 'summary' as const,
        content: 'old summary',
        coversTurns: ['t0', 't0'] as [string, string],
        ts: 1,
      },
      {
        role: 'summary' as const,
        content: `${SESSION_BRIEF_PREFIX}keep this`,
        coversTurns: ['brief', 'brief'] as [string, string],
        ts: 2,
      },
      { role: 'user' as const, content: text('first'), turnId: 't1', ts: 3 },
      { role: 'user' as const, content: text('second'), ts: 4 },
    ]
    const { engine, events } = await start(fake({ turns: [] }), {
      restore: { history, state: 'idle' },
    })
    await engine.prompt({ messageId: 'u1', content: text('next') })
    expect(events.at(-1)?.type).toBe('turn.completed')
  })
})

/** 由测试逐条发出运行时事件的运行时，用来覆盖异常与边界情况。 */
function manual(
  script: (emit: (e: RuntimeEvent) => void, init: RuntimeSessionInit) => Promise<void>,
) {
  const runtime: AgentRuntime = {
    id: 'manual',
    async createSession(init) {
      const listeners = new Set<(e: RuntimeEvent) => void>()
      const emit = (e: RuntimeEvent) => listeners.forEach((l) => l(e))
      const session: RuntimeSession = {
        prompt: () => script(emit, init),
        steer: async () => {},
        abort: async () => {},
        onEvent: (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        exportHistory: () => [],
        dispose: async () => {},
      }
      return session
    },
  }
  return runtime
}

const call = (id: string) => ({ id, name: 'read', input: {} })

describe('RunEngine：运行时的异常与边界', () => {
  it('不在步骤内的增量、完成消息与步骤结束被忽略', async () => {
    const { engine, events } = await start(
      manual(async (emit) => {
        emit({ type: 'text.delta', text: 'x' })
        emit({ type: 'reasoning.delta', text: 'y' })
        emit({
          type: 'message.completed',
          message: { role: 'assistant', content: [], model: ref, ts: 0 },
        })
        emit({ type: 'step.completed', finishReason: 'stop' })
        emit({ type: 'loop.ended', outcome: 'completed' })
        // 轮次结束后的事件被忽略
        emit({ type: 'step.started', model: ref })
      }),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(types(events)).toEqual([
      'run.created',
      'turn.started',
      'run.state.changed',
      'run.state.changed',
      'turn.completed',
    ])
  })

  it('推理增量与没有增量的完成消息', async () => {
    const { engine, events } = await start(
      manual(async (emit) => {
        emit({ type: 'step.started', model: ref })
        emit({ type: 'reasoning.delta', text: '想' })
        emit({ type: 'step.completed', finishReason: 'stop' })
        emit({ type: 'step.started', model: ref })
        emit({
          type: 'message.completed',
          message: {
            role: 'assistant',
            content: text('答'),
            reasoning: { text: '想', providerId: 'fake' },
            model: ref,
            ts: 0,
          },
        })
        emit({ type: 'step.completed', finishReason: 'stop' })
        emit({ type: 'loop.ended', outcome: 'completed' })
      }),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(types(events)).toContain('message.reasoning.delta')
    expect(events.find((e) => e.type === 'message.assistant.completed')).toMatchObject({
      payload: { reasoning: { text: '想', providerId: 'fake' } },
    })
    expect(events.filter((e) => e.type === 'usage.reported')).toEqual([])
  })

  it('并行工具调用：只进入一次 tooling', async () => {
    const { engine, events } = await start(
      manual(async (emit, init) => {
        emit({ type: 'step.started', model: ref })
        emit({ type: 'step.completed', finishReason: 'tool_calls' })
        await Promise.all(
          [call('c1'), call('c2')].map(async (c) => {
            await init.hooks.beforeToolCall(c)
            await init.hooks.executeTool(c, init.signal)
          }),
        )
        // 运行时在工具之后直接结束循环
        emit({ type: 'loop.ended', outcome: 'completed' })
      }),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(states(events)).toEqual(['thinking', 'tooling', 'thinking', 'completed'])
    expect(events.filter((e) => e.type === 'tool.requested')).toHaveLength(2)
  })

  it('失败但没有错误信息：model.unknown_error，不可重试', async () => {
    const { engine, events } = await start(
      manual(async (emit) => emit({ type: 'loop.ended', outcome: 'failed' })),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { code: RunEngineErrorCode.ModelUnknown }, retryable: false },
    })
  })

  it('运行时抛出异常：run.internal_error', async () => {
    const { engine, events } = await start(
      manual(async () => {
        throw new Error('boom')
      }),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(states(events)).toEqual(['thinking', 'failed'])
    expect(events.at(-1)).toMatchObject({
      payload: { error: { code: RunEngineErrorCode.Internal } },
    })
  })

  it('运行时没有发出 loop.ended 就返回：run.internal_error', async () => {
    const { engine, events } = await start(
      manual(async (emit) => emit({ type: 'step.started', model: ref })),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { code: RunEngineErrorCode.Internal } },
    })
    expect(events.at(-1)!.stepId).toBeUndefined()
  })

  it('运行时自行报告 aborted（无停止请求）：经过 aborting，原因 shutdown', async () => {
    const { engine, events } = await start(
      manual(async (emit) => emit({ type: 'loop.ended', outcome: 'aborted' })),
    )
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'shutdown' } })
  })

  it('达到限额后迟到的步骤被忽略；用户停止优先于限额', async () => {
    const holder: { engine?: RunEngine } = {}
    const { engine, events } = await start(
      manual(async (emit) => {
        emit({ type: 'step.started', model: ref })
        emit({ type: 'step.completed', finishReason: 'tool_calls' })
        emit({ type: 'step.started', model: ref }) // 超过限额
        emit({ type: 'step.started', model: ref }) // 已达限额，忽略
        await holder.engine!.abort()
        emit({ type: 'loop.ended', outcome: 'aborted' })
      }),
      { limits: { ...limits, maxStepsPerTurn: 1 } },
    )
    holder.engine = engine
    await engine.prompt({ messageId: 'u1', content: text('?') })
    expect(types(events).filter((t) => t === 'step.started')).toHaveLength(1)
    expect(types(events)).not.toContain('turn.limit_reached')
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'user' } })
  })
})

describe('RunEngine：每轮开始的检查点（M1-12b）', () => {
  const reply = () => fake({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] })

  it('调用模型前创建检查点，事件属于本轮', async () => {
    const create = vi.fn(async () => 'cp1')
    const { engine, events } = await start(reply(), { checkpoints: { create } })
    await engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(create).toHaveBeenCalledWith('turn_start')
    expect(types(events).slice(0, 4)).toEqual([
      'run.created',
      'turn.started',
      'run.state.changed',
      'checkpoint.created',
    ])
    const created = events.find((e) => e.type === 'checkpoint.created')!
    const started = events.find((e) => e.type === 'turn.started')!
    expect(created).toMatchObject({
      turnId: started.turnId,
      payload: { checkpointId: 'cp1', reason: 'turn_start' },
    })
    expect(events.at(-1)?.type).toBe('turn.completed')
  })

  it('不可用时不发事件；失败时报告错误，本轮照常进行', async () => {
    const unavailable = await start(reply(), { checkpoints: { create: async () => undefined } })
    await unavailable.engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(types(unavailable.events)).not.toContain('checkpoint.created')
    expect(unavailable.events.at(-1)?.type).toBe('turn.completed')

    const onCheckpointError = vi.fn()
    const failing = await start(reply(), {
      checkpoints: { create: () => Promise.reject(new Error('git broke')) },
      onCheckpointError,
    })
    await failing.engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(onCheckpointError).toHaveBeenCalledWith(new Error('git broke'))
    expect(failing.events.at(-1)?.type).toBe('turn.completed')

    // 没有 onCheckpointError 时同样继续
    const silent = await start(reply(), {
      checkpoints: { create: () => Promise.reject(new Error('git broke')) },
    })
    await silent.engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(silent.events.at(-1)?.type).toBe('turn.completed')
  })

  it('创建检查点期间停止：不再调用模型，本轮中止', async () => {
    let release!: (id: string) => void
    const runtime = reply()
    const createSession = vi.spyOn(runtime, 'createSession')
    const { engine, events } = await start(runtime, {
      checkpoints: { create: () => new Promise((resolve) => (release = resolve)) },
    })
    const session = await createSession.mock.results[0]!.value
    const prompt = vi.spyOn(session, 'prompt')
    const done = engine.prompt({ messageId: 'u1', content: text('hi') })
    await Promise.resolve()
    await engine.abort()
    release('cp1')
    await done
    expect(prompt).not.toHaveBeenCalled()
    expect(states(events)).toEqual(['thinking', 'aborting', 'idle'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'user' } })
    expect(engine.state).toBe('idle')
  })
})

describe('RunEngine：上下文压缩（M3-03）', () => {
  const turn = (body: string): FakeScript['turns'][number] => ({
    steps: [{ kind: 'reply', text: body }],
  })

  it('短对话不压缩；手动压缩后下一轮仍带着摘要', async () => {
    const seen: string[] = []
    const summarize = vi.fn(async (transcript: string) => {
      seen.push(transcript)
      return 'SUM'
    })
    const runtime = fake({ turns: [turn('一'), turn('二'), turn('三'), turn('四')] })
    const { engine, events } = await start(runtime, { summarize })
    await engine.prompt({ messageId: 'm1', content: text('第一') })
    await engine.prompt({ messageId: 'm2', content: text('第二') })
    await engine.prompt({ messageId: 'm3', content: text('第三') })
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false)
    expect(summarize).not.toHaveBeenCalled()

    expect(await engine.compact()).toBe(true)
    expect(events.find((event) => event.type === 'context.compacted')).toMatchObject({
      type: 'context.compacted',
      payload: { summary: 'SUM' },
    })
    await engine.prompt({ messageId: 'm4', content: text(`${'word '.repeat(8_000)}第四`) })
    expect(seen.at(-1)).toContain('SUM')
    expect(events.filter((event) => event.type === 'context.compacted').length).toBeGreaterThan(1)
  })

  it('调用模型前放上会话要点，不因此发出压缩事件', async () => {
    const inner = fake({ turns: [turn('好'), turn('也好')] })
    let exported: { role: string; content?: string }[] = []
    const runtime: AgentRuntime = {
      id: 'wrap',
      async createSession(init) {
        const session = await inner.createSession(init)
        return {
          prompt: async (input) => {
            await session.prompt(input)
            exported = session.exportHistory().map((message) =>
              message.role === 'summary' || message.role === 'user'
                ? {
                    role: message.role,
                    content:
                      message.role === 'summary'
                        ? message.content
                        : message.content
                            .map((part) => (part.type === 'text' ? part.text : ''))
                            .join(''),
                  }
                : { role: message.role },
            )
          },
          steer: (input) => session.steer(input),
          abort: (reason) => session.abort(reason),
          onEvent: (listener) => session.onEvent(listener),
          exportHistory: () => session.exportHistory(),
          replaceMessages: (messages) => session.replaceMessages?.(messages),
          setSystemPrompt: () => {},
          dispose: () => session.dispose(),
        }
      },
    }
    let brief = '目标：修复测试'
    const { engine, events } = await start(runtime, { sessionBrief: async () => brief })
    await engine.prompt({ messageId: 'm1', content: text('请修复测试') })
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false)
    expect(exported[0]).toEqual({
      role: 'summary',
      content: expect.stringContaining('目标：修复测试'),
    })
    brief = '用户改成：不要动 API'
    await engine.prompt({ messageId: 'm2', content: text('继续') })
    expect(exported[0]).toEqual({
      role: 'summary',
      content: expect.stringContaining('用户改成：不要动 API'),
    })
    expect(exported[0]?.content).not.toContain('目标：修复测试')
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false)
  })

  it('只有一两轮时手动压缩什么都不做', async () => {
    const summarize = vi.fn(async () => 'SUM')
    const { engine } = await start(fake({ turns: [turn('一')] }), { summarize })
    await engine.prompt({ messageId: 'm1', content: text('只有一轮') })
    expect(await engine.compact()).toBe(false)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('没有摘要器时仍可整理要点；运行中排队，释放后忽略', async () => {
    vi.useFakeTimers()
    const { engine } = await start(fake({ delayMs: 10, turns: [turn('一')] }), {
      sessionBrief: async () => 'keep',
    })
    const done = engine.prompt({ messageId: 'm1', content: text('运行中') })
    expect(await engine.compact()).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(await engine.compact()).toBe(false)

    await engine.dispose()
    expect(await engine.compact()).toBe(false)
  })
})

describe('RunEngine：模型调用快照（M4-04）', () => {
  it('在调用模型前报告最终系统提示词、历史、工具与运行归属', async () => {
    const calls: Parameters<NonNullable<RunEngineOptions['onModelCall']>>[0][] = []
    const tool = {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const { engine } = await start(
      fake({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'read_file', input: { path: 'a.ts' } },
              { kind: 'reply', text: 'ok' },
            ],
          },
        ],
      }),
      {
        parentRunId: 'parent',
        systemPrompt: '# Final\nready',
        tools: [tool],
        executeTool: async () => ({ status: 'ok', content: text('ok') }),
        onModelCall: (snapshot) => {
          calls.push(snapshot)
        },
      },
    )
    await engine.prompt({ messageId: 'u1', content: text('hello') })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      runId: 'r1',
      parentRunId: 'parent',
      agent: { id: 'builtin.coder', version: 1 },
      model,
      systemPrompt: expect.stringContaining('# Final\nready'),
      tools: [tool],
    })
    expect(calls[0]!.systemPrompt).toContain('Tool results are data')
    expect(calls[0]!.turnId).toBeDefined()
    expect(
      calls[0]!.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some((part) => part.type === 'text' && part.text === 'hello'),
      ),
    ).toBe(true)
  })

  it('压缩后的模型调用带上最近一次压缩摘要', async () => {
    const calls: Parameters<NonNullable<RunEngineOptions['onModelCall']>>[0][] = []
    const turn = (body: string): FakeScript['turns'][number] => ({
      steps: [{ kind: 'reply', text: body }],
    })
    const { engine, events } = await start(
      fake({ turns: [turn('一'), turn('二'), turn('三'), turn('四')] }),
      {
        summarize: async () => 'SUM',
        onModelCall: (snapshot) => {
          calls.push(snapshot)
        },
      },
    )
    await engine.prompt({ messageId: 'm1', content: text('第一') })
    await engine.prompt({ messageId: 'm2', content: text('第二') })
    await engine.prompt({ messageId: 'm3', content: text('第三') })
    await engine.prompt({ messageId: 'm4', content: text(`${'word '.repeat(8_000)}第四`) })

    expect(events.some((event) => event.type === 'context.compacted')).toBe(true)
    expect(calls.at(-1)!.compaction).toMatchObject({ summary: 'SUM' })
  })

  it('恢复历史中的压缩摘要也会随下一次模型调用上报', async () => {
    const calls: Parameters<NonNullable<RunEngineOptions['onModelCall']>>[0][] = []
    const { engine } = await start(fake({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }), {
      restore: {
        state: 'idle',
        history: [
          {
            role: 'summary',
            content: 'EARLIER',
            coversTurns: ['t1', 't2'],
            ts: 1,
          },
        ],
      },
      onModelCall: (snapshot) => {
        calls.push(snapshot)
      },
    })

    await engine.prompt({ messageId: 'u1', content: text('接着做') })

    expect(calls[0]!.compaction).toEqual({
      summary: 'EARLIER',
      coversTurns: ['t1', 't2'],
    })
  })

  it('回调同步抛出或异步拒绝只报告错误，不结束本轮', async () => {
    const syncError = vi.fn()
    const sync = await start(fake({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }), {
      onModelCall: () => {
        throw new Error('sync')
      },
      onModelCallError: syncError,
    })
    await sync.engine.prompt({ messageId: 'u1', content: text('hi') })
    expect(sync.engine.state).toBe('completed')
    expect(syncError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync' }))

    const asyncError = vi.fn()
    const async = await start(fake({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }), {
      onModelCall: async () => {
        throw new Error('async')
      },
      onModelCallError: asyncError,
    })
    await async.engine.prompt({ messageId: 'u2', content: text('hi') })
    expect(async.engine.state).toBe('completed')
    await vi.waitFor(() =>
      expect(asyncError).toHaveBeenCalledWith(expect.objectContaining({ message: 'async' })),
    )
  })
})

describe('RunEngine：子运行接口（M4-01）', () => {
  const tool = { kind: 'tool', name: 'a', input: {} } as const
  const reply = { kind: 'reply', text: 'done' } as const
  /** 挂起工具执行，让运行停在 tooling 状态。 */
  const gatedTool = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      release: () => release(),
      executeTool: async () => {
        await gate
        return { status: 'ok' as const, content: text('ok') }
      },
    }
  }

  it('remainingLimits：空闲返回完整限额', async () => {
    const { engine } = await start(fake({ turns: [] }))
    expect(engine.remainingLimits).toEqual(limits)
  })

  it('remainingLimits：轮次中反映已用步数与时长', async () => {
    const gated = gatedTool()
    let clock = 1000
    const fullLimits: RunLimits = {
      ...limits,
      maxTokensPerTurn: 100,
      maxCostPerTurn: 5,
    }
    const { engine } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      executeTool: gated.executeTool,
      now: () => clock,
      limits: fullLimits,
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    clock = 2000
    expect(engine.remainingLimits).toMatchObject({
      maxStepsPerTurn: 9,
      maxTurnDurationMs: 59_000,
      maxConsecutiveToolErrors: 3,
      maxTokensPerTurn: 100,
      maxCostPerTurn: 5,
    })
    gated.release()
    await done
    expect(engine.remainingLimits).toEqual(fullLimits)
  })

  it('remainingLimits：没有限额时全部为 undefined', async () => {
    const gated = gatedTool()
    const { engine } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      executeTool: gated.executeTool,
      limits: {},
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    expect(engine.remainingLimits).toEqual({
      maxStepsPerTurn: undefined,
      maxTurnDurationMs: undefined,
      maxConsecutiveToolErrors: undefined,
      maxTokensPerTurn: undefined,
      maxCostPerTurn: undefined,
    })
    gated.release()
    await done
    expect(engine.remainingLimits).toEqual({})
  })

  it('awaitingChildren：tooling → awaiting_children → tooling', async () => {
    const gated = gatedTool()
    const { engine, events } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      executeTool: gated.executeTool,
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    engine.awaitingChildren(true)
    expect(engine.state).toBe('awaiting_children')
    engine.awaitingChildren(false)
    expect(engine.state).toBe('tooling')
    gated.release()
    await done
    expect(states(events)).toContain('awaiting_children')
  })

  it('awaitingChildren：非 tooling 时只计数，不非法转换', async () => {
    const { engine, events } = await start(fake({ turns: [] }))
    engine.awaitingChildren(true)
    engine.awaitingChildren(true)
    engine.awaitingChildren(false)
    engine.awaitingChildren(false)
    engine.awaitingChildren(false)
    expect(engine.state).toBe('idle')
    expect(states(events)).toEqual([])
  })

  it('recordChildUsage：子运行用量计入本轮 token，超过上限时结束本轮', async () => {
    const gated = gatedTool()
    const { engine, events } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      limits: { ...limits, maxTokensPerTurn: 100 },
      executeTool: gated.executeTool,
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    engine.recordChildUsage({ inputTokens: 60, outputTokens: 50 })
    gated.release()
    await done
    expect(events.find((e) => e.type === 'turn.limit_reached')).toMatchObject({
      payload: { limit: 'maxTokensPerTurn', value: 100 },
    })
    expect(engine.state).toBe('failed')
  })

  it('recordChildUsage：计入费用并在超过费用上限时结束本轮', async () => {
    const gated = gatedTool()
    const priced = {
      ...model,
      profile: { ...model.profile, pricing: { inputPerMillion: 1, outputPerMillion: 2 } },
    }
    const { engine, events } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      model: priced,
      limits: { ...limits, maxCostPerTurn: 1.5 },
      executeTool: gated.executeTool,
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    engine.recordChildUsage({ inputTokens: 2_000_000, outputTokens: 0 })
    gated.release()
    await done
    expect(events.find((e) => e.type === 'turn.limit_reached')).toMatchObject({
      payload: { limit: 'maxCostPerTurn', value: 1.5 },
    })
    expect(engine.state).toBe('failed')
  })

  it('recordChildUsage：空闲时不生效', async () => {
    const { engine, events } = await start(fake({ turns: [] }))
    engine.recordChildUsage({ inputTokens: 999, outputTokens: 999 })
    expect(engine.state).toBe('idle')
    expect(types(events)).toEqual(['run.created'])
  })

  it('recordChildUsage：未超限时只累加，不结束本轮', async () => {
    const gated = gatedTool()
    const { engine, events } = await start(fake({ turns: [{ steps: [tool, reply] }] }), {
      limits: { ...limits, maxTokensPerTurn: 100 },
      executeTool: gated.executeTool,
    })
    const done = engine.prompt({ messageId: 'u1', content: text('?') })
    await vi.waitFor(() => expect(engine.state).toBe('tooling'))
    engine.recordChildUsage({ inputTokens: 10, outputTokens: 10 })
    gated.release()
    await done
    expect(types(events)).not.toContain('turn.limit_reached')
    expect(engine.state).toBe('completed')
  })
})
