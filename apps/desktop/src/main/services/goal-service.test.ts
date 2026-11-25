import {
  createSessionView,
  reduceSessionEvents,
  type GoalView,
  type SessionView,
} from '@cairn/core'
import type {
  EventEnvelope,
  EventPayload,
  EventType,
  HostModelConfig,
  ModelRef,
  UnsequencedEvent,
} from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { describe, expect, it, vi } from 'vitest'
import type { CompleteFn } from './goal-service.js'
import { createGoalService, type GoalSessions } from './goal-service.js'
import { createSessionEventService } from './event-service.js'

const SESSION = 's1'
const RUN = 'r1'
const model = { providerId: 'local', modelId: 'main' }
const goalLimits = { maxTurns: 20, maxDurationMs: 7_200_000 }
const text = (value: string) => [{ type: 'text' as const, text: value }]

const configOf = (ref: ModelRef): HostModelConfig => ({
  kind: 'openai',
  baseUrl: 'http://127.0.0.1/v1',
  profile: {
    id: ref.modelId,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
  },
})

interface Header {
  readonly runId?: string
  readonly parentRunId?: string
  readonly turnId?: string
}

function setup(
  options: {
    readonly maxTurns?: number
    readonly canContinue?: boolean
    readonly complete?: CompleteFn
    readonly judgeMissing?: boolean
    readonly judgeAttemptTimeoutMs?: number
    readonly judgeTotalTimeoutMs?: number
    readonly credential?: { readonly ref: string; readonly apiKey: string }
    readonly sessionWithoutModel?: boolean
  } = {},
) {
  let clock = 1_000_000
  const storage = createMemoryStorage({ now: () => clock })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  storage.sessions.create({
    sessionId: SESSION,
    projectId: 'p1',
    workspacePath: '/work',
    title: '',
    ...(options.sessionWithoutModel ? {} : { model }),
  })
  const events = createSessionEventService({ storage })
  let view: SessionView = createSessionView(SESSION)
  events.subscribe((sessionId, batch) => {
    if (sessionId === SESSION) view = reduceSessionEvents(view, batch)
  })

  const chains = new Map<string, Promise<unknown>>()
  const withGoalLock = <T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    chains.set(sessionId, tail)
    return next
  }

  const prompts: { readonly text: string; readonly goalId: string }[] = []
  let messageSeq = 0
  let canContinue = options.canContinue ?? true
  const sessions: GoalSessions = {
    promptGoal: (sessionId, input) => {
      prompts.push(input)
      const messageId = `gm${(messageSeq += 1)}`
      events.publish([
        {
          v: 1,
          sessionId,
          runId: RUN,
          ts: clock,
          type: 'message.user',
          payload: {
            messageId,
            content: text(input.text),
            origin: 'goal',
            goalId: input.goalId,
          },
        },
      ])
      return { messageId }
    },
    canAutoContinue: () => canContinue,
    goalView: () => (view.latestGoalId === undefined ? undefined : view.goals[view.latestGoalId]),
    withGoalLock,
  }

  const requests: unknown[] = []
  const complete: CompleteFn =
    options.complete ??
    (async (request) => {
      requests.push(request)
      return {
        ok: true,
        text: JSON.stringify({ verdict: 'not_met', reason: '还缺测试' }),
        usage: { inputTokens: 4, outputTokens: 2 },
      }
    })
  const onError = vi.fn()
  const goals = createGoalService({
    events,
    storage,
    sessions,
    settings: {
      get: () => ({ locale: 'zh-CN', providers: [] }),
      hostModelConfig: (ref) => (options.judgeMissing ? undefined : configOf(ref)),
      credentialRef: () => options.credential?.ref,
    },
    credentials: {
      resolve: async (ref) =>
        options.credential?.ref === ref ? { apiKey: options.credential.apiKey } : undefined,
    },
    complete: (request) => {
      if (options.complete === undefined) requests.push(request)
      return complete(request)
    },
    now: () => clock,
    onError,
    ...(options.judgeAttemptTimeoutMs !== undefined
      ? { judgeAttemptTimeoutMs: options.judgeAttemptTimeoutMs }
      : {}),
    ...(options.judgeTotalTimeoutMs !== undefined
      ? { judgeTotalTimeoutMs: options.judgeTotalTimeoutMs }
      : {}),
  })

  const emit = <T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    header: Header = {},
  ): EventEnvelope => {
    const { runId = RUN, ...rest } = header
    return events.publish([
      { v: 1, sessionId: SESSION, runId, ts: clock, type, payload, ...rest } as UnsequencedEvent,
    ])[0]!
  }

  const goal = (): GoalView | undefined =>
    view.latestGoalId === undefined ? undefined : view.goals[view.latestGoalId]

  const createGoal = (
    limits = {
      maxTurns: options.maxTurns ?? goalLimits.maxTurns,
      maxDurationMs: goalLimits.maxDurationMs,
    },
  ) => emit('goal.created', { goalId: 'g1', condition: '测试全部通过', limits }, { runId: SESSION })

  const userTurn = (turnId: string, messageId: string) => {
    emit('message.user', { messageId, content: text('修好测试') })
    emit('turn.started', {}, { turnId })
  }

  const autoTurn = (turnId: string, messageId: string) => {
    emit('message.user', {
      messageId,
      content: text('继续'),
      origin: 'goal',
      goalId: 'g1',
    })
    emit('turn.started', {}, { turnId })
  }

  const finish = (turnId: string) => emit('turn.completed', { durationMs: 10 }, { turnId })

  return {
    storage,
    events,
    goals,
    sessions,
    prompts,
    requests,
    onError,
    emit,
    goal,
    createGoal,
    userTurn,
    autoTurn,
    finish,
    canContinue: (value: boolean) => {
      canContinue = value
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const judge = (value: object) => JSON.stringify(value)

const verdictReply =
  (value: object): CompleteFn =>
  async () => ({
    ok: true,
    text: judge(value),
    usage: { inputTokens: 5, outputTokens: 3 },
  })

const flush = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('createGoalService', () => {
  it('judges met after the first root turn and ends the goal', async () => {
    const h = setup({
      complete: verdictReply({
        verdict: 'met',
        reason: '测试通过',
        evidence: [{ kind: 'tool', ref: 'tool:tc1' }],
      }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit(
      'tool.requested',
      { toolCallId: 'tc1', name: 'run_command', input: {} },
      { turnId: 't1' },
    )
    h.emit(
      'tool.completed',
      {
        toolCallId: 'tc1',
        output: text('ok'),
        durationMs: 5,
        display: {
          kind: 'terminal',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 5,
          shell: 'bash',
          cwd: '/work',
          chunks: [],
          omittedChars: 0,
        },
      },
      { turnId: 't1' },
    )
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'met', endedTurnId: 't1' })
    const evaluated = h.events
      .readAfter(SESSION, 0)
      .find((event) => event.type === 'goal.evaluated')
    expect(evaluated).toMatchObject({
      turnId: 't1',
      payload: { verdict: 'met', evidence: [{ kind: 'tool', ref: 'tool:tc1' }] },
    })
    expect(
      h.events
        .readAfter(SESSION, 0)
        .some((event) => event.type === 'usage.reported' && event.payload.auxiliary),
    ).toBe(true)
    expect(h.prompts).toHaveLength(0)
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('continues automatically on not_met and stops when the next turn is met', async () => {
    const replies = [
      verdictReply({ verdict: 'not_met', reason: '还没有运行测试' }),
      verdictReply({
        verdict: 'met',
        reason: '测试通过',
        evidence: [{ kind: 'file', ref: 'file:src/a.ts' }],
      }),
    ]
    const h = setup({
      complete: async (request) => {
        const next = replies.shift()
        if (next === undefined) throw new Error('unexpected judge call')
        return next(request)
      },
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    expect(h.prompts[0]!.goalId).toBe('g1')
    expect(h.prompts[0]!.text).toContain('还没有运行测试')
    expect(h.goal()).toMatchObject({ status: 'active' })

    h.autoTurn('t2', 'm2')
    h.emit('file.changed', { changeId: 'c1', path: 'src/a.ts', kind: 'modify' }, { turnId: 't2' })
    h.finish('t2')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'met', turnIds: ['t1', 't2'] })
    expect(h.prompts).toHaveLength(1)
  })

  it('ends as impossible and as budget without continuing', async () => {
    const impossible = setup({
      complete: verdictReply({ verdict: 'impossible', reason: '条件互相矛盾' }),
    })
    await impossible.goals.start()
    impossible.createGoal()
    impossible.userTurn('t1', 'm1')
    impossible.finish('t1')
    await vi.waitFor(() => expect(impossible.goal()?.status).toBe('ended'))
    expect(impossible.goal()).toMatchObject({ endReason: 'impossible' })
    expect(impossible.prompts).toHaveLength(0)

    const budget = setup({
      maxTurns: 1,
      complete: verdictReply({ verdict: 'not_met', reason: '还不够' }),
    })
    await budget.goals.start()
    budget.createGoal()
    budget.userTurn('t1', 'm1')
    budget.finish('t1')
    await vi.waitFor(() => expect(budget.goal()?.status).toBe('ended'))
    expect(budget.goal()).toMatchObject({ endReason: 'budget', endDetail: 'turns' })
    expect(budget.prompts).toHaveLength(0)
  })

  it('pauses on invalid output after one retry', async () => {
    let calls = 0
    const h = setup({
      complete: async () => {
        calls += 1
        return { ok: true, text: 'not json', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'judge_error', pauseDetail: 'invalid_output' })
    expect(calls).toBe(2)
  })

  it('pauses as judge_error when the judge call times out', async () => {
    const h = setup({
      judgeAttemptTimeoutMs: 10,
      // 真实补全会响应 AbortSignal；这里模拟超时中止。
      complete: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'), { timeout: 2_000 })
    expect(h.goal()).toMatchObject({ pauseReason: 'judge_error', pauseDetail: 'timeout' })
    expect(h.prompts).toHaveLength(0)
    h.goals.stop()
  })

  it('ends as budget when the active duration is exhausted', async () => {
    const h = setup({
      complete: verdictReply({ verdict: 'not_met', reason: '继续' }),
    })
    await h.goals.start()
    h.createGoal({ maxTurns: 20, maxDurationMs: 60_000 })
    h.userTurn('t1', 'm1')
    h.advance(60_000)
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'budget', endDetail: 'duration' })
    expect(h.prompts).toHaveLength(0)
  })

  it('pauses when the judge model call fails or the model is not configured', async () => {
    const failing = setup({
      complete: async () => ({ ok: false, error: { code: 'provider.error' }, retryable: false }),
    })
    await failing.goals.start()
    failing.createGoal()
    failing.userTurn('t1', 'm1')
    failing.finish('t1')
    await vi.waitFor(() => expect(failing.goal()?.status).toBe('paused'))
    expect(failing.goal()).toMatchObject({
      pauseReason: 'judge_error',
      pauseDetail: 'provider.error',
    })

    const unconfigured = setup({ judgeMissing: true })
    await unconfigured.goals.start()
    unconfigured.createGoal()
    unconfigured.userTurn('t1', 'm1')
    unconfigured.finish('t1')
    await vi.waitFor(() => expect(unconfigured.goal()?.status).toBe('paused'))
    expect(unconfigured.goal()).toMatchObject({
      pauseReason: 'judge_error',
      pauseDetail: 'model_unavailable',
    })
  })

  it('pauses after three automatic continuations without verifiable progress', async () => {
    const h = setup({
      complete: verdictReply({ verdict: 'not_met', reason: '继续' }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    h.autoTurn('t2', 'm2')
    h.finish('t2')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2))
    h.autoTurn('t3', 'm3')
    h.finish('t3')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(3))
    h.autoTurn('t4', 'm4')
    h.finish('t4')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'stalled' })
    expect(h.prompts).toHaveLength(3)
  })

  it('ignores sub-run turn completion', async () => {
    let calls = 0
    const h = setup({
      complete: async () => {
        calls += 1
        return { ok: true, text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit(
      'turn.completed',
      { durationMs: 5 },
      { turnId: 'child-turn', parentRunId: RUN, runId: 'child' },
    )
    await flush()
    expect(calls).toBe(0)
    expect(h.goal()).toMatchObject({ status: 'active', turnIds: ['t1'] })
  })

  it('discards a verdict when the user pauses during the judge call', async () => {
    let resolveJudge!: (value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          resolveJudge = resolve
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(resolveJudge).toBeDefined())
    h.emit('goal.paused', { goalId: 'g1', reason: 'user' }, { runId: SESSION })
    await flush()
    resolveJudge({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '还缺测试' }),
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    await flush()
    await flush()
    expect(h.goal()).toMatchObject({ status: 'paused', pauseReason: 'user' })
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.evaluated')).toBe(
      false,
    )
    expect(h.prompts).toHaveLength(0)
  })

  it('discards a verdict after the session is deleted', async () => {
    let resolveJudge!: (value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          resolveJudge = resolve
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(resolveJudge).toBeDefined())
    h.storage.sessions.remove(SESSION)
    resolveJudge({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '还缺测试' }),
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    await flush()
    await flush()
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.evaluated')).toBe(
      false,
    )
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'usage.reported')).toBe(
      false,
    )
    expect(h.prompts).toHaveLength(0)
  })

  it('keeps the goal active but skips the next turn while the session is busy', async () => {
    const h = setup({
      canContinue: false,
      complete: verdictReply({ verdict: 'not_met', reason: '继续' }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() =>
      expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.evaluated')).toBe(
        true,
      ),
    )
    expect(h.goal()).toMatchObject({ status: 'active' })
    expect(h.prompts).toHaveLength(0)
  })

  it('pauses on crashes, failures, archives and checkpoints', async () => {
    const h = setup()
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit('checkpoint.restored', { checkpointId: 'cp1', truncateConversation: false })
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'rewind', pauseDetail: 'checkpoint' })
  })

  it('pauses on turn failures, limits, crashes, interrupts, reverts and archives', async () => {
    const cases: {
      readonly name: string
      readonly emit: (h: ReturnType<typeof setup>) => void
      readonly expected: Record<string, unknown>
    }[] = [
      {
        name: 'turn failed',
        emit: (h) =>
          h.emit(
            'turn.failed',
            { error: { code: 'provider.error' }, retryable: false },
            { turnId: 't1' },
          ),
        expected: { pauseReason: 'turn_failed', pauseDetail: 'provider.error' },
      },
      {
        name: 'limit reached',
        emit: (h) =>
          h.emit('turn.limit_reached', { limit: 'maxStepsPerTurn', value: 10 }, { turnId: 't1' }),
        expected: { pauseReason: 'limit_reached', pauseDetail: 'maxStepsPerTurn' },
      },
      {
        name: 'host crash',
        emit: (h) => h.emit('session.crashed', { error: { code: 'host.crashed' } }),
        expected: { pauseReason: 'turn_failed', pauseDetail: 'host_crashed' },
      },
      {
        name: 'interrupted run',
        emit: (h) => h.emit('run.state.changed', { from: 'thinking', to: 'interrupted' }),
        expected: { pauseReason: 'interrupted' },
      },
      {
        name: 'file revert',
        emit: (h) =>
          h.emit('file.changed', {
            changeId: 'c1',
            path: 'src/a.ts',
            kind: 'modify',
            revertOf: 'c0',
          }),
        expected: { pauseReason: 'rewind', pauseDetail: 'file_revert' },
      },
      {
        name: 'archive',
        emit: (h) => h.emit('session.archived', {}),
        expected: { pauseReason: 'archive' },
      },
      {
        name: 'conversation rewind',
        emit: (h) => h.emit('conversation.rewound', { fromSeq: 9_999, reason: 'edit' }),
        expected: { pauseReason: 'rewind', pauseDetail: 'edit' },
      },
    ]
    for (const item of cases) {
      const h = setup()
      await h.goals.start()
      h.createGoal()
      h.userTurn('t1', 'm1')
      item.emit(h)
      await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'), { timeout: 2_000 })
      expect(h.goal(), item.name).toMatchObject(item.expected)
      h.goals.stop()
    }
  })

  it('pauses active goals on startup with the last event timestamp', async () => {
    const h = setup()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.advance(60_000)
    await h.goals.start()
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    const paused = h.events
      .readAfter(SESSION, 0)
      .filter((event) => event.type === 'goal.paused')
      .at(-1)
    expect(paused).toMatchObject({
      ts: 1_000_000,
      payload: { goalId: 'g1', reason: 'restart' },
    })
    expect(h.goal()).toMatchObject({ pauseReason: 'restart' })
    h.goals.stop()
  })

  it('runs a final judgment on resume when the budget is exhausted', async () => {
    const h = setup({
      maxTurns: 1,
      complete: verdictReply({ verdict: 'not_met', reason: '还不够' }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit('goal.paused', { goalId: 'g1', reason: 'user' }, { runId: SESSION })
    h.finish('t1')
    await flush()
    expect(h.goal()).toMatchObject({ status: 'paused', turnIds: ['t1'] })
    h.emit('goal.resumed', { goalId: 'g1' }, { runId: SESSION })
    await h.goals.finishBudget(SESSION)
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'budget', endDetail: 'turns' })
    expect(h.prompts).toHaveLength(0)
  })

  it('pauses on a user abort and ignores other terminations', async () => {
    const h = setup()
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    // 子运行的失败不暂停；非 user 的 abort（superseded）由下一轮接续。
    h.emit(
      'turn.failed',
      { error: { code: 'child.error' }, retryable: false },
      { turnId: 't1', runId: 'child', parentRunId: RUN },
    )
    h.emit('turn.aborted', { reason: 'superseded' }, { turnId: 't1' })
    await flush()
    expect(h.goal()).toMatchObject({ status: 'active' })
    h.emit('turn.aborted', { reason: 'user' }, { turnId: 't1' })
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'user' })
    // 已经暂停：后续失败与完成不重复写暂停，也不触发判定。
    h.emit('turn.failed', { error: { code: 'provider.error' }, retryable: false }, { turnId: 't1' })
    h.finish('t1')
    await flush()
    expect(
      h.events.readAfter(SESSION, 0).filter((event) => event.type === 'goal.paused'),
    ).toHaveLength(1)
    expect(h.requests).toHaveLength(0)
  })

  it('discards a verdict when a new goal replaces the judged one', async () => {
    let resolveJudge!: (value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          resolveJudge = resolve
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(resolveJudge).toBeDefined())
    // 判定期间用户清除目标并新建一个：旧结果属于上一代，必须丢弃。
    h.emit(
      'goal.ended',
      { goalId: 'g1', reason: 'user', turns: 1, durationMs: 0 },
      { runId: SESSION },
    )
    h.emit(
      'goal.created',
      { goalId: 'g2', condition: '新目标', limits: goalLimits },
      { runId: SESSION },
    )
    resolveJudge({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '还缺测试' }),
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    await flush()
    await flush()
    expect(h.goal()).toMatchObject({ goalId: 'g2', status: 'active' })
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.evaluated')).toBe(
      false,
    )
    expect(h.prompts).toHaveLength(0)
  })

  it('discards a verdict after the session is archived', async () => {
    let resolveJudge!: (value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          resolveJudge = resolve
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(resolveJudge).toBeDefined())
    h.storage.sessions.archive(SESSION)
    resolveJudge({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '还缺测试' }),
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    await flush()
    await flush()
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.evaluated')).toBe(
      false,
    )
    // 用量在代际校验之前写入，保留下来供统计。
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'usage.reported')).toBe(
      true,
    )
    expect(h.prompts).toHaveLength(0)
  })

  it('resolves the credential for the judge model', async () => {
    const h = setup({ credential: { ref: 'cred-1', apiKey: 'secret-key' } })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    expect(h.requests[0]).toMatchObject({
      model: { ref: model, apiKey: 'secret-key' },
    })
  })

  it('pauses quietly when the session has no model', async () => {
    const h = setup({ sessionWithoutModel: true })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'judge_error', pauseDetail: 'model_unavailable' })
    expect(h.requests).toHaveLength(0)
  })

  it('pauses as judge_error when the total budget is already exhausted', async () => {
    const h = setup({ judgeTotalTimeoutMs: 0 })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    expect(h.goal()).toMatchObject({ pauseReason: 'judge_error', pauseDetail: 'timeout' })
    expect(h.requests).toHaveLength(0)
  })

  it('ends as budget without re-judging an already judged turn', async () => {
    let calls = 0
    const h = setup({
      complete: async () => {
        calls += 1
        return {
          ok: true,
          text: judge({ verdict: 'not_met', reason: '继续' }),
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    })
    await h.goals.start()
    h.createGoal({ maxTurns: 20, maxDurationMs: 60_000 })
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    h.emit('goal.paused', { goalId: 'g1', reason: 'user' }, { runId: SESSION })
    h.advance(60_000)
    h.emit('goal.resumed', { goalId: 'g1' }, { runId: SESSION })
    h.advance(60_000)
    await h.goals.finishBudget(SESSION)
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'budget', endDetail: 'duration' })
    expect(calls).toBe(1)
    expect(h.prompts).toHaveLength(1)
  })

  it('ends as budget when the last turn never completed', async () => {
    const h = setup()
    await h.goals.start()
    h.createGoal({ maxTurns: 20, maxDurationMs: 60_000 })
    h.userTurn('t1', 'm1')
    h.emit('turn.failed', { error: { code: 'provider.error' }, retryable: false }, { turnId: 't1' })
    await vi.waitFor(() => expect(h.goal()?.status).toBe('paused'))
    h.advance(60_000)
    h.emit('goal.resumed', { goalId: 'g1' }, { runId: SESSION })
    h.advance(60_000)
    await h.goals.finishBudget(SESSION)
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'budget', endDetail: 'duration', turnIds: ['t1'] })
    expect(h.requests).toHaveLength(0)
  })

  it('finishBudget waits for an exhausted, active goal and stops cleanly', async () => {
    const h = setup()
    await h.goals.start()
    await h.goals.start()
    h.createGoal({ maxTurns: 20, maxDurationMs: 60_000 })
    h.userTurn('t1', 'm1')
    await h.goals.finishBudget(SESSION)
    h.emit('goal.paused', { goalId: 'g1', reason: 'user' }, { runId: SESSION })
    h.advance(60_000)
    await h.goals.finishBudget(SESSION)
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.ended')).toBe(false)
    h.goals.stop()
    h.advance(60_000)
    await h.goals.finishBudget(SESSION)
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.ended')).toBe(false)
  })

  it('judges the newer turn when another completes during the judge call', async () => {
    const pending: ((value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void)[] = []
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    })
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // 判定还没返回，用户又完成了一轮：旧结果作废，改为判定更新的轮次。
    h.userTurn('t2', 'm2')
    h.finish('t2')
    await flush()
    pending[0]!({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '继续' }),
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!({
      ok: true,
      text: judge({
        verdict: 'met',
        reason: '测试通过',
        evidence: [{ kind: 'turn', ref: 'turn:t2' }],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'met', turnIds: ['t1', 't2'] })
    const evaluated = h.events
      .readAfter(SESSION, 0)
      .filter((event) => event.type === 'goal.evaluated')
    expect(evaluated.map((event) => event.turnId)).toEqual(['t2'])
    expect(h.prompts).toHaveLength(0)
  })

  it('ignores child runs and turn events without a turn id', async () => {
    const h = setup()
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit('turn.aborted', { reason: 'user' }, { turnId: 't1', runId: 'child', parentRunId: RUN })
    h.emit(
      'turn.limit_reached',
      { limit: 'maxStepsPerTurn', value: 1 },
      { turnId: 't1', runId: 'child', parentRunId: RUN },
    )
    h.emit(
      'run.state.changed',
      { from: 'thinking', to: 'interrupted' },
      { runId: 'child', parentRunId: RUN },
    )
    h.emit('turn.completed', { durationMs: 1 })
    await flush()
    expect(h.goal()).toMatchObject({ status: 'active' })
    expect(h.requests).toHaveLength(0)
  })

  it('forgets pending work when a rewind removes the goal', async () => {
    const h = setup()
    await h.goals.start()
    h.createGoal()
    h.userTurn('t1', 'm1')
    h.emit('conversation.rewound', { fromSeq: 1, reason: 'edit' }, { runId: SESSION })
    await flush()
    expect(h.goal()).toBeUndefined()
    expect(h.events.readAfter(SESSION, 0).some((event) => event.type === 'goal.paused')).toBe(false)
  })

  it('does not start a second final judgment while one is running', async () => {
    const pending: ((value: {
      ok: true
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void)[] = []
    const h = setup({
      complete: () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    })
    await h.goals.start()
    h.createGoal({ maxTurns: 20, maxDurationMs: 60_000 })
    h.userTurn('t1', 'm1')
    h.finish('t1')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    h.advance(60_000)
    await h.goals.finishBudget(SESSION)
    expect(pending).toHaveLength(1)
    pending[0]!({
      ok: true,
      text: judge({ verdict: 'not_met', reason: '继续' }),
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await vi.waitFor(() => expect(h.goal()?.status).toBe('ended'))
    expect(h.goal()).toMatchObject({ endReason: 'budget', endDetail: 'duration' })
    expect(h.prompts).toHaveLength(0)
  })
})
