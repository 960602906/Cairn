import type { EventEnvelope, EventPayload, EventType, TokenUsage } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  createSessionView,
  MAX_LIVE_TOOL_OUTPUT_CHARS,
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
      tools: {},
      liveToolOutput: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      usageByTurn: {},
      contextTokens: undefined,
      checkpoints: [],
      restores: [],
    })
  })
})

describe('reduceSession：检查点与恢复（M2-08）', () => {
  it('按顺序记录检查点与恢复', () => {
    const ev = stream()
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const view = reduceAll([
      ev('checkpoint.created', { checkpointId: a, reason: 'turn_start' }, { turnId: 't1' }),
      ev('checkpoint.created', { checkpointId: b, reason: 'before_restore' }, { runId: SID }),
      ev('checkpoint.restored', { checkpointId: a, truncateConversation: false }, { runId: SID }),
    ])
    expect(view.checkpoints).toEqual([
      { checkpointId: a, reason: 'turn_start', seq: 1, runId: RUN, turnId: 't1', createdAt: 10 },
      {
        checkpointId: b,
        reason: 'before_restore',
        seq: 2,
        runId: SID,
        turnId: undefined,
        createdAt: 20,
      },
    ])
    expect(view.restores).toEqual([{ checkpointId: a, seq: 3, ts: 30 }])
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
      retry: undefined,
    })
  })

  it('用量只统计 usage.reported', () => {
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 3 })
    expect(view.runs[RUN]?.usage).toEqual({ inputTokens: 10, outputTokens: 3 })
  })

  it('按轮次累计用量（M2-03）', () => {
    const turns = Object.keys(view.usageByTurn)
    expect(turns).toHaveLength(1)
    expect(view.usageByTurn[turns[0]!]).toEqual({ inputTokens: 10, outputTokens: 3 })
  })

  it('上下文占用取最近一次用量（M2-04）', () => {
    expect(view.contextTokens).toBe(13)
  })

  it('辅助模型用量计入统计但不改上下文圆环（M3-01）', () => {
    const auxiliary = {
      v: 1 as const,
      sessionId: SID,
      runId: RUN,
      turnId: 't1',
      seq: view.lastSeq + 1,
      ts: view.lastSeq * 10 + 10,
      type: 'usage.reported' as const,
      payload: {
        model,
        usage: { inputTokens: 4, outputTokens: 2 },
        auxiliary: true as const,
      },
    }
    const next = reduceSession(view, auxiliary)
    expect(next.contextTokens).toBe(13)
    expect(next.usage).toEqual({ inputTokens: 14, outputTokens: 5 })
    expect(next.runs[RUN]?.usage).toEqual({ inputTokens: 14, outputTokens: 5 })
    expect(next.usageByTurn['t1']).toEqual({ inputTokens: 14, outputTokens: 5 })

    const alone = reduceSession(createSessionView(SID), { ...auxiliary, seq: 1 })
    expect(alone.contextTokens).toBeUndefined()
    expect(alone.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
  })

  it('压缩后圆环立刻下降，消息仍在，失败提示只出现一次（M3-03）', () => {
    const base = {
      v: 1 as const,
      sessionId: SID,
      runId: RUN,
      turnId: 't1',
      ts: 1,
    }
    const compacted = reduceSession(view, {
      ...base,
      seq: view.lastSeq + 1,
      type: 'context.compacted',
      payload: {
        summary: '只剩目标',
        coversTurns: ['t1', 't1'] as [string, string],
        tokensAfter: 40,
      },
    })
    expect(compacted.compaction).toEqual({ summary: '只剩目标', seq: view.lastSeq + 1 })
    expect(compacted.contextTokens).toBe(40)
    expect(compacted.messages).toBe(view.messages)

    const firstDrop = reduceSession(view, {
      ...base,
      seq: view.lastSeq + 2,
      type: 'context.compacted',
      payload: {
        summary: '',
        coversTurns: ['t1', 't1'] as [string, string],
        degraded: true,
        omittedToolCallIds: ['c1'],
        tokensAfter: 20,
      },
    })
    expect(firstDrop.toolOutputOmitted).toEqual({ seq: view.lastSeq + 2 })
    expect(firstDrop.compaction).toBeUndefined()
    const again = reduceSession(firstDrop, {
      ...base,
      seq: view.lastSeq + 3,
      type: 'context.compacted',
      payload: { summary: '', coversTurns: ['t1', 't1'] as [string, string], degraded: true },
    })
    expect(again.toolOutputOmitted).toEqual({ seq: view.lastSeq + 2 })
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
    // 会话级用量仍然统计；没有 turnId 的用量不计入任何一轮。
    expect(view2.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
    expect(view2.usageByTurn).toEqual({})
  })

  it('未处理的事件类型只推进 lastSeq', () => {
    const { view: v, ev } = midTurn()
    const next = reduceSession(
      v,
      ev(
        'approval.requested',
        { approvalId: 'a1', toolCallId: 'c1', matchedRuleIds: [], reasonCode: 'rule.ask' },
        { turnId: 't1' },
      ),
    )
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
      ev('session.model.changed', { model: { providerId: 'p', modelId: 'm2' } }),
      ev('session.archived', {}),
    ])
    expect(view.info?.title).toBe('新')
    expect(view.info?.model).toEqual({ providerId: 'p', modelId: 'm2' })
    expect(view.info?.createdAt).toBe(20)
    expect(view.archived).toBe(true)
    expect(sessionStatus(view)).toBe('archived')
    const early = reduceAll([
      ev('session.model.changed', { model: { providerId: 'p', modelId: 'm' } }),
    ])
    expect(early.info).toBeUndefined()
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

  it('记录本轮读到的 AGENTS.md，下一轮没读到就清掉', () => {
    const { view, ev } = midTurn()
    const agentsMd = { sha256: 'a'.repeat(64), bytes: 12, truncated: false, lines: 3 }
    const loaded = reduceSession(
      view,
      ev('turn.started', { context: { agentsMd } }, { turnId: 't2' }),
    )
    expect(loaded.agentsMd).toEqual({ lines: 3, truncated: false })
    const cleared = reduceSession(loaded, ev('turn.started', {}, { turnId: 't3' }))
    expect(cleared.agentsMd).toBeUndefined()
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

  it('等待重试：下一步开始或轮次结束时清除', () => {
    const { view, ev } = midTurn()
    const err = { code: 'model.rate_limited' }
    const waiting = reduceSession(
      view,
      ev('model.retry', { attempt: 1, maxRetries: 3, delayMs: 1000, error: err }, { turnId: 't1' }),
    )
    expect(waiting.runs[RUN]?.turn?.retry).toEqual({
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
      error: err,
      at: expect.any(Number),
    })
    const resumed = reduceSession(
      waiting,
      ev('step.started', { model }, { turnId: 't1', stepId: 'st9' }),
    )
    expect(resumed.runs[RUN]?.turn?.retry).toBeUndefined()
    const failed = reduceSessionEvents(waiting, [
      ev('turn.failed', { error: err, retryable: true }, { turnId: 't1' }),
      ev('model.retry', { attempt: 2, maxRetries: 3, delayMs: 2000, error: err }, { turnId: 't1' }),
    ])
    expect(failed.runs[RUN]?.turn).toMatchObject({ status: 'failed', retry: undefined })
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

describe('reduceSession：工具调用（M1-05c）', () => {
  const t = { turnId: 't1' }
  const out = (
    ev: ReturnType<typeof stream>,
    toolCallId: string,
    txt: string,
    channel: 'stdout' | 'stderr' = 'stdout',
  ) => ev('tool.output.delta', { toolCallId, stream: channel, text: txt }, t)

  it('请求 → 开始 → 输出 → 完成：实时输出合并同一输出流，完成后丢弃', () => {
    const { view: v0, ev } = midTurn()
    let v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'run_command', input: { cmd: 'ls' } }, t),
      ev('tool.started', { toolCallId: 'c1' }, t),
      out(ev, 'c1', 'a'),
      out(ev, 'c1', 'b'),
      out(ev, 'c1', 'oops', 'stderr'),
    ])
    expect(v.tools['c1']).toMatchObject({ status: 'running', name: 'run_command', turnId: 't1' })
    expect(v.liveToolOutput['c1']).toMatchObject({
      runId: RUN,
      chunks: [
        { stream: 'stdout', text: 'ab' },
        { stream: 'stderr', text: 'oops' },
      ],
      omittedChars: 0,
    })
    const completed = ev(
      'tool.completed',
      { toolCallId: 'c1', output: text('ab'), truncated: true, durationMs: 3 },
      t,
    )
    v = reduceSession(v, completed)
    expect(v.tools['c1']).toMatchObject({
      status: 'completed',
      output: text('ab'),
      display: undefined,
      truncated: true,
      durationMs: 3,
    })
    expect(v.liveToolOutput).toEqual({})
    expect(v.lastSeq).toBe(completed.seq)
  })

  it('tool.completed 的 display 进入工具视图（M2-06）', () => {
    const { view: v0, ev } = midTurn()
    const display = {
      kind: 'terminal' as const,
      exitCode: 1,
      timedOut: false,
      aborted: false,
      durationMs: 3,
      shell: 'bash',
      cwd: '/w',
      chunks: [{ stream: 'stderr' as const, text: '\x1b[31mfail\x1b[0m' }],
      omittedChars: 0,
    }
    const v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'run_command', input: {} }, t),
      ev('tool.completed', { toolCallId: 'c1', output: text('x'), durationMs: 3, display }, t),
    ])
    expect(v.tools['c1']?.display).toEqual(display)
  })

  it('只用持久化事件与加上增量归约，结果相同', () => {
    const { view: v0, ev } = midTurn()
    const events = [
      ev('tool.requested', { toolCallId: 'c1', name: 'x', input: {} }, t),
      ev('tool.started', { toolCallId: 'c1' }, t),
      out(ev, 'c1', 'a'),
      ev('tool.completed', { toolCallId: 'c1', output: [], durationMs: 1 }, t),
    ]
    const withLive = reduceSessionEvents(v0, events)
    const persisted = reduceSessionEvents(
      v0,
      events.filter((e) => e.type !== 'tool.output.delta'),
    )
    expect(withLive).toEqual(persisted)
  })

  it('失败与取消；结束后的事件与增量被忽略', () => {
    const { view: v0, ev } = midTurn()
    const v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'x', input: {} }, t),
      ev('tool.requested', { toolCallId: 'c2', name: 'x', input: {} }, t),
      ev('tool.failed', { toolCallId: 'c1', error: { code: 'tool.denied' } }, t),
      ev('tool.cancelled', { toolCallId: 'c2', reason: 'user' }, t),
    ])
    expect(v.tools['c1']).toMatchObject({ status: 'failed', error: { code: 'tool.denied' } })
    expect(v.tools['c2']).toMatchObject({ status: 'cancelled', cancelReason: 'user' })
    const after = [
      ev('tool.started', { toolCallId: 'c1' }, t),
      ev('tool.completed', { toolCallId: 'c2', output: [], durationMs: 1 }, t),
      ev('tool.requested', { toolCallId: 'c1', name: 'y', input: {} }, t),
    ]
    const next = reduceSessionEvents(v, after)
    expect(next.tools).toBe(v.tools)
    expect(reduceSession(next, out(ev, 'c1', 'late'))).toBe(next)
  })

  it('开始事件重复时不变；未知调用的增量、重复与空增量被忽略', () => {
    const { view: v0, ev } = midTurn()
    const v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'x', input: {} }, t),
      ev('tool.started', { toolCallId: 'c1' }, t),
    ])
    const again = reduceSession(v, ev('tool.started', { toolCallId: 'c1' }, t))
    expect(again.tools).toBe(v.tools)
    expect(reduceSession(again, out(ev, 'nope', 'x'))).toBe(again)
    expect(reduceSession(again, out(ev, 'c1', ''))).toBe(again)
    const delta = out(ev, 'c1', 'x')
    const once = reduceSession(again, delta)
    expect(reduceSession(once, { ...delta, seq: delta.seq } as EventEnvelope)).toBe(once)
  })

  it('实时输出超过上限时从开头丢弃', () => {
    const { view: v0, ev } = midTurn()
    const half = MAX_LIVE_TOOL_OUTPUT_CHARS / 2
    const v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'x', input: {} }, t),
      out(ev, 'c1', 'a'.repeat(half)),
      out(ev, 'c1', 'b'.repeat(half), 'stderr'),
      out(ev, 'c1', 'c'.repeat(half + 10)),
    ])
    const live = v.liveToolOutput['c1']!
    expect(live.omittedChars).toBe(half + 10)
    expect(live.chunks.map((c) => [c.stream, c.text.length])).toEqual([
      ['stderr', half - 10],
      ['stdout', half + 10],
    ])
  })

  it('轮次结束、运行释放与宿主崩溃时丢弃实时输出', () => {
    const { view: v0, ev } = midTurn()
    const v = reduceSessionEvents(v0, [
      ev('tool.requested', { toolCallId: 'c1', name: 'x', input: {} }, t),
      out(ev, 'c1', 'x'),
    ])
    const two = reduceSessionEvents(v, [
      ev('tool.requested', { toolCallId: 'c2', name: 'x', input: {} }, t),
      out(ev, 'c2', 'y'),
      ev('tool.cancelled', { toolCallId: 'c1', reason: 'user' }, t),
    ])
    expect(Object.keys(two.liveToolOutput)).toEqual(['c2'])
    const unrelated = reduceSession(v, ev('session.renamed', { title: 'x' }))
    expect(unrelated.liveToolOutput).toBe(v.liveToolOutput)
    const otherRun = reduceSession(v, ev('run.disposed', {}, { runId: 'r2' }))
    expect(otherRun.liveToolOutput).toBe(v.liveToolOutput)
    expect(reduceSession(v, ev('turn.aborted', { reason: 'user' }, t)).liveToolOutput).toEqual({})
    expect(reduceSession(v, ev('run.disposed', {})).liveToolOutput).toEqual({})
    expect(
      reduceSession(v, ev('session.crashed', { error: { code: 'host.crashed' } })).liveToolOutput,
    ).toEqual({})
  })
})
