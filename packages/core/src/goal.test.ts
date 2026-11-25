import type { EventEnvelope, EventPayload, EventType, PersistedEvent } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildGoalContinuation,
  buildGoalEvidence,
  GOAL_EVIDENCE_FIRST_LINE,
  parseGoalEvaluation,
} from './goal.js'
import { createSessionView, reduceSessionEvents, type GoalView } from './session-view.js'

const SID = 's1'
const RUN = 'r1'
const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxTurns: 20, maxDurationMs: 7_200_000 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

interface Header {
  readonly runId?: string
  readonly parentRunId?: string
  readonly turnId?: string
  readonly stepId?: string
}

/** 事件构造器：seq 自动递增，ts = seq * 1000。 */
function stream() {
  let seq = 0
  return function ev<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    header: Header = {},
  ): EventEnvelope<T> {
    seq += 1
    const { runId = RUN, ...rest } = header
    return {
      v: 1,
      sessionId: SID,
      runId,
      seq,
      ts: seq * 1_000,
      type,
      payload,
      ...rest,
    } as EventEnvelope<T>
  }
}

function reducedGoal(events: readonly EventEnvelope[]): GoalView {
  const view = reduceSessionEvents(createSessionView(SID), events as readonly PersistedEvent[])
  const goal = view.goals['g1']
  if (goal === undefined) throw new Error('goal missing')
  return goal
}

/** 一个最小的目标：创建 → 用户消息 → 一轮开始。 */
function goalStart(ev: ReturnType<typeof stream>) {
  return [
    ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
    ev('message.user', { messageId: 'm1', content: text('修好测试') }),
    ev('turn.started', {}, { turnId: 't1' }),
  ]
}

describe('buildGoalEvidence', () => {
  it('includes the condition, the turn, tool results and workspace state', () => {
    const ev = stream()
    const events = [
      ...goalStart(ev),
      ev(
        'tool.requested',
        { toolCallId: 'tc1', name: 'run_command', input: { command: 'pnpm test' } },
        { turnId: 't1' },
      ),
      ev(
        'tool.completed',
        {
          toolCallId: 'tc1',
          output: text('all tests passed'),
          durationMs: 10,
          display: {
            kind: 'terminal',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            durationMs: 10,
            shell: 'bash',
            cwd: '/work',
            chunks: [],
            omittedChars: 0,
          },
        },
        { turnId: 't1' },
      ),
      ev('file.changed', { changeId: 'c1', path: 'src/a.ts', kind: 'modify' }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'm2', content: text('已修好'), model },
        { turnId: 't1' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't1',
      now: 9_000,
    })
    expect(evidence.text.startsWith(GOAL_EVIDENCE_FIRST_LINE)).toBe(true)
    expect(evidence.text).toContain('测试全部通过')
    expect(evidence.text).toContain('This is turn 1 of 20')
    expect(evidence.text).toContain('user message m1')
    expect(evidence.text).toContain('tool tc1 run_command')
    expect(evidence.text).toContain('exit 0')
    expect(evidence.text).toContain('file src/a.ts modify')
    expect(evidence.text).toContain('assistant message m2')
    expect(evidence.progress).toBe(true)
    expect(evidence.continued).toBe(false)
    expect(evidence.refs.map((ref) => ref.ref)).toEqual(
      expect.arrayContaining(['message:m1', 'tool:tc1', 'file:src/a.ts', 'message:m2']),
    )
  })

  it('marks an uninterrupted goal continuation as continued', () => {
    const ev = stream()
    const events = [
      ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
      ev('message.user', { messageId: 'm0', content: text('修好测试') }),
      ev('turn.started', {}, { turnId: 't1' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      ev('message.user', { messageId: 'm1', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
    })
    expect(evidence.continued).toBe(true)
    expect(evidence.text).toContain('automatic goal continuation')
  })

  it('counts a user steer as participation and a failed turn as no progress', () => {
    const ev = stream()
    const events = [
      ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
      ev('message.user', { messageId: 'm0', content: text('修好测试') }),
      ev('turn.started', {}, { turnId: 't1' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      ev('message.user', { messageId: 'm1', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev('message.user', { messageId: 'm2', content: text('先别动构建') }, { turnId: 't2' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
    })
    expect(evidence.continued).toBe(false)
    expect(evidence.progress).toBe(false)
  })

  it('drops rewound events and everything after the judged turn', () => {
    const ev = stream()
    const base = [
      ...goalStart(ev),
      ev('tool.requested', { toolCallId: 'tc1', name: 'run_command', input: {} }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'm2', content: text('旧回复'), model },
        { turnId: 't1' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
    ]
    const rewound = ev('conversation.rewound', { fromSeq: 5, reason: 'edit' })
    const next = ev('message.user', {
      messageId: 'm3',
      content: text('重新来'),
      origin: 'goal',
      goalId: 'g1',
    })
    const nextStart = ev('turn.started', {}, { turnId: 't2' })
    const nextDone = ev('turn.completed', { durationMs: 10 }, { turnId: 't2' })
    const after = ev(
      'message.assistant.completed',
      { messageId: 'm4', content: text('下一轮'), model },
      { turnId: 't3' },
    )
    const events = [...base, rewound, next, nextStart, nextDone, after]
    const goal = reducedGoal(events)
    // 回退把 t1 从目标轮次里去掉，t2 成为目标当前的轮次。
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
    })
    expect(evidence.text).not.toContain('旧回复')
    expect(evidence.text).not.toContain('下一轮')
    expect(evidence.refs.map((ref) => ref.ref)).not.toContain('tool:tc1')
    expect(evidence.continued).toBe(true)
  })

  it('keeps paused-period file changes as workspace state without counting progress', () => {
    const ev = stream()
    const events = [
      ...goalStart(ev),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      ev('goal.paused', { goalId: 'g1', reason: 'user' }),
      ev('message.user', { messageId: 'm2', content: text('顺手改一下别的') }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev(
        'file.changed',
        { changeId: 'c1', path: 'src/other.ts', kind: 'create' },
        { turnId: 't2' },
      ),
      ev(
        'message.assistant.completed',
        { messageId: 'm3', content: text('改好了'), model },
        { turnId: 't2' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
      ev('goal.resumed', { goalId: 'g1' }),
      ev('message.user', { messageId: 'm4', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't3' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't3' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't3',
      now: 9_000,
    })
    expect(evidence.text).toContain('file src/other.ts create')
    expect(evidence.text).not.toContain('顺手改一下别的')
    expect(evidence.text).not.toContain('改好了')
    expect(evidence.progress).toBe(false)
  })

  it('keeps child file changes and child summaries but drops child tool output', () => {
    const ev = stream()
    const events = [
      ...goalStart(ev),
      ev(
        'run.delegated',
        { childRunId: 'child1', agent: { id: 'a', version: 1 }, task: '改子模块' },
        { turnId: 't1' },
      ),
      ev(
        'tool.requested',
        { toolCallId: 'tc-child', name: 'read_file', input: {} },
        { turnId: 't1', runId: 'child1', parentRunId: 'r1' },
      ),
      ev(
        'file.changed',
        { changeId: 'c1', path: 'src/child.ts', kind: 'modify' },
        { turnId: 't1', runId: 'child1', parentRunId: 'r1' },
      ),
      ev(
        'changeset.created',
        { changeSetId: 'cs1', childRunId: 'child1', files: 1, added: 2, removed: 0 },
        { turnId: 't1' },
      ),
      ev('changeset.applied', { changeSetId: 'cs1', paths: ['src/child.ts'] }, { turnId: 't1' }),
      ev(
        'run.child.completed',
        { childRunId: 'child1', status: 'completed', summary: '子模块已修' },
        { turnId: 't1' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't1',
      now: 9_000,
    })
    expect(evidence.text).toContain('file src/child.ts modify')
    expect(evidence.text).toContain('change set applied')
    expect(evidence.text).toContain('child run child1 completed')
    expect(evidence.text).not.toContain('tool tc-child')
    expect(evidence.progress).toBe(true)
    expect(evidence.refs.map((ref) => ref.ref)).toContain('turn:child1')
  })

  it('truncates old items first while keeping the current turn', () => {
    const ev = stream()
    const events: EventEnvelope[] = [
      ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
      ev('message.user', { messageId: 'm0', content: text('修好测试') }),
      ev('turn.started', {}, { turnId: 't1' }),
    ]
    for (let index = 0; index < 40; index += 1) {
      events.push(
        ev(
          'tool.requested',
          { toolCallId: `old${index}`, name: 'read_file', input: { path: 'x'.repeat(200) } },
          { turnId: 't1' },
        ),
        ev(
          'tool.completed',
          { toolCallId: `old${index}`, output: text('y'.repeat(400)), durationMs: 1 },
          { turnId: 't1' },
        ),
      )
    }
    events.push(
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      ev('message.user', { messageId: 'm1', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev(
        'tool.requested',
        { toolCallId: 'tc-current', name: 'run_command', input: { command: 'pnpm test' } },
        { turnId: 't2' },
      ),
      ev(
        'tool.completed',
        { toolCallId: 'tc-current', output: text('passed'), durationMs: 1 },
        { turnId: 't2' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
    )
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
      maxChars: 2_500,
    })
    expect(evidence.text.length).toBeLessThanOrEqual(2_500)
    expect(evidence.text).toContain('tool tc-current run_command')
    expect(evidence.text).toContain('[omitted')
    expect(evidence.refs.map((ref) => ref.ref)).toContain('tool:tc-current')
    expect(evidence.refs.map((ref) => ref.ref)).not.toContain('tool:old0')
  })
})

describe('parseGoalEvaluation', () => {
  const refs = [
    { kind: 'tool' as const, ref: 'tool:tc1' },
    { kind: 'file' as const, ref: 'file:src/a.ts' },
    { kind: 'judge' as const, ref: 'judge:1' },
  ]

  it('accepts a fenced JSON object and filters unknown references', () => {
    const result = parseGoalEvaluation(
      [
        'Here is my verdict:',
        '```json',
        JSON.stringify({
          verdict: 'met',
          reason: '命令通过',
          evidence: [
            { kind: 'tool', ref: 'tool:tc1' },
            { kind: 'file', ref: 'tool:tc1' },
            { kind: 'file', ref: 'file:missing.ts' },
          ],
        }),
        '```',
      ].join('\n'),
      refs,
    )
    expect(result).toEqual({
      verdict: 'met',
      reason: '命令通过',
      evidence: [{ kind: 'tool', ref: 'tool:tc1' }],
    })
  })

  it('rejects met without a non-judge reference', () => {
    expect(
      parseGoalEvaluation(
        JSON.stringify({
          verdict: 'met',
          reason: '上次判定说达成',
          evidence: [{ kind: 'judge', ref: 'judge:1' }],
        }),
        refs,
      ),
    ).toBeUndefined()
    expect(
      parseGoalEvaluation(JSON.stringify({ verdict: 'met', reason: '完成了' }), refs),
    ).toBeUndefined()
  })

  it('accepts not_met without evidence and rejects invalid JSON', () => {
    expect(
      parseGoalEvaluation(JSON.stringify({ verdict: 'not_met', reason: '还缺测试结果' }), refs),
    ).toMatchObject({ verdict: 'not_met', evidence: [] })
    expect(parseGoalEvaluation('not json at all', refs)).toBeUndefined()
    expect(
      parseGoalEvaluation(JSON.stringify({ verdict: 'done', reason: 'x' }), refs),
    ).toBeUndefined()
  })
})

describe('buildGoalContinuation', () => {
  it('includes the condition and the judge reason', () => {
    const message = buildGoalContinuation({
      condition: '测试全部通过',
      reason: '还没有运行测试',
      turn: 2,
      maxTurns: 20,
    })
    expect(message).toContain('The goal is not yet met.')
    expect(message).toContain('Goal (abbreviated): 测试全部通过')
    expect(message).toContain('还没有运行测试')
    expect(message).toContain('Keep the work verifiable')
  })

  it('marks a resumed goal and truncates a long condition', () => {
    const message = buildGoalContinuation({
      condition: 'x'.repeat(1_000),
      turn: 2,
      maxTurns: 20,
      resumed: true,
    })
    expect(message).toContain('The goal was paused before it could be evaluated.')
    expect(message).toContain('[truncated]')
    expect(message).not.toContain('x'.repeat(501))
  })
})
