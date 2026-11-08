import { describe, expect, it } from 'vitest'
import type { EventEnvelope, EventPayload, EventType } from '@cairn/protocol'
import { projectRunTree } from './run-tree.js'

const model = { providerId: 'fake', modelId: 'fake-1' }
const agent = { id: 'builtin.coder', version: 1 }

let seq = 0

function event<T extends EventType>(
  runId: string,
  ts: number,
  type: T,
  payload: EventPayload<T>,
  extra: { turnId?: string; stepId?: string; parentRunId?: string } = {},
): EventEnvelope {
  return {
    v: 1,
    sessionId: 's1',
    runId,
    seq: ++seq,
    ts,
    type,
    payload,
    ...extra,
  } as EventEnvelope
}

const created = (runId: string, ts = 0, parentRunId?: string) =>
  event(
    runId,
    ts,
    'run.created',
    { agent, model, mode: 'interactive', limits: { maxStepsPerTurn: 10 } },
    parentRunId ? { parentRunId } : {},
  )

function singleRun(runId = 'r1', parentRunId?: string, base = 0): EventEnvelope[] {
  return [
    created(runId, base, parentRunId),
    event(runId, base + 1, 'turn.started', {}, { turnId: 't1' }),
    event(runId, base + 2, 'step.started', { model }, { turnId: 't1', stepId: 'st1' }),
    event(
      runId,
      base + 3,
      'step.completed',
      {
        model,
        finishReason: 'tool_calls',
        durationMs: 10,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { turnId: 't1', stepId: 'st1' },
    ),
    event(
      runId,
      base + 4,
      'tool.requested',
      { toolCallId: 'c1', name: 'read_file', input: { path: 'a.ts' } },
      { turnId: 't1', stepId: 'st1' },
    ),
    event(
      runId,
      base + 5,
      'approval.requested',
      { approvalId: 'a1', toolCallId: 'c1', matchedRuleIds: ['rule1'], reasonCode: 'ask' },
      { turnId: 't1', stepId: 'st1' },
    ),
    event(
      runId,
      base + 6,
      'approval.resolved',
      { approvalId: 'a1', decision: 'allow_once', decidedBy: 'user' },
      { turnId: 't1', stepId: 'st1' },
    ),
    event(runId, base + 7, 'tool.started', { toolCallId: 'c1' }, { turnId: 't1', stepId: 'st1' }),
    event(
      runId,
      base + 8,
      'tool.completed',
      { toolCallId: 'c1', output: [], durationMs: 4 },
      { turnId: 't1', stepId: 'st1' },
    ),
    event(runId, base + 9, 'turn.completed', { durationMs: 20 }, { turnId: 't1' }),
    event(
      runId,
      base + 10,
      'run.state.changed',
      { from: 'thinking', to: 'completed' },
      { turnId: 't1' },
    ),
  ]
}

describe('projectRunTree', () => {
  it('重建单次运行的轮次、步骤、工具调用与审批', () => {
    const tree = projectRunTree({ sessionId: 's1', events: singleRun(), generatedAt: 100 })
    expect(tree.rootRunId).toBe('r1')
    expect(tree.generatedAt).toBe(100)
    expect(tree.runs).toHaveLength(1)
    const run = tree.runs[0]!
    expect(run).toMatchObject({
      runId: 'r1',
      agent,
      model,
      mode: 'interactive',
      state: 'completed',
      createdAt: 0,
      updatedAt: 10,
      durationMs: 10,
      usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 1, durationMs: 10 },
    })
    expect(run.turns[0]).toMatchObject({
      turnId: 't1',
      status: 'completed',
      endedAt: 9,
      usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 1, durationMs: 20 },
    })
    expect(run.turns[0]!.steps[0]).toMatchObject({
      stepId: 'st1',
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 1, durationMs: 10 },
    })
    expect(run.turns[0]!.steps[0]!.toolCalls[0]).toMatchObject({
      toolCallId: 'c1',
      name: 'read_file',
      status: 'completed',
      requestedAt: 4,
      startedAt: 7,
      endedAt: 8,
      durationMs: 4,
      approval: {
        approvalId: 'a1',
        reasonCode: 'ask',
        matchedRuleIds: ['rule1'],
        decision: 'allow_once',
        decidedBy: 'user',
      },
    })
  })

  it('父运行汇总并行子运行的用量', () => {
    const events = [
      ...singleRun('p1', undefined, 0),
      ...singleRun('c1', 'p1', 20),
      ...singleRun('c2', 'p1', 40),
    ]
    const tree = projectRunTree({ sessionId: 's1', events })
    expect(tree.runs.map((run) => run.runId)).toEqual(['p1', 'c1', 'c2'])
    expect(tree.runs[0]!.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
      modelCalls: 3,
      toolCalls: 3,
    })
    expect(tree.runs[1]!.usage.inputTokens).toBe(10)
  })

  it('只返回指定运行及其子树', () => {
    const events = [
      ...singleRun('p1', undefined, 0),
      ...singleRun('c1', 'p1', 20),
      ...singleRun('c2', 'p1', 40),
    ]
    const tree = projectRunTree({ sessionId: 's1', events, rootRunId: 'c2' })
    expect(tree.rootRunId).toBe('c2')
    expect(tree.runs.map((run) => run.runId)).toEqual(['c2'])
  })

  it('失败、中止与限额状态', () => {
    const events: EventEnvelope[] = [
      created('r1', 0),
      event('r1', 1, 'turn.started', {}, { turnId: 't1' }),
      event('r1', 2, 'turn.aborted', { reason: 'user' }, { turnId: 't1' }),
      event('r1', 3, 'turn.started', {}, { turnId: 't2' }),
      event(
        'r1',
        4,
        'turn.limit_reached',
        { limit: 'maxStepsPerTurn', value: 10 },
        { turnId: 't2' },
      ),
      event(
        'r1',
        5,
        'turn.failed',
        { error: { code: 'run.limit_reached' }, retryable: true },
        { turnId: 't2' },
      ),
      event('r1', 6, 'turn.started', {}, { turnId: 't3' }),
      event(
        'r1',
        7,
        'turn.failed',
        { error: { code: 'model.error' }, retryable: false },
        { turnId: 't3' },
      ),
      event('r1', 8, 'run.state.changed', { from: 'thinking', to: 'failed' }),
    ]
    const run = projectRunTree({ sessionId: 's1', events }).runs[0]!
    expect(run.turns.map((turn) => turn.status)).toEqual(['aborted', 'limit_reached', 'failed'])
    expect(run.state).toBe('failed')
  })

  it('忽略未知运行与未知工具的事件', () => {
    const tree = projectRunTree({
      sessionId: 's1',
      events: [
        event('unknown', 0, 'turn.started', {}, { turnId: 't1' }),
        created('r1', 1),
        event('r1', 2, 'tool.failed', { toolCallId: 'missing', error: { code: 'x' } }),
      ],
    })
    expect(tree.runs).toHaveLength(1)
    expect(tree.runs[0]!.turns).toEqual([])
  })

  it('记录失败、取消、重复请求与缺少轮次/步骤的事件', () => {
    const events: EventEnvelope[] = [
      created('r1', 0),
      event('r1', 1, 'turn.started', {}),
      event('r1', 2, 'step.started', { model }),
      event('r1', 3, 'step.completed', { model, finishReason: 'stop', durationMs: 1 }),
      event('r1', 4, 'tool.requested', { toolCallId: 'missing-step', name: 'x', input: {} }),
      event('r1', 5, 'turn.completed', { durationMs: 1 }),
      event('r1', 6, 'turn.aborted', { reason: 'user' }),
      event('r1', 7, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 1 }),
      event('r1', 8, 'turn.failed', { error: { code: 'x' }, retryable: false }),
      event('r1', 9, 'turn.started', {}, { turnId: 't1' }),
      event('r1', 10, 'step.started', { model }, { turnId: 't1', stepId: 'st1' }),
      event(
        'r1',
        11,
        'step.completed',
        { model, finishReason: 'tool_calls', durationMs: 2 },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        12,
        'tool.requested',
        { toolCallId: 'c1', name: 'read_file', input: {} },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        13,
        'tool.requested',
        { toolCallId: 'c1', name: 'read_file_renamed', input: {} },
        { turnId: 't1', stepId: 'st1' },
      ),
      event('r1', 14, 'tool.started', { toolCallId: 'c1' }, { turnId: 't1', stepId: 'st1' }),
      event(
        'r1',
        15,
        'tool.failed',
        { toolCallId: 'c1', error: { code: 'tool.failed' } },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        16,
        'tool.requested',
        { toolCallId: 'c2', name: 'write_file', input: {} },
        { turnId: 't1', stepId: 'st1' },
      ),
      event('r1', 17, 'tool.started', { toolCallId: 'missing' }, { turnId: 't1', stepId: 'st1' }),
      event(
        'r1',
        18,
        'approval.requested',
        { approvalId: 'a1', toolCallId: 'c2', matchedRuleIds: [], reasonCode: 'ask' },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        18,
        'approval.requested',
        { approvalId: 'a-missing', toolCallId: 'missing', matchedRuleIds: [], reasonCode: 'ask' },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        19,
        'approval.resolved',
        { approvalId: 'unknown', decision: 'deny', decidedBy: 'user' },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        20,
        'approval.resolved',
        { approvalId: 'a1', decision: 'cancelled', decidedBy: 'system' },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        21,
        'tool.cancelled',
        { toolCallId: 'c2', reason: 'user' },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        22,
        'tool.requested',
        { toolCallId: 'c3', name: 'read_file', input: {} },
        { turnId: 't1', stepId: 'st1' },
      ),
      event(
        'r1',
        23,
        'tool.completed',
        { toolCallId: 'c3', output: [], durationMs: 2 },
        { turnId: 't1', stepId: 'st1' },
      ),
      event('r1', 24, 'turn.completed', { durationMs: 4 }, { turnId: 't1' }),
      event('r1', 25, 'run.disposed', {}),
    ]
    const tree = projectRunTree({ sessionId: 's1', events })
    const run = tree.runs[0]!
    expect(run.state).toBe('disposed')
    expect(run.usage).toMatchObject({ modelCalls: 1, toolCalls: 3, durationMs: 25 })
    expect(run.turns[0]!.steps[0]!.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        name: 'read_file_renamed',
        status: 'failed',
        error: { code: 'tool.failed' },
      }),
      expect.objectContaining({
        toolCallId: 'c2',
        status: 'cancelled',
        approval: expect.objectContaining({
          approvalId: 'a1',
          decision: 'cancelled',
          decidedBy: 'system',
        }),
      }),
      expect.objectContaining({ toolCallId: 'c3', status: 'completed', durationMs: 2 }),
    ])
  })

  it('累加缓存用量并允许没有父运行的子运行作为根', () => {
    const events: EventEnvelope[] = [
      created('child', 0, 'missing-parent'),
      event('child', 1, 'turn.started', {}, { turnId: 't1' }),
      event('child', 2, 'step.started', { model }, { turnId: 't1', stepId: 'st1' }),
      event(
        'child',
        3,
        'step.completed',
        {
          model,
          finishReason: 'stop',
          durationMs: 1,
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
        },
        { turnId: 't1', stepId: 'st1' },
      ),
      event('child', 4, 'step.started', { model }, { turnId: 't1', stepId: 'st2' }),
      event(
        'child',
        5,
        'step.completed',
        {
          model,
          finishReason: 'stop',
          durationMs: 1,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 4 },
        },
        { turnId: 't1', stepId: 'st2' },
      ),
      event('child', 6, 'turn.completed', { durationMs: 2 }, { turnId: 't1' }),
    ]
    const tree = projectRunTree({ sessionId: 's1', events })
    expect(tree.rootRunId).toBe('child')
    expect(tree.runs[0]!.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 7,
      modelCalls: 2,
    })

    const self = [created('self', 0, 'self')]
    expect(projectRunTree({ sessionId: 's1', events: self }).runs[0]!.runId).toBe('self')
    expect(projectRunTree({ sessionId: 's1', events: self, rootRunId: 'unknown' }).runs).toEqual([])
    expect(projectRunTree({ sessionId: 's1', events: [] })).toMatchObject({
      rootRunId: '',
      runs: [],
    })
  })

  it('汇总父运行与子运行的缓存用量', () => {
    const withCache = (runId: string, ts: number, parentRunId?: string) => [
      created(runId, ts, parentRunId),
      event(runId, ts + 1, 'turn.started', {}, { turnId: 't1' }),
      event(runId, ts + 2, 'step.started', { model }, { turnId: 't1', stepId: 'st1' }),
      event(
        runId,
        ts + 3,
        'step.completed',
        {
          model,
          finishReason: 'stop',
          durationMs: 1,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2 },
        },
        { turnId: 't1', stepId: 'st1' },
      ),
    ]
    const tree = projectRunTree({
      sessionId: 's1',
      events: [...withCache('parent', 0), ...withCache('child', 10, 'parent')],
    })
    expect(tree.runs[0]!.usage.cacheReadTokens).toBe(4)
  })

  it('1000 条事件的投影保持稳定且可接受', () => {
    const events: EventEnvelope[] = [
      created('r1', 0),
      event('r1', 1, 'turn.started', {}, { turnId: 't1' }),
    ]
    for (let i = 0; i < 498; i += 1) {
      const stepId = `st${i}`
      events.push(
        event('r1', 2 + i * 2, 'step.started', { model }, { turnId: 't1', stepId }),
        event(
          'r1',
          3 + i * 2,
          'tool.requested',
          { toolCallId: `c${i}`, name: 'read_file', input: {} },
          { turnId: 't1', stepId },
        ),
      )
    }
    const started = performance.now()
    const tree = projectRunTree({ sessionId: 's1', events })
    const elapsed = performance.now() - started
    expect(tree.runs[0]!.turns[0]!.steps).toHaveLength(498)
    expect(tree.runs[0]!.usage.toolCalls).toBe(498)
    expect(elapsed).toBeLessThan(1_000)
  })
})
