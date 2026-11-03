import type { EventEnvelope, EventPayload, EventType, TokenUsage } from '@nexus/protocol'
import { describe, expect, it } from 'vitest'
import {
  createSessionView,
  reduceSession,
  reduceSessionEvents,
  rootRun,
  sessionStatus,
  type SessionView,
} from './index.js'

const SID = 's1'
const RUN = 'r1'
const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

interface Header {
  runId?: string
  parentRunId?: string
  turnId?: string
  stepId?: string
  sessionId?: string
}

/** 事件构造器：seq 自动递增，ts = seq * 10。 */
function stream() {
  let seq = 0
  return function ev<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    header: Header = {},
  ): EventEnvelope<T> {
    seq += 1
    const { runId = RUN, sessionId = SID, ...rest } = header
    return { v: 1, sessionId, runId, ...rest, seq, ts: seq * 10, type, payload } as EventEnvelope<T>
  }
}

/** 一轮完整对话：会话创建 → 运行 → 用户消息 → 一步 → 回复 → 完成。 */
function happyPath() {
  const ev = stream()
  const t = { turnId: 't1' }
  const s = { turnId: 't1', stepId: 'st1' }
  return [
    ev('session.created', {
      projectId: 'p1',
      projectPath: '/code/demo',
      workspacePath: '/code/demo',
      title: '新会话',
    }),
    ev('run.created', {
      agent: { id: 'builtin.coder', version: 1 },
      model,
      mode: 'interactive',
      limits,
    }),
    ev('message.user', { messageId: 'm1', content: text('你好') }, t),
    ev('turn.started', {}, t),
    ev('run.state.changed', { from: 'idle', to: 'thinking' }, t),
    ev('step.started', { model }, s),
    ev('message.assistant.delta', { messageId: 'm2', text: '你' }, s),
    ev('message.assistant.completed', { messageId: 'm2', content: text('你好！'), model }, s),
    ev(
      'step.completed',
      { model, finishReason: 'stop', durationMs: 5, usage: { inputTokens: 1, outputTokens: 1 } },
      s,
    ),
    ev('usage.reported', { model, usage: { inputTokens: 10, outputTokens: 3 } }, t),
    ev('run.state.changed', { from: 'thinking', to: 'completed' }, t),
    ev('turn.completed', { durationMs: 70 }, t),
  ]
}

const reduceAll = (events: readonly EventEnvelope[]) =>
  reduceSessionEvents(createSessionView(SID), events)

/** 构造到某一轮正在进行的状态，返回视图和后续事件构造器。 */
function midTurn(): { view: SessionView; ev: ReturnType<typeof stream> } {
  const ev = stream()
  const view = reduceAll([
    ev('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
    ev('turn.started', {}, { turnId: 't1' }),
    ev('run.state.changed', { from: 'idle', to: 'thinking' }, { turnId: 't1' }),
  ])
  return { view, ev }
}

describe('createSessionView', () => {
  it('初始为空', () => {
    expect(createSessionView(SID)).toEqual({
      sessionId: SID,
      lastSeq: 0,
      info: undefined,
      archived: false,
      crash: undefined,
      runs: {},
      runOrder: [],
      messages: [],
      live: {},
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })
})

describe('reduceSession：一轮完整对话', () => {
  const events = happyPath()
  const view = reduceAll(events)

  it('会话信息', () => {
    expect(view.info).toEqual({
      projectId: 'p1',
      projectPath: '/code/demo',
      workspacePath: '/code/demo',
      title: '新会话',
      createdAt: 10,
    })
    expect(view.lastSeq).toBe(events.length)
  })

  it('消息列表', () => {
    expect(view.messages).toEqual([
      {
        role: 'user',
        messageId: 'm1',
        runId: RUN,
        turnId: 't1',
        seq: 3,
        ts: 30,
        content: text('你好'),
      },
      {
        role: 'assistant',
        messageId: 'm2',
        runId: RUN,
        turnId: 't1',
        seq: 8,
        ts: 80,
        content: text('你好！'),
        reasoning: undefined,
        toolCalls: [],
        model,
        incomplete: false,
      },
    ])
  })

  it('运行、轮次与步骤', () => {
    const run = view.runs[RUN]
    expect(view.runOrder).toEqual([RUN])
    expect(run).toMatchObject({
      runId: RUN,
      parentRunId: undefined,
      agent: { id: 'builtin.coder', version: 1 },
      mode: 'interactive',
      limits,
      state: 'completed',
      createdAt: 20,
    })
    expect(run?.turn).toEqual({
      turnId: 't1',
      status: 'completed',
      startedAt: 40,
      endedAt: 120,
      stepCount: 1,
      step: {
        stepId: 'st1',
        model,
        status: 'completed',
        startedAt: 60,
        finishReason: 'stop',
        durationMs: 5,
      },
      durationMs: 70,
      abortReason: undefined,
      error: undefined,
      retryable: undefined,
      limitReached: undefined,
    })
  })

  it('用量只统计 usage.reported', () => {
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 3 })
    expect(view.runs[RUN]?.usage).toEqual({ inputTokens: 10, outputTokens: 3 })
  })

  it('sessionStatus 为 idle', () => {
    expect(sessionStatus(view)).toBe('idle')
  })
})

describe('reduceSession：幂等与乱序', () => {
  const events = happyPath()
  const view = reduceAll(events)

  it('重复归约全部事件结果不变且返回原对象', () => {
    expect(reduceSessionEvents(view, events)).toBe(view)
  })

  it('补发与实时重叠时不产生重复消息', () => {
    const half = reduceAll(events.slice(0, 8))
    const resumed = reduceSessionEvents(half, events.slice(4))
    expect(resumed).toEqual(view)
  })

  it('seq 不大于 lastSeq 的迟到事件被忽略', () => {
    const late = { ...events[2]!, seq: 1 } as EventEnvelope
    expect(reduceSession(view, late)).toBe(view)
  })

  it('其他会话的事件被忽略', () => {
    const other = stream()('session.archived', {}, { sessionId: 'other' })
    expect(reduceSession(createSessionView(SID), other)).toEqual(createSessionView(SID))
  })

  it('增量事件不推进 lastSeq', () => {
    const delta = events.find((e) => e.type === 'message.assistant.delta')!
    const before = reduceAll(events.slice(0, 6))
    expect(reduceSession(before, delta).lastSeq).toBe(before.lastSeq)
  })

  it('不认识的运行：事件只推进 lastSeq', () => {
    const ev = stream()
    const start = createSessionView(SID)
    const events2 = [
      ev('run.state.changed', { from: 'idle', to: 'thinking' }),
      ev('run.disposed', {}),
      ev('turn.started', {}, { turnId: 't1' }),
      ev('step.started', { model }, { turnId: 't1', stepId: 'st1' }),
      ev('usage.reported', { model, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]
    const view2 = reduceSessionEvents(start, events2)
    expect(view2.runs).toEqual({})
    expect(view2.lastSeq).toBe(5)
    // 会话级用量仍然统计。
    expect(view2.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  it('未处理的事件类型只推进 lastSeq', () => {
    const { view: v, ev } = midTurn()
    const next = reduceSession(v, ev('tool.started', { toolCallId: 'c1' }, { turnId: 't1' }))
    expect(next).toEqual({ ...v, lastSeq: v.lastSeq + 1 })
  })
})

describe('reduceSession：会话事件', () => {
  it('重命名、归档、重复创建', () => {
    const ev = stream()
    const created = {
      projectId: 'p',
      projectPath: '/a',
      workspacePath: '/a',
      title: '旧',
    }
    const view = reduceAll([
      ev('session.renamed', { title: '太早' }),
      ev('session.created', created),
      ev('session.created', { ...created, title: '重复' }),
      ev('session.renamed', { title: '新' }),
      ev('session.archived', {}),
    ])
    expect(view.info?.title).toBe('新')
    expect(view.info?.createdAt).toBe(20)
    expect(view.archived).toBe(true)
    expect(sessionStatus(view)).toBe('archived')
  })

  it('崩溃后显示 crashed，开始新一轮时清除', () => {
    const { view, ev } = midTurn()
    const crashed = reduceSession(view, ev('session.crashed', { error: { code: 'host.crashed' } }))
    expect(crashed.crash).toEqual({ code: 'host.crashed' })
    expect(sessionStatus(crashed)).toBe('crashed')
    const resumed = reduceSessionEvents(crashed, [
      ev('run.state.changed', { from: 'thinking', to: 'interrupted' }, { turnId: 't1' }),
      ev('turn.started', {}, { turnId: 't2' }),
    ])
    expect(resumed.crash).toBeUndefined()
    expect(resumed.runs[RUN]?.turn?.turnId).toBe('t2')
  })
})

describe('reduceSession：运行', () => {
  it('重复的 run.created 被忽略', () => {
    const { view, ev } = midTurn()
    const dup = ev('run.created', {
      agent: { id: 'b', version: 2 },
      model,
      mode: 'unattended',
      limits,
    })
    const next = reduceSession(view, dup)
    expect(next.runs).toBe(view.runs)
    expect(next.runOrder).toEqual([RUN])
  })

  it('非法状态转换被忽略', () => {
    const { view, ev } = midTurn()
    const next = reduceSession(view, ev('run.state.changed', { from: 'thinking', to: 'disposed' }))
    expect(next.runs[RUN]?.state).toBe('thinking')
  })

  it('run.disposed 使运行进入终态，重复时忽略', () => {
    const { view, ev } = midTurn()
    const disposed = reduceSession(view, ev('run.disposed', {}))
    expect(disposed.runs[RUN]?.state).toBe('disposed')
    const again = reduceSession(disposed, ev('run.disposed', {}))
    expect(again.runs).toBe(disposed.runs)
  })

  it('子运行记录 parentRunId，sessionStatus 以顶层运行为准', () => {
    const { view, ev } = midTurn()
    const next = reduceSessionEvents(view, [
      ev(
        'run.created',
        { agent: { id: 'x', version: 1 }, model, mode: 'unattended', limits },
        { runId: 'child', parentRunId: RUN },
      ),
      ev('turn.started', {}, { runId: 'child', turnId: 'ct' }),
      ev('run.state.changed', { from: 'idle', to: 'thinking' }, { runId: 'child', turnId: 'ct' }),
    ])
    expect(next.runOrder).toEqual([RUN, 'child'])
    expect(next.runs.child?.parentRunId).toBe(RUN)
    expect(rootRun(next)?.runId).toBe(RUN)
    expect(sessionStatus(next)).toBe('running')
  })

  it.each([
    [['thinking'], 'running'],
    [['thinking', 'tooling'], 'running'],
    [['thinking', 'tooling', 'awaiting_children'], 'running'],
    [['thinking', 'aborting'], 'running'],
    [['thinking', 'tooling', 'awaiting_approval'], 'waiting_approval'],
    [['thinking', 'failed'], 'failed'],
    [['thinking', 'interrupted'], 'interrupted'],
    [['thinking', 'completed'], 'idle'],
    [['thinking', 'aborting', 'idle'], 'idle'],
    [['disposed'], 'idle'],
  ] as const)('sessionStatus：状态经过 %j 后为 %s', (path, expected) => {
    const ev = stream()
    let from: string = 'idle'
    const events: EventEnvelope[] = [
      ev('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
    ]
    for (const to of path) {
      events.push(ev('run.state.changed', { from, to } as EventPayload<'run.state.changed'>))
      from = to
    }
    const view = reduceAll(events)
    expect(view.runs[RUN]?.state).toBe(path.at(-1))
    expect(sessionStatus(view)).toBe(expected)
  })

  it('没有运行时 sessionStatus 为 idle', () => {
    expect(rootRun(createSessionView(SID))).toBeUndefined()
    expect(sessionStatus(createSessionView(SID))).toBe('idle')
  })
})

describe('reduceSession：轮次', () => {
  it('缺少 turnId 的 turn.started 被忽略', () => {
    const { view, ev } = midTurn()
    const next = reduceSession(view, ev('turn.started', {}))
    expect(next.runs).toBe(view.runs)
  })

  it('重复的 turn.started 不会重置轮次', () => {
    const { view, ev } = midTurn()
    const withStep = reduceSession(
      view,
      ev('step.started', { model }, { turnId: 't1', stepId: 'a' }),
    )
    const next = reduceSession(withStep, ev('turn.started', {}, { turnId: 't1' }))
    expect(next.runs).toBe(withStep.runs)
    expect(next.runs[RUN]?.turn?.stepCount).toBe(1)
  })

  it('中止', () => {
    const { view, ev } = midTurn()
    const next = reduceSession(view, ev('turn.aborted', { reason: 'user' }, { turnId: 't1' }))
    expect(next.runs[RUN]?.turn).toMatchObject({
      status: 'aborted',
      abortReason: 'user',
      endedAt: 40,
    })
  })

  it('限额后失败', () => {
    const { view, ev } = midTurn()
    const err = { code: 'run.limit.steps' }
    const next = reduceSessionEvents(view, [
      ev('turn.limit_reached', { limit: 'maxStepsPerTurn', value: 50 }, { turnId: 't1' }),
      ev('turn.failed', { error: err, retryable: false }, { turnId: 't1' }),
    ])
    expect(next.runs[RUN]?.turn).toMatchObject({
      status: 'failed',
      error: err,
      retryable: false,
      limitReached: { limit: 'maxStepsPerTurn', value: 50 },
    })
  })

  it('已结束的轮次不再接受结束、限额与步骤事件', () => {
    const { view, ev } = midTurn()
    const done = reduceSession(view, ev('turn.completed', { durationMs: 1 }, { turnId: 't1' }))
    const after = reduceSessionEvents(done, [
      ev('turn.failed', { error: { code: 'x' }, retryable: true }, { turnId: 't1' }),
      ev('turn.aborted', { reason: 'user' }, { turnId: 't1' }),
      ev('turn.limit_reached', { limit: 'maxStepsPerTurn', value: 1 }, { turnId: 't1' }),
      ev('step.started', { model }, { turnId: 't1', stepId: 'late' }),
    ])
    expect(after.runs).toBe(done.runs)
  })

  it('不属于当前轮次的事件被忽略', () => {
    const { view, ev } = midTurn()
    const next = reduceSessionEvents(view, [
      ev('turn.completed', { durationMs: 1 }, { turnId: 'old' }),
      ev('step.started', { model }, { turnId: 'old', stepId: 'x' }),
      ev('turn.aborted', { reason: 'user' }),
    ])
    expect(next.runs).toBe(view.runs)
  })

  it('还没有轮次时轮次事件被忽略', () => {
    const ev = stream()
    const view = reduceAll([
      ev('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
    ])
    const next = reduceSession(view, ev('turn.completed', { durationMs: 1 }, { turnId: 't1' }))
    expect(next.runs).toBe(view.runs)
  })
})

describe('reduceSession：步骤', () => {
  it('多个步骤计数，当前步骤为最后一个', () => {
    const { view, ev } = midTurn()
    const s1 = { turnId: 't1', stepId: 'a' }
    const s2 = { turnId: 't1', stepId: 'b' }
    const next = reduceSessionEvents(view, [
      ev('step.started', { model }, s1),
      ev('step.completed', { model, finishReason: 'tool_calls', durationMs: 3 }, s1),
      ev('step.started', { model }, s2),
    ])
    expect(next.runs[RUN]?.turn?.stepCount).toBe(2)
    expect(next.runs[RUN]?.turn?.step).toMatchObject({ stepId: 'b', status: 'running' })
  })

  it('无效的步骤事件被忽略', () => {
    const { view, ev } = midTurn()
    const s1 = { turnId: 't1', stepId: 'a' }
    const started = reduceSession(view, ev('step.started', { model }, s1))
    const done = reduceSession(
      started,
      ev('step.completed', { model, finishReason: 'stop', durationMs: 1 }, s1),
    )
    const ignored = reduceSessionEvents(done, [
      // 缺少 stepId
      ev('step.started', { model }, { turnId: 't1' }),
      // 重复开始同一步骤
      ev('step.started', { model }, s1),
      // 重复完成
      ev('step.completed', { model, finishReason: 'stop', durationMs: 1 }, s1),
      // 不是当前步骤
      ev(
        'step.completed',
        { model, finishReason: 'stop', durationMs: 1 },
        { turnId: 't1', stepId: 'z' },
      ),
    ])
    expect(ignored.runs).toBe(done.runs)
    const noStep = reduceSession(
      view,
      ev('step.completed', { model, finishReason: 'stop', durationMs: 1 }, s1),
    )
    expect(noStep.runs).toBe(view.runs)
  })
})

describe('reduceSession：消息', () => {
  it('同一 messageId 原位替换，保留推理与工具调用', () => {
    const { view, ev } = midTurn()
    const s = { turnId: 't1', stepId: 'a' }
    const call = { id: 'c1', name: 'read', input: { path: 'a.ts' } }
    const next = reduceSessionEvents(view, [
      ev('message.assistant.completed', { messageId: 'm2', content: text('旧'), model }, s),
      ev('message.user', { messageId: 'm3', content: text('后') }, s),
      ev(
        'message.assistant.completed',
        {
          messageId: 'm2',
          content: text('新'),
          model,
          reasoning: { text: '想', providerId: 'fake' },
          toolCalls: [call],
        },
        s,
      ),
    ])
    expect(next.messages.map((m) => m.messageId)).toEqual(['m2', 'm3'])
    expect(next.messages[0]).toMatchObject({
      role: 'assistant',
      content: text('新'),
      reasoning: { text: '想', providerId: 'fake' },
      toolCalls: [call],
      seq: 6,
    })
  })
})

describe('用量累加', () => {
  const usageOf = (...items: TokenUsage[]) => {
    const ev = stream()
    return reduceAll([
      ev('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
      ...items.map((usage) => ev('usage.reported', { model, usage })),
    ]).usage
  }

  it('可选字段只在出现过时累加', () => {
    expect(
      usageOf({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
    })
    expect(
      usageOf(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 5 },
        { inputTokens: 1, outputTokens: 1, reasoningTokens: 7 },
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 },
      ),
    ).toEqual({ inputTokens: 3, outputTokens: 3, cacheReadTokens: 6, reasoningTokens: 7 })
  })
})
