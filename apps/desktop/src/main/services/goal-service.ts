/**
 * 目标服务（ADR-0047）：在主进程里驱动目标的自动续轮。
 *
 * - 监听持久事件，只在根运行的 `turn.completed` 后判定（子运行的完成不触发）；
 * - 判定是一次无工具的辅助补全（与会话主模型相同），输入是 `buildGoalEvidence` 整理的有界证据包；
 * - 判定为 `not_met` 时由会话管理器自动发起下一轮；预算、暂停、结束都写 `goal.*` 事件；
 * - 每个会话一把目标锁：目标命令、事件处理、启动扫描与判定结果落库共用；判定模型调用在锁外，
 *   因此用户暂停 / 清除 / 回退不会被最长 120 秒的判定挡住。
 *
 * 状态仍以事件投影为准：这里只保留判定槽、`evaluating` 标志与连续空转计数，重启后全部清空
 * （启动扫描会把仍在 `active` 的目标暂停）。
 */
import {
  buildGoalEvidence,
  buildGoalContinuation,
  GOAL_EVALUATOR_SYSTEM_PROMPT,
  GOAL_EVIDENCE_MAX_CHARS,
  parseGoalEvaluation,
  resolveModel,
  type CredentialProvider,
  type GoalEvidenceResult,
  type GoalView,
  type ResolvedModel,
} from '@cairn/core'
import type {
  EventEnvelope,
  GoalEvidence,
  GoalPauseReason,
  HostModelConfig,
  ModelRef,
  PersistedEvent,
  Settings,
  TokenUsage,
  UnsequencedEvent,
} from '@cairn/protocol'
import type { CompleteRequest, CompleteResult } from '@cairn/runtime-pi'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'
import type { SessionManager } from './session-manager.js'

/** 每次判定补全的超时；无效输出重试一次，总预算 120 秒。 */
const JUDGE_ATTEMPT_TIMEOUT_MS = 60_000
const JUDGE_TOTAL_TIMEOUT_MS = 120_000
/** 判定输出很短；留出余量给思考型模型的推理。 */
const JUDGE_MAX_OUTPUT_TOKENS = 2_048
/** 连续多少个自动续轮没有可验证进展后暂停。 */
const STALLED_TURN_LIMIT = 3

export type CompleteFn = (request: CompleteRequest) => Promise<CompleteResult>

export interface GoalSettings {
  get(): Settings
  hostModelConfig(model: ModelRef): HostModelConfig | undefined
  credentialRef(model: ModelRef): string | undefined
}

export type GoalSessions = Pick<
  SessionManager,
  'promptGoal' | 'canAutoContinue' | 'goalView' | 'withGoalLock'
>

export interface GoalServiceOptions {
  readonly events: Pick<SessionEventService, 'readAfter' | 'publish' | 'subscribe'>
  readonly storage: Pick<Storage, 'sessions'>
  readonly sessions: GoalSessions
  readonly settings: GoalSettings
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  /** 测试用：替换判定补全（默认按需加载 `runtime-pi` 的 `complete`）。 */
  readonly complete?: CompleteFn
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
  readonly judgeAttemptTimeoutMs?: number
  readonly judgeTotalTimeoutMs?: number
}

export interface GoalService {
  /** 恢复中断的运行之后调用：订阅事件并暂停启动时仍 active 的目标。 */
  start(): Promise<void>
  /** 应用退出：停止监听、中止判定并清空待处理状态。 */
  stop(): void
  /** 预算耗尽后的最终判定；由 `session.resumeGoal` 在锁外调用。 */
  finishBudget(sessionId: string): Promise<void>
  /** 会话被彻底删除：清空内存里的判定状态。 */
  forget(sessionId: string): void
}

interface PendingEvaluation {
  readonly turnId: string
  /** 触发判定的 `turn.completed` 的 seq。 */
  readonly seq: number
  /** 被判定轮次所属的根运行。 */
  readonly runId: string
  readonly final: boolean
}

interface SessionGoalState {
  evaluating: boolean
  pending: PendingEvaluation | undefined
  /** 连续自动续轮且没有可验证进展的次数；只存在内存里。 */
  stalledTurns: number
}

interface PreparedEvaluation {
  readonly goal: GoalView
  readonly goalId: string
  /** 判定开始时代际：目标的最后一条生命周期事件的 seq。 */
  readonly lifecycleSeq: number
  readonly turnId: string
  readonly seq: number
  readonly runId: string
  readonly final: boolean
  readonly model: ModelRef | undefined
  readonly evidence: GoalEvidenceResult
}

type JudgeOutcome =
  | {
      readonly kind: 'verdict'
      readonly verdict: 'met' | 'not_met' | 'impossible'
      readonly reason: string
      readonly evidence: readonly GoalEvidence[]
    }
  | { readonly kind: 'error'; readonly detail: string }

const defaultComplete: CompleteFn = async (request) => {
  const { complete } = await import('@cairn/runtime-pi')
  return complete(request)
}

const lastLifecycleSeq = (goal: GoalView): number => goal.lifecycle.at(-1)?.seq ?? goal.seq

const elapsedMs = (goal: GoalView, at: number): number =>
  goal.activeMs +
  (goal.status === 'active' && goal.activeSince !== undefined
    ? Math.max(0, at - goal.activeSince)
    : 0)

function sessionModel(recorded: readonly PersistedEvent[]): ModelRef | undefined {
  for (let index = recorded.length - 1; index >= 0; index -= 1) {
    const event = recorded[index]
    if (event?.type === 'session.model.changed') return event.payload.model
    if (event?.type === 'session.created' && event.payload.model !== undefined) {
      return event.payload.model
    }
  }
  return undefined
}

/** 某一轮根运行的 `turn.completed`；被回退区间里的不算。 */
function turnCompletion(
  recorded: readonly PersistedEvent[],
  goal: GoalView,
  turnId: string,
): PersistedEvent | undefined {
  const rewinds = recorded.filter((event) => event.type === 'conversation.rewound')
  const isRewound = (seq: number): boolean =>
    rewinds.some((rewind) => seq >= rewind.payload.fromSeq && seq < rewind.seq)
  for (let index = recorded.length - 1; index >= 0; index -= 1) {
    const event = recorded[index]
    if (
      event?.type === 'turn.completed' &&
      event.turnId === turnId &&
      event.parentRunId === undefined &&
      event.seq >= goal.seq &&
      !isRewound(event.seq)
    ) {
      return event
    }
  }
  return undefined
}

export function createGoalService(options: GoalServiceOptions): GoalService {
  const { events, storage, sessions, settings, credentials } = options
  const now = options.now ?? Date.now
  const complete = options.complete ?? defaultComplete
  const attemptTimeoutMs = options.judgeAttemptTimeoutMs ?? JUDGE_ATTEMPT_TIMEOUT_MS
  const totalTimeoutMs = options.judgeTotalTimeoutMs ?? JUDGE_TOTAL_TIMEOUT_MS
  const states = new Map<string, SessionGoalState>()
  const abort = new AbortController()
  let stopped = false
  let unsubscribe: (() => void) | undefined

  const fail = (error: unknown) => {
    if (!stopped) options.onError?.(error)
  }

  const stateOf = (sessionId: string): SessionGoalState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { evaluating: false, pending: undefined, stalledTurns: 0 }
      states.set(sessionId, state)
    }
    return state
  }

  const header = (sessionId: string, ts = now()) => ({
    v: 1 as const,
    sessionId,
    runId: sessionId,
    ts,
  })

  const pauseIfActive = (sessionId: string, reason: GoalPauseReason, detail?: string): boolean => {
    const goal = sessions.goalView(sessionId)
    if (goal?.status !== 'active') {
      stateOf(sessionId).pending = undefined
      return false
    }
    events.publish([
      {
        ...header(sessionId),
        type: 'goal.paused',
        payload: { goalId: goal.goalId, reason, ...(detail !== undefined ? { detail } : {}) },
      },
    ])
    return true
  }

  const endGoal = (
    sessionId: string,
    goal: GoalView,
    reason: 'met' | 'impossible' | 'budget',
    turnId: string | undefined,
    detail?: string,
  ): UnsequencedEvent => {
    const ts = now()
    return {
      ...header(sessionId, ts),
      ...(turnId !== undefined ? { turnId } : {}),
      type: 'goal.ended',
      payload: {
        goalId: goal.goalId,
        reason,
        ...(detail !== undefined ? { detail } : {}),
        turns: goal.turnIds.length,
        durationMs: elapsedMs(goal, ts),
      },
    }
  }

  const budgetDetail = (goal: GoalView): 'turns' | 'duration' =>
    goal.turnIds.length >= goal.limits.maxTurns ? 'turns' : 'duration'

  const budgetExhausted = (goal: GoalView, at: number): boolean =>
    goal.turnIds.length >= goal.limits.maxTurns || elapsedMs(goal, at) >= goal.limits.maxDurationMs

  /**
   * 判定结果的代际校验：同一个目标、仍 active、生命周期未变、没有更新的根轮次、
   * 会话仍存在且未归档。任一不符就只保留用量，丢弃结果。
   */
  function stillCurrent(sessionId: string, prepared: PreparedEvaluation): boolean {
    if (stopped) return false
    const record = storage.sessions.get(sessionId)
    if (!record || record.archived) return false
    const goal = sessions.goalView(sessionId)
    if (goal === undefined || goal.goalId !== prepared.goalId) return false
    if (goal.status !== 'active' || lastLifecycleSeq(goal) !== prepared.lifecycleSeq) return false
    const later = events.readAfter(sessionId, prepared.seq)
    const newerTurn = later.some(
      (event) =>
        event.parentRunId === undefined &&
        (event.type === 'turn.started' ||
          event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.aborted' ||
          event.type === 'turn.limit_reached'),
    )
    return !newerTurn
  }

  async function resolve(model: ModelRef): Promise<ResolvedModel | undefined> {
    const config = settings.hostModelConfig(model)
    if (!config) return undefined
    const ref = settings.credentialRef(model)
    const credential = ref ? await credentials.resolve(ref) : undefined
    return resolveModel(model, config, credential?.apiKey)
  }

  function publishUsage(
    sessionId: string,
    prepared: PreparedEvaluation,
    model: ModelRef,
    usage: TokenUsage,
  ): void {
    if (stopped) return
    if (storage.sessions.get(sessionId) === undefined) return
    events.publish([
      {
        v: 1,
        sessionId,
        runId: prepared.runId,
        ts: now(),
        turnId: prepared.turnId,
        type: 'usage.reported',
        payload: { model, usage, auxiliary: true },
      },
    ])
  }

  /** 一次补全：每次 60 秒超时，总预算 120 秒；`stop()` 会中止。 */
  async function attempt(
    resolved: ResolvedModel,
    text: string,
    deadline: number,
  ): Promise<CompleteResult | 'timeout'> {
    const remaining = Math.min(attemptTimeoutMs, deadline - now())
    if (stopped || remaining <= 0) return 'timeout'
    const controller = new AbortController()
    const onStop = () => controller.abort()
    abort.signal.addEventListener('abort', onStop, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, remaining)
    try {
      return await complete({
        model: resolved,
        systemPrompt: GOAL_EVALUATOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      })
    } catch (error) {
      if (timedOut || stopped) return 'timeout'
      throw error
    } finally {
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', onStop)
    }
  }

  async function judge(
    sessionId: string,
    prepared: PreparedEvaluation,
    model: ModelRef,
  ): Promise<JudgeOutcome> {
    const resolved = await resolve(model)
    if (stopped) return { kind: 'error', detail: 'stopped' }
    if (resolved === undefined) {
      // 模型没有提供方配置（开发用 FakeRuntime）：安静暂停，不写界面错误。
      return { kind: 'error', detail: 'model_unavailable' }
    }
    const deadline = now() + totalTimeoutMs
    for (let round = 0; round < 2; round += 1) {
      const text =
        round === 0
          ? prepared.evidence.text
          : `${prepared.evidence.text}\n\nReturn only the JSON object, with no prose or code fences.`
      const result = await attempt(resolved, text, deadline)
      if (result === 'timeout') return { kind: 'error', detail: 'timeout' }
      if (!result.ok) return { kind: 'error', detail: result.error.code }
      publishUsage(sessionId, prepared, model, result.usage)
      const parsed = parseGoalEvaluation(result.text, prepared.evidence.refs)
      if (parsed !== undefined) {
        return {
          kind: 'verdict',
          verdict: parsed.verdict,
          reason: parsed.reason,
          evidence: parsed.evidence,
        }
      }
    }
    return { kind: 'error', detail: 'invalid_output' }
  }

  async function prepare(
    sessionId: string,
    slot: PendingEvaluation,
  ): Promise<PreparedEvaluation | undefined> {
    if (stopped) return undefined
    const record = storage.sessions.get(sessionId)
    if (!record || record.archived) return undefined
    const goal = sessions.goalView(sessionId)
    if (goal === undefined || goal.status !== 'active') return undefined
    if (!goal.turnIds.includes(slot.turnId)) return undefined
    if (goal.evaluations.some((evaluation) => evaluation.turnId === slot.turnId)) return undefined
    const recorded = events.readAfter(sessionId, 0)
    const model = sessionModel(recorded) ?? record.model
    const config = model !== undefined ? settings.hostModelConfig(model) : undefined
    // 2 字符/token 的保守估算：证据不超过上下文窗口的一半。
    const maxChars = Math.min(
      GOAL_EVIDENCE_MAX_CHARS,
      config?.profile.contextWindow ?? GOAL_EVIDENCE_MAX_CHARS,
    )
    const evidence = buildGoalEvidence({
      goal,
      events: events.readAfter(sessionId, goal.seq - 1),
      turnId: slot.turnId,
      now: now(),
      maxChars,
    })
    return {
      goal,
      goalId: goal.goalId,
      lifecycleSeq: lastLifecycleSeq(goal),
      turnId: slot.turnId,
      seq: slot.seq,
      runId: slot.runId,
      final: slot.final,
      model,
      evidence,
    }
  }

  function apply(sessionId: string, prepared: PreparedEvaluation, outcome: JudgeOutcome): void {
    if (!stillCurrent(sessionId, prepared)) return
    const goal = sessions.goalView(sessionId)
    if (goal === undefined) return
    const state = stateOf(sessionId)

    if (outcome.kind === 'error') {
      events.publish([
        {
          ...header(sessionId),
          type: 'goal.paused',
          payload: { goalId: goal.goalId, reason: 'judge_error', detail: outcome.detail },
        },
      ])
      return
    }

    const turnId = prepared.turnId
    const verdict = outcome.verdict
    const batch: UnsequencedEvent[] = [
      {
        ...header(sessionId),
        turnId,
        type: 'goal.evaluated',
        payload: {
          goalId: goal.goalId,
          verdict,
          reason: outcome.reason,
          ...(outcome.evidence.length > 0 ? { evidence: [...outcome.evidence] } : {}),
          model: prepared.model!,
        },
      },
    ]

    if (verdict === 'met' || verdict === 'impossible') {
      batch.push(endGoal(sessionId, goal, verdict, turnId))
      state.stalledTurns = 0
      events.publish(batch)
      return
    }

    // not_met：预算在判定之后检查，避免把“其实已达成”的目标按预算结束。
    const at = now()
    if (budgetExhausted(goal, at)) {
      batch.push(endGoal(sessionId, goal, 'budget', turnId, budgetDetail(goal)))
      state.stalledTurns = 0
      events.publish(batch)
      return
    }
    if (prepared.final) {
      // resume 触发的最终判定：无论结果如何都不新开轮。
      batch.push(endGoal(sessionId, goal, 'budget', turnId, budgetDetail(goal)))
      state.stalledTurns = 0
      events.publish(batch)
      return
    }

    if (prepared.evidence.continued && !prepared.evidence.progress) {
      state.stalledTurns += 1
    } else {
      state.stalledTurns = 0
    }
    if (state.stalledTurns >= STALLED_TURN_LIMIT) {
      batch.push({
        ...header(sessionId),
        type: 'goal.paused',
        payload: { goalId: goal.goalId, reason: 'stalled', detail: 'no_verifiable_progress' },
      })
      state.stalledTurns = 0
      events.publish(batch)
      return
    }

    events.publish(batch)
    // 用户输入优先：会话忙、有排队输入或撤销 / 恢复锁定时不自动续轮，等下一個完成事件。
    if (!sessions.canAutoContinue(sessionId)) return
    sessions.promptGoal(sessionId, {
      goalId: goal.goalId,
      text: buildGoalContinuation({
        condition: goal.condition,
        reason: outcome.reason,
        turn: goal.turnIds.length + 1,
        maxTurns: goal.limits.maxTurns,
      }),
    })
  }

  async function evaluate(sessionId: string, slot: PendingEvaluation): Promise<void> {
    let prepared: PreparedEvaluation | undefined
    try {
      prepared = await sessions.withGoalLock(sessionId, () => prepare(sessionId, slot))
    } catch (error) {
      fail(error)
      return
    }
    if (prepared === undefined) return
    const current = prepared
    if (current.model === undefined) {
      await sessions.withGoalLock(sessionId, () => {
        if (!stillCurrent(sessionId, current)) return
        const goal = sessions.goalView(sessionId)
        if (goal === undefined) return
        events.publish([
          {
            ...header(sessionId),
            type: 'goal.paused',
            payload: { goalId: goal.goalId, reason: 'judge_error', detail: 'model_unavailable' },
          },
        ])
      })
      return
    }
    let outcome: JudgeOutcome
    try {
      outcome = await judge(sessionId, current, current.model)
    } catch (error) {
      if (stopped) return
      fail(error)
      outcome = { kind: 'error', detail: 'judge_failed' }
    }
    if (stopped) return
    try {
      await sessions.withGoalLock(sessionId, () => {
        if (!stillCurrent(sessionId, current)) return
        apply(sessionId, current, outcome)
      })
    } catch (error) {
      fail(error)
    }
  }

  function maybeEvaluate(sessionId: string): void {
    if (stopped) return
    const state = stateOf(sessionId)
    if (state.evaluating) return
    const slot = state.pending
    if (slot === undefined) return
    state.pending = undefined
    state.evaluating = true
    void evaluate(sessionId, slot)
      .catch(fail)
      .finally(() => {
        state.evaluating = false
        if (!stopped && state.pending !== undefined) maybeEvaluate(sessionId)
      })
  }

  function handleBatch(
    sessionId: string,
    batch: readonly EventEnvelope[],
  ): (() => void) | undefined {
    const record = storage.sessions.get(sessionId)
    if (!record) {
      forget(sessionId)
      return undefined
    }
    const goal = sessions.goalView(sessionId)
    if (goal === undefined) {
      // 目标被回退移除或会话删除了。
      forget(sessionId)
      return undefined
    }
    const state = stateOf(sessionId)
    let trigger = false

    for (const event of batch) {
      switch (event.type) {
        case 'goal.created':
          if (event.payload.goalId === goal.goalId) {
            state.stalledTurns = 0
            state.pending = undefined
          }
          break
        case 'goal.resumed':
          state.stalledTurns = 0
          break
        case 'goal.paused':
        case 'goal.ended':
          state.pending = undefined
          state.stalledTurns = 0
          break
        case 'message.user':
          // 用户手动输入（含引导）会清零空转计数；自动续轮不清零。
          if (event.payload.origin !== 'goal') state.stalledTurns = 0
          break
        case 'turn.completed': {
          if (event.parentRunId !== undefined || event.turnId === undefined) break
          if (goal.status !== 'active' || !goal.turnIds.includes(event.turnId)) break
          state.pending = {
            turnId: event.turnId,
            seq: event.seq,
            runId: event.runId,
            final: false,
          }
          trigger = true
          break
        }
        case 'turn.aborted':
          // shutdown 交给重启扫描；superseded 的下一轮会接着跑。
          if (event.parentRunId === undefined && event.payload.reason === 'user') {
            pauseIfActive(sessionId, 'user')
          }
          break
        case 'turn.failed':
          if (event.parentRunId === undefined) {
            pauseIfActive(sessionId, 'turn_failed', event.payload.error.code)
          }
          break
        case 'turn.limit_reached':
          if (event.parentRunId === undefined) {
            pauseIfActive(sessionId, 'limit_reached', event.payload.limit)
          }
          break
        case 'session.crashed':
          pauseIfActive(sessionId, 'turn_failed', 'host_crashed')
          break
        case 'run.state.changed':
          if (event.parentRunId === undefined && event.payload.to === 'interrupted') {
            pauseIfActive(sessionId, 'interrupted')
          }
          break
        case 'conversation.rewound':
          // runPrompt 的 rewind 分支已在同一同步段暂停；这里兜底其他来源的回退。
          pauseIfActive(sessionId, 'rewind', event.payload.reason)
          break
        case 'checkpoint.restored':
          pauseIfActive(sessionId, 'rewind', 'checkpoint')
          break
        case 'file.changed':
          if (event.payload.revertOf !== undefined) {
            pauseIfActive(sessionId, 'rewind', 'file_revert')
          }
          break
        case 'session.archived':
          pauseIfActive(sessionId, 'archive')
          break
        default:
          break
      }
    }
    return trigger ? () => maybeEvaluate(sessionId) : undefined
  }

  async function pauseOnStartup(): Promise<void> {
    for (const session of storage.sessions.list({ includeArchived: true })) {
      if (session.kind === 'auto-fix') continue
      try {
        const goal = sessions.goalView(session.sessionId)
        if (goal === undefined || goal.status !== 'active') continue
        const recorded = events.readAfter(session.sessionId, 0)
        // 用会话最后一条事件的时间结算，不把应用关闭期间算进活动时长。
        const ts = recorded.at(-1)?.ts ?? now()
        await sessions.withGoalLock(session.sessionId, () => {
          const current = sessions.goalView(session.sessionId)
          if (current === undefined || current.status !== 'active') return
          if (current.goalId !== goal.goalId) return
          events.publish([
            {
              ...header(session.sessionId, ts),
              type: 'goal.paused',
              payload: {
                goalId: current.goalId,
                reason: session.archived ? 'archive' : 'restart',
              },
            },
          ])
        })
      } catch (error) {
        fail(error)
      }
    }
  }

  function forget(sessionId: string): void {
    states.delete(sessionId)
  }

  async function finishBudget(sessionId: string): Promise<void> {
    if (stopped) return
    const schedule = await sessions.withGoalLock(sessionId, () => {
      if (stopped) return undefined
      const record = storage.sessions.get(sessionId)
      if (!record) {
        forget(sessionId)
        return undefined
      }
      const goal = sessions.goalView(sessionId)
      if (goal === undefined || goal.status !== 'active') return undefined
      const at = now()
      if (!budgetExhausted(goal, at)) return undefined
      const lastTurn = goal.turnIds.at(-1)
      const judged = lastTurn !== undefined && goal.evaluations.some((e) => e.turnId === lastTurn)
      if (lastTurn === undefined || judged) {
        events.publish([
          endGoal(sessionId, goal, 'budget', judged ? lastTurn : undefined, budgetDetail(goal)),
        ])
        return undefined
      }
      const completion = turnCompletion(events.readAfter(sessionId, 0), goal, lastTurn)
      if (completion === undefined || completion.turnId === undefined) {
        // 最后一轮失败 / 中止，没有可判定的完成事件。
        events.publish([endGoal(sessionId, goal, 'budget', undefined, budgetDetail(goal))])
        return undefined
      }
      const state = stateOf(sessionId)
      if (state.evaluating) return undefined
      state.pending = {
        turnId: lastTurn,
        seq: completion.seq,
        runId: completion.runId,
        final: true,
      }
      return () => maybeEvaluate(sessionId)
    })
    schedule?.()
  }

  return {
    async start() {
      if (stopped || unsubscribe !== undefined) return
      unsubscribe = events.subscribe((sessionId, batch) => {
        if (stopped) return
        const relevant = batch.some(
          (event) =>
            event.type === 'goal.created' ||
            event.type === 'goal.resumed' ||
            event.type === 'goal.paused' ||
            event.type === 'goal.ended' ||
            event.type === 'message.user' ||
            event.type === 'turn.completed' ||
            event.type === 'turn.aborted' ||
            event.type === 'turn.failed' ||
            event.type === 'turn.limit_reached' ||
            event.type === 'session.crashed' ||
            event.type === 'run.state.changed' ||
            event.type === 'conversation.rewound' ||
            event.type === 'checkpoint.restored' ||
            event.type === 'file.changed' ||
            event.type === 'session.archived',
        )
        if (!relevant) return
        void sessions
          .withGoalLock(sessionId, () => handleBatch(sessionId, batch))
          .then((schedule) => schedule?.())
          .catch(fail)
      })
      await pauseOnStartup()
    },
    stop() {
      stopped = true
      abort.abort()
      unsubscribe?.()
      unsubscribe = undefined
      states.clear()
    },
    finishBudget,
    forget,
  }
}
