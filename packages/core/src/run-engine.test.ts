import {
  isPersistedEvent,
  type EventEnvelope,
  type ModelRef,
  type RunLimits,
  type RunState,
  type UnsequencedEvent,
} from '@nexus/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FakeRuntime,
  RunEngine,
  RunEngineErrorCode,
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
    expect(types(events)).not.toContain('message.assistant.completed')
    expect(engine.state).toBe('idle')

    const view = reduceSessionEvents(createSessionView('s1'), sequenced('?', events))
    expect(view.live).toEqual({})
    expect(view.runs.r1?.turn?.status).toBe('aborted')
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
