import type { HostApprovalRequest, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { describe, expect, it, vi } from 'vitest'
import { createActivityService, type ActivityChange } from './activity-service.js'
import { createApprovalService } from './approval-service.js'
import { createSessionEventService } from './event-service.js'

const agent = { id: 'builtin.coder', version: 1 }
const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 10 }

function event(
  sessionId: string,
  type: string,
  payload: unknown,
  extra: {
    runId?: string
    turnId?: string
    stepId?: string
    ts?: number
    parentRunId?: string
  } = {},
): UnsequencedEvent {
  return {
    v: 1,
    sessionId,
    runId: extra.runId ?? 'r1',
    ts: extra.ts ?? 10,
    type,
    payload,
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    ...(extra.stepId ? { stepId: extra.stepId } : {}),
    ...(extra.parentRunId ? { parentRunId: extra.parentRunId } : {}),
  } as UnsequencedEvent
}

const created = (sessionId: string, ts = 10, parentRunId?: string): UnsequencedEvent =>
  event(
    sessionId,
    'run.created',
    { agent, model, mode: 'interactive', limits },
    {
      runId: parentRunId ? 'child' : 'r1',
      ts,
      ...(parentRunId ? { parentRunId } : {}),
    },
  )

const user = (sessionId: string, text: string, turnId = 't1', ts = 11): UnsequencedEvent =>
  event(
    sessionId,
    'message.user',
    { messageId: `m-${turnId}`, content: [{ type: 'text', text }] },
    { turnId, ts },
  )

const approval = (approvalId: string, extra: Partial<HostApprovalRequest> = {}) => ({
  approvalId,
  toolCallId: `call-${approvalId}`,
  runId: 'r1',
  agent,
  tool: { name: 'run_command', category: 'execute' as const },
  input: { command: 'npm test' },
  targets: { command: 'npm test' },
  kind: 'tool' as const,
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
  ...extra,
})

function setup() {
  let now = 1_000
  const storage = createMemoryStorage({ now: () => now })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  for (const [sessionId, title] of [
    ['s1', '重构 utils'],
    ['s2', '修复登录'],
  ] as const) {
    storage.sessions.create({ sessionId, projectId: 'p1', workspacePath: '/work', title })
  }
  const events = createSessionEventService({ storage })
  const approvals = createApprovalService({
    permissions: { addRule: (_sessionId, rule) => rule },
    now: () => now,
  })
  const changes: ActivityChange[] = []
  const activity = createActivityService({
    storage,
    events,
    approvals,
    homeDirs: ['C:\\Users\\lan'],
    secrets: () => ['secret-12345'],
    now: () => now,
  })
  activity.subscribe((change) => changes.push(change))
  return {
    storage,
    events,
    approvals,
    activity,
    changes,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('createActivityService', () => {
  it('aggregates pending approvals across sessions and routes decisions by approval id', async () => {
    const { approvals, activity } = setup()
    void approvals.request('s1', 'r1', approval('a1'))
    const second = approvals.request('s2', 'r2', approval('a2'))

    const list = activity.list()
    expect(
      list.approvals.map((item) => [item.approvalId, item.sessionId, item.sessionTitle]),
    ).toEqual([
      ['a1', 's1', '重构 utils'],
      ['a2', 's2', '修复登录'],
    ])
    expect(list.counts).toEqual({ approvals: 2, running: 0 })

    expect(activity.resolve({ approvalId: 'a2', decision: 'deny', feedback: '换个做法' })).toEqual(
      {},
    )
    await expect(second).resolves.toEqual({ decision: 'deny', feedback: '换个做法' })
    expect(activity.list().approvals.map((item) => item.approvalId)).toEqual(['a1'])
  })

  it('rejects unknown approvals and keeps the other session untouched', async () => {
    const { approvals, activity } = setup()
    const pending = approvals.request('s1', 'r1', approval('a1'))
    expect(() => activity.resolve({ approvalId: 'missing', decision: 'allow_once' })).toThrow(
      expect.objectContaining({ code: 'approval.not_found' }),
    )
    expect(activity.list().approvals).toHaveLength(1)
    activity.resolve({ approvalId: 'a1', decision: 'allow_once' })
    await expect(pending).resolves.toEqual({ decision: 'allow_once' })
  })

  it('drops cancelled approvals without touching other sessions', async () => {
    const { approvals, activity, changes } = setup()
    const first = approvals.request('s1', 'r1', approval('a1'))
    void approvals.request('s2', 'r2', approval('a2'))
    approvals.cancel('s1', 'a1')
    await expect(first).rejects.toMatchObject({ code: 'approval.cancelled' })
    expect(activity.list().approvals.map((item) => item.approvalId)).toEqual(['a2'])
    expect(changes.at(-1)).toMatchObject({ reason: 'approvals', approvals: [] })
  })

  it('projects running sessions and recent completions from events', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 10),
      user('s1', '重构 JSON 解析'),
      event('s1', 'run.state.changed', { to: 'tooling' }, { ts: 12 }),
      event(
        's1',
        'tool.requested',
        { toolCallId: 'c1', name: 'read_file', input: {} },
        {
          turnId: 't1',
          stepId: 'st1',
          ts: 13,
        },
      ),
    ])
    events.publish([created('s2', 20), user('s2', '修复登录', 't9', 21)])
    events.publish([event('s2', 'turn.completed', { durationMs: 5 }, { turnId: 't9', ts: 30 })])

    const list = activity.list()
    expect(list.running).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        sessionTitle: '重构 utils',
        runId: 'r1',
        state: 'tooling',
        summary: '重构 JSON 解析',
        step: 'read_file',
      }),
    ])
    expect(list.completed).toEqual([
      expect.objectContaining({
        sessionId: 's2',
        runId: 'r1',
        turnId: 't9',
        status: 'completed',
        summary: '修复登录',
        completedAt: 30,
      }),
    ])
    expect(list.counts).toEqual({ approvals: 0, running: 1 })
  })

  it('keeps only the 20 most recent completions', () => {
    const { events, activity } = setup()
    const batch: UnsequencedEvent[] = [created('s1', 1)]
    for (let index = 0; index < 25; index += 1) {
      const turnId = `t${index}`
      batch.push(user('s1', `任务 ${index}`, turnId, index + 2))
      batch.push(event('s1', 'turn.completed', { durationMs: 1 }, { turnId, ts: index + 100 }))
    }
    events.publish(batch)

    const completed = activity.list().completed
    expect(completed).toHaveLength(20)
    expect(completed[0]!.turnId).toBe('t24')
    expect(completed.at(-1)!.turnId).toBe('t5')
  })

  it('marks failed, aborted and limit-reached turns and ignores child runs', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 1),
      user('s1', '一', 't1', 2),
      event(
        's1',
        'turn.limit_reached',
        { limit: 'maxStepsPerTurn', value: 10 },
        {
          turnId: 't1',
          ts: 3,
        },
      ),
      event(
        's1',
        'turn.failed',
        { error: { message: 'boom' }, retryable: false },
        {
          turnId: 't1',
          ts: 4,
        },
      ),
      user('s1', '二', 't2', 5),
      event('s1', 'turn.aborted', { reason: 'user' }, { turnId: 't2', ts: 6 }),
      created('s1', 7, 'r1'),
      user('s1', '子任务', 't3', 8),
      event(
        's1',
        'turn.completed',
        { durationMs: 1 },
        {
          runId: 'child',
          turnId: 't3',
          ts: 9,
        },
      ),
    ])

    const completed = activity.list().completed
    expect(completed.map((item) => [item.turnId, item.status])).toEqual([
      ['t2', 'aborted'],
      ['t1', 'limit_reached'],
    ])
  })

  it('links completed turns to the latest child change set (M4-10)', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 1),
      user('s1', '委派写文件', 't1', 2),
      event(
        's1',
        'run.child.completed',
        { childRunId: 'child1', status: 'completed', changeSetId: 'cs1' },
        { turnId: 't1', ts: 3 },
      ),
      event(
        's1',
        'run.child.completed',
        { childRunId: 'child2', status: 'completed', changeSetId: 'cs2' },
        { turnId: 't1', ts: 4 },
      ),
      event('s1', 'turn.completed', { durationMs: 1 }, { turnId: 't1', ts: 5 }),
      user('s1', '没有改动的轮次', 't2', 6),
      event('s1', 'turn.completed', { durationMs: 1 }, { turnId: 't2', ts: 7 }),
    ])

    const completed = activity.list().completed
    expect(completed[0]).toMatchObject({ turnId: 't2' })
    expect(completed[0]).not.toHaveProperty('changeSetId')
    expect(completed[1]).toMatchObject({ turnId: 't1', changeSetId: 'cs2' })
  })

  it('redacts home directories and configured secrets in summaries', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 1),
      event('s1', 'run.state.changed', { to: 'thinking' }, { ts: 2 }),
      user('s1', '查看 C:\\Users\\lan\\work\\a.ts 和 secret-12345', 't1', 2),
    ])
    const summary = activity.list().running[0]!.summary
    expect(summary).toContain('~')
    expect(summary).toContain('[REDACTED]')
    expect(summary).not.toContain('secret-12345')
  })

  it('hides archived sessions and crashed sessions disappear from running', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 1),
      user('s1', '一', 't1', 2),
      event('s1', 'session.archived', {}, { ts: 3 }),
      created('s2', 4),
      user('s2', '二', 't2', 5),
      event('s2', 'session.crashed', { error: { message: 'crash' } }, { ts: 6 }),
    ])
    expect(activity.list().running).toEqual([])
  })

  it('falls back through preview, command, paths and tool name for approval summaries', async () => {
    const { approvals, activity } = setup()
    const pending = [
      approvals.request(
        's1',
        'r1',
        approval('a1', {
          parentRunId: 'p0',
          preview: { summary: '写入 C:\\Users\\lan\\work\\a.ts\n secret-12345' },
        }),
      ),
      approvals.request(
        'ghost',
        'r2',
        approval('a2', { targets: { paths: ['a.ts', 'b.ts'] }, input: {} }),
      ),
      approvals.request('s2', 'r3', approval('a3', { targets: {}, input: {} })),
    ]
    const list = activity.list().approvals
    expect(list[0]).toMatchObject({
      summary: '写入 ~\\work\\a.ts [REDACTED]',
      parentRunId: 'p0',
    })
    expect(list[1]).toMatchObject({ sessionTitle: '', summary: 'a.ts, b.ts' })
    expect(list[2]).toMatchObject({ summary: 'run_command' })
    list.forEach((_, index) => {
      activity.resolve({ approvalId: `a${index + 1}`, decision: 'allow_once' })
    })
    await Promise.all(pending)
  })

  it('excludes trial sessions from approvals and run summaries', async () => {
    const { storage, events, approvals, activity } = setup()
    storage.sessions.create({
      sessionId: 'trial',
      projectId: 'p1',
      workspacePath: '/work',
      title: '',
      kind: 'trial',
      trialAgentId: 'user.reviewer',
      trialDraftHash: 'hash',
    })
    events.publish([
      {
        v: 1,
        sessionId: 'trial',
        runId: 'r-trial',
        ts: 10,
        type: 'run.created',
        payload: {
          agent: { id: 'user.reviewer', draftHash: 'hash' },
          model: { providerId: 'fake', modelId: 'fake' },
          mode: 'interactive',
          limits: {},
        },
      },
      {
        v: 1,
        sessionId: 'trial',
        runId: 'r-trial',
        turnId: 'turn-trial',
        ts: 11,
        type: 'turn.started',
        payload: {},
      },
    ])
    const pending = approvals.request('trial', 'r-trial', approval('trial-approval'))
    expect(activity.list()).toMatchObject({
      approvals: [],
      running: [],
      completed: [],
    })
    activity.resolve({ approvalId: 'trial-approval', decision: 'deny' })
    await pending
  })

  it('ignores draft agents and approvals in normal sessions', async () => {
    const { events, approvals, activity } = setup()
    const draftAgent = { id: 'user.reviewer', draftHash: 'draft-hash' }
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 10,
        type: 'run.created',
        payload: { agent: draftAgent, model, mode: 'interactive', limits },
      },
    ])
    const pending = approvals.request('s1', 'r1', approval('draft-approval', { agent: draftAgent }))
    expect(activity.list()).toMatchObject({ approvals: [], running: [], completed: [] })
    activity.resolve({ approvalId: 'draft-approval', decision: 'deny' })
    await pending
  })

  it('associates a change set with a turn that has no turn id', () => {
    const { events, activity } = setup()
    events.publish([
      created('s1', 1),
      event(
        's1',
        'run.child.completed',
        { childRunId: 'child', status: 'completed', changeSetId: 'cs1' },
        { runId: 'r1', ts: 2 },
      ),
      event('s1', 'turn.completed', { durationMs: 1 }, { runId: 'r1', ts: 3 }),
    ])
    expect(activity.list().completed.find((item) => item.sessionId === 's1')).toMatchObject({
      changeSetId: 'cs1',
    })
  })

  it('handles messages without text, missing turn ids and step fallbacks', () => {
    const { storage, events, activity, changes } = setup()
    storage.sessions.create({
      sessionId: 's3',
      projectId: 'p1',
      workspacePath: '/work',
      title: '补测试',
    })
    events.publish([
      created('s1', 1),
      event(
        's1',
        'message.user',
        { messageId: 'm1', content: [{ type: 'image', blobRef: 'b1', mimeType: 'image/png' }] },
        {
          ts: 2,
        },
      ),
      event('s1', 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 1 }, { ts: 3 }),
      event('s1', 'turn.failed', { error: { message: 'boom' }, retryable: false }, { ts: 4 }),
      created('s2', 5),
      event('s2', 'run.state.changed', { to: 'thinking' }, { ts: 6 }),
      user('s2', '继续', 't2', 7),
      event('s2', 'step.started', { model }, { turnId: 't2', stepId: 'st2', ts: 8 }),
      created('s3', 9),
      event('s3', 'run.state.changed', { to: 'tooling' }, { ts: 10 }),
      event(
        's3',
        'tool.requested',
        { toolCallId: 'c3', name: 'grep', input: {} },
        {
          turnId: 't3',
          stepId: 'st3',
          ts: 11,
        },
      ),
      event('s3', 'tool.started', { toolCallId: 'c3' }, { turnId: 't3', stepId: 'st3', ts: 12 }),
    ])

    const list = activity.list()
    expect(list.completed).toEqual([
      expect.objectContaining({ sessionId: 's1', status: 'failed', summary: '' }),
    ])
    expect(list.running).toEqual([
      expect.objectContaining({ sessionId: 's3', step: 'grep' }),
      expect.objectContaining({ sessionId: 's2', step: 'st2' }),
    ])

    const before = changes.length
    events.publish([
      event('s2', 'step.started', { model }, { turnId: 't2', stepId: 'st4', ts: 13 }),
    ])
    expect(changes).toHaveLength(before)
  })

  it('notifies subscribers about new approvals, resolutions and completions', async () => {
    const { events, approvals, activity, changes } = setup()
    const pending = approvals.request('s1', 'r1', approval('a1'))
    expect(changes.at(-1)).toMatchObject({
      reason: 'approvals',
      approvals: [expect.objectContaining({ approvalId: 'a1', sessionId: 's1' })],
    })
    activity.resolve({ approvalId: 'a1', decision: 'allow_once' })
    await pending
    expect(changes.at(-1)).toMatchObject({ reason: 'approvals', approvals: [] })

    events.publish([
      created('s2', 10),
      user('s2', '完成', 't1', 11),
      event('s2', 'turn.completed', { durationMs: 1 }, { turnId: 't1', ts: 12 }),
    ])
    const completed = changes.find((change) => change.reason === 'completed')
    expect(completed?.completed[0]).toMatchObject({ sessionId: 's2', turnId: 't1' })
  })

  it('stops subscriptions after close', async () => {
    const { approvals, activity, changes } = setup()
    activity.close()
    const pending = approvals.request('s1', 'r1', approval('a1'))
    expect(changes).toEqual([])
    activity.resolve({ approvalId: 'a1', decision: 'allow_once' })
    await pending
  })

  it('works without a clock override', () => {
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: '/work',
      title: 'x',
    })
    const events = createSessionEventService({ storage })
    const approvals = createApprovalService({
      permissions: { addRule: (_sessionId, rule) => rule },
    })
    events.publish([
      created('s1', 1),
      event('s1', 'run.state.changed', { to: 'thinking' }, { ts: 2 }),
    ])
    const activity = createActivityService({ storage, events, approvals })
    expect(activity.list().running).toHaveLength(1)
  })

  it('reports listener and scan errors without breaking the snapshot', () => {
    const onError = vi.fn()
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: '/work',
      title: 'x',
    })
    const events = createSessionEventService({ storage })
    const approvals = createApprovalService({
      permissions: { addRule: (_sessionId, rule) => rule },
    })
    const activity = createActivityService({
      storage,
      events: {
        readAfter: () => {
          throw new Error('broken log')
        },
        subscribe: events.subscribe,
      },
      approvals,
      onError,
    })
    activity.subscribe(() => {
      throw new Error('listener')
    })
    expect(activity.list().running).toEqual([])
    approvals.request('s1', 'r1', approval('a1'))
    expect(onError).toHaveBeenCalled()
  })
})
