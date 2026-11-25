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

  it('summarizes commands, failures, approvals and child results', () => {
    const ev = stream()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const longPath = `src/${'a'.repeat(230)}.ts`
    const events = [
      ...goalStart(ev),
      ev('goal.paused', { goalId: 'g1', reason: 'user', detail: 'manual' }),
      ev('goal.resumed', { goalId: 'g1' }),
      // 子运行的事件不进入证据，但 target 轮次仍是 t1。
      ev('turn.started', {}, { turnId: 't1', runId: 'child1', parentRunId: 'r1' }),
      ev('turn.completed', { durationMs: 1 }, { turnId: 't1', runId: 'child1', parentRunId: 'r1' }),
      ev(
        'message.user',
        { messageId: 'm-child', content: text('子运行') },
        { turnId: 't1', runId: 'child1', parentRunId: 'r1' },
      ),
      ev(
        'message.user',
        { messageId: 'm-img', content: [{ type: 'image', blobRef: 'b1', mimeType: 'image/png' }] },
        { turnId: 't1' },
      ),
      ev(
        'file.changed',
        { changeId: 'c1', path: longPath, kind: 'delete', revertOf: 'c0' },
        { turnId: 't1' },
      ),
      ev(
        'checkpoint.restored',
        { checkpointId: 'cp1', truncateConversation: false },
        { turnId: 't1' },
      ),
      ev(
        'changeset.created',
        { changeSetId: 'cs1', childRunId: 'child1', files: 2, added: 3, removed: 1 },
        { turnId: 't1' },
      ),
      ev('changeset.rejected', { changeSetId: 'cs2' }, { turnId: 't1' }),
      ev('changeset.applied', { changeSetId: 'cs3', paths: [] }, { turnId: 't1' }),
      ev('changeset.applied', { changeSetId: 'cs4', paths: ['src/b.ts'] }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'm2', content: text('做完了'), model, incomplete: true },
        { turnId: 't1' },
      ),
      ev(
        'tool.requested',
        { toolCallId: 'tc1', name: 'run_command', input: 'pnpm test' },
        { turnId: 't1' },
      ),
      ev('tool.requested', { toolCallId: 'tc2', name: 'todo', input: 42 }, { turnId: 't1' }),
      ev('tool.requested', { toolCallId: 'tc3', name: 'noop', input: null }, { turnId: 't1' }),
      ev('tool.requested', { toolCallId: 'tc4', name: 'cycle', input: circular }, { turnId: 't1' }),
      ev('tool.failed', { toolCallId: 'tc5', error: { code: 'tool.error' } }, { turnId: 't1' }),
      ev('tool.cancelled', { toolCallId: 'tc6', reason: 'user' }, { turnId: 't1' }),
      ev(
        'approval.resolved',
        { approvalId: 'ap1', decision: 'deny', decidedBy: 'user', feedback: '不要' },
        { turnId: 't1' },
      ),
      ev(
        'approval.resolved',
        { approvalId: 'ap2', decision: 'allow_once', decidedBy: 'user' },
        { turnId: 't1' },
      ),
      ev(
        'command.started',
        { commandId: 'bg1', command: 'pnpm dev', cwd: '/work' },
        { turnId: 't1' },
      ),
      ev(
        'command.started',
        { commandId: 'bg2', command: 'pnpm watch', cwd: '/work' },
        { turnId: 't1' },
      ),
      ev('command.exited', { commandId: 'bg1', status: 'exited', exitCode: 0 }, { turnId: 't1' }),
      ev('command.stopped', { commandId: 'bg2' }, { turnId: 't1' }),
      ev(
        'run.child.completed',
        { childRunId: 'child2', status: 'failed', summary: '子任务失败' },
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
    expect(evidence.text).toContain('goal paused: user (manual)')
    expect(evidence.text).toContain('goal resumed')
    expect(evidence.text).toContain(`file ${longPath} delete (revert)`)
    expect(evidence.text).toContain('workspace restored to checkpoint cp1')
    expect(evidence.text).toContain('change set cs1: 2 files (+3/-1)')
    expect(evidence.text).toContain('change set rejected: cs2')
    expect(evidence.text).toContain('change set applied: (no paths)')
    expect(evidence.text).toContain('change set applied: src/b.ts')
    expect(evidence.text).toContain('assistant message m2 (incomplete)')
    expect(evidence.text).toContain('user message m-img: [image]')
    expect(evidence.text).toContain('tool tc1 run_command input: pnpm test')
    expect(evidence.text).toContain('tool tc2 todo input: 42')
    expect(evidence.text).toContain('tool tc3 noop')
    expect(evidence.text).toContain('tool tc4 cycle')
    expect(evidence.text).toContain('tool tc5 failed: tool.error')
    expect(evidence.text).toContain('tool tc6 cancelled: user')
    expect(evidence.text).toContain('approval approval:ap1 deny: 不要')
    expect(evidence.text).not.toContain('approval:ap2')
    expect(evidence.text).toContain('background command bg1 started: pnpm dev')
    expect(evidence.text).toContain('background command bg1 exited with exit code 0')
    expect(evidence.text).toContain('background command bg2 stopped')
    expect(evidence.text).toContain('child run child2 failed: 子任务失败')
    expect(evidence.text).not.toContain('子运行')
    expect(evidence.progress).toBe(true)
    expect(
      evidence.refs.some((ref) => ref.ref.startsWith('…') && ref.note?.includes('revertOf c0')),
    ).toBe(true)
  })

  it('labels failed, aborted and limit-reached turns', () => {
    const ev = stream()
    const events = [
      ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
      ev('message.user', { messageId: 'm0', content: text('修好测试') }),
      ev('turn.started', {}, { turnId: 't1' }),
      ev('turn.failed', { error: { code: 'provider.error' }, retryable: false }, { turnId: 't1' }),
      ev('message.user', { messageId: 'm1', content: text('再试一次') }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev('turn.aborted', { reason: 'user' }, { turnId: 't2' }),
      ev('message.user', { messageId: 'm2', content: text('继续') }),
      ev('turn.started', {}, { turnId: 't3' }),
      ev('turn.limit_reached', { limit: 'maxStepsPerTurn', value: 10 }, { turnId: 't3' }),
      ev('message.user', { messageId: 'm3', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't4' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't4' }),
      // 没有用户消息直接开始的一轮：起点消息为空。
      ev('turn.started', {}, { turnId: 't5' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't5' }),
    ]
    const goal = reducedGoal(events)
    const build = (turnId: string) =>
      buildGoalEvidence({
        goal,
        events: events as readonly PersistedEvent[],
        turnId,
        now: 9_000,
      })
    expect(build('t1').text).toContain('turn failed: provider.error')
    expect(build('t2').text).toContain('turn aborted: user')
    expect(build('t3').text).toContain('turn limit reached: maxStepsPerTurn')
    expect(build('t4').text).toContain('turn completed')
    expect(build('t4').continued).toBe(true)
    expect(build('t5').text).toContain('This is turn 5 of 20')
    expect(build('t5').continued).toBe(false)
  })

  it('includes earlier verdicts and drops the verdict of the judged turn', () => {
    const ev = stream()
    const events = [
      ev('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }),
      ev('message.user', { messageId: 'm0', content: text('修好测试') }),
      ev('turn.started', {}, { turnId: 't1' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      ev(
        'goal.evaluated',
        { goalId: 'g1', verdict: 'not_met', reason: '还缺测试', model },
        { turnId: 't1' },
      ),
      ev('message.user', { messageId: 'm1', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
    ]
    const goal = reducedGoal(events)
    const first = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't1',
      now: 9_000,
    })
    expect(first.text).toContain('This turn already has a verdict: not_met')
    expect(first.text).not.toContain('previous verdict judge:1')
    const second = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
    })
    expect(second.text).toContain('This is turn 2 of 20')
    expect(second.text).toContain('previous verdict judge:1 not_met: 还缺测试')
    expect(second.refs.map((ref) => ref.ref)).toContain('judge:1')
  })

  it('covers paused-period commands, child events and empty messages', () => {
    const ev = stream()
    const events = [
      ...goalStart(ev),
      ev('message.user', { messageId: 'empty', content: [] }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'empty-a', content: [], model },
        { turnId: 't1' },
      ),
      ev(
        'message.assistant.completed',
        { messageId: 'long', content: text('z'.repeat(2_100)), model },
        { turnId: 't1' },
      ),
      ev(
        'tool.completed',
        {
          toolCallId: 'tc-timeout',
          output: text('partial'),
          durationMs: 5,
          display: {
            kind: 'terminal',
            exitCode: null,
            timedOut: true,
            aborted: true,
            durationMs: 5,
            shell: 'bash',
            cwd: '/work',
            chunks: [],
            omittedChars: 0,
          },
        },
        { turnId: 't1' },
      ),
      ev('tool.completed', { toolCallId: 'tc-empty', output: [], durationMs: 1 }, { turnId: 't1' }),
      ev('goal.paused', { goalId: 'another-goal', reason: 'user' }, { turnId: 't1' }),
      ev(
        'command.started',
        { commandId: 'bg0', command: 'pnpm test', cwd: '/work' },
        { turnId: 't1' },
      ),
      ev('command.exited', { commandId: 'bg0', status: 'failed', exitCode: 1 }, { turnId: 't1' }),
      ev(
        'command.started',
        { commandId: 'bg1', command: 'pnpm dev', cwd: '/work' },
        { turnId: 't1' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
      // 暂停期间退出的后台命令不属于目标活动窗口。
      ev('goal.paused', { goalId: 'g1', reason: 'user' }),
      ev('command.exited', { commandId: 'bg1', status: 'exited', exitCode: 0 }, { turnId: 't1' }),
      ev('goal.resumed', { goalId: 'g1' }),
      ev('message.user', { messageId: 'm1', content: text('继续'), origin: 'goal', goalId: 'g1' }),
      ev('turn.started', {}, { turnId: 't2' }),
      ev(
        'command.exited',
        { commandId: 'bg0', status: 'exited', exitCode: 0 },
        { turnId: 't1', runId: 'child', parentRunId: 'r1' },
      ),
      ev(
        'run.child.completed',
        { childRunId: 'child1', status: 'completed' },
        { turnId: 't1', runId: 'child', parentRunId: 'r1' },
      ),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't2' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 't2',
      now: 9_000,
    })
    expect(evidence.text).toContain('tool tc-timeout completed: exit signal (timed out) (aborted)')
    expect(evidence.text).toContain('tool tc-empty completed')
    expect(evidence.text).toContain('background command bg0 started: pnpm test')
    expect(evidence.text).toContain('background command bg0 failed with exit code 1')
    expect(evidence.text).not.toContain('background command bg1 exited')
    expect(evidence.text).not.toContain('another-goal')
    expect(evidence.text).toContain('[truncated]')
    // 失败的后台命令不算进展；t1 的改动/成功命令也不能算到 t2 的判定窗口里。
    expect(evidence.progress).toBe(false)
  })

  it('handles a judged turn that is no longer in the goal', () => {
    const ev = stream()
    const events = [
      ...goalStart(ev),
      ev('file.changed', { changeId: 'c1', path: 'src/a.ts', kind: 'modify' }, { turnId: 't1' }),
      ev('turn.completed', { durationMs: 10 }, { turnId: 't1' }),
    ]
    const goal = reducedGoal(events)
    const evidence = buildGoalEvidence({
      goal,
      events: events as readonly PersistedEvent[],
      turnId: 'missing',
      now: 9_000,
    })
    expect(evidence.text).toContain('This is turn ? of 20')
    expect(evidence.text).toContain('file src/a.ts modify')
    expect(evidence.refs.map((ref) => ref.ref)).toContain('file:src/a.ts')
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

  it('handles escaped quotes and rejects an unterminated object', () => {
    expect(
      parseGoalEvaluation(
        'Verdict: {"verdict":"not_met","reason":"需要先跑 \\"pnpm test\\" 和 C:\\\\work"}',
        refs,
      ),
    ).toMatchObject({ verdict: 'not_met', reason: '需要先跑 "pnpm test" 和 C:\\work' })
    expect(parseGoalEvaluation('{"verdict":"not_met","reason":"没有结尾"', refs)).toBeUndefined()
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

  it('marks a resumed goal with the previous judge reason', () => {
    const message = buildGoalContinuation({
      condition: '测试通过',
      reason: '上一轮还没有跑测试',
      turn: 3,
      maxTurns: 20,
      resumed: true,
    })
    expect(message).toContain('The goal was paused. Continue working toward it.')
    expect(message).toContain('上一轮还没有跑测试')
  })

  it('truncates a long judge reason', () => {
    const message = buildGoalContinuation({
      condition: '测试通过',
      reason: 'y'.repeat(1_200),
      turn: 2,
      maxTurns: 20,
    })
    expect(message).toContain('[truncated]')
    expect(message).not.toContain('y'.repeat(985))
  })
})
