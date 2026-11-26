/**
 * 会话管理器：调度（M0-13d，ADR-0003，架构 §4、§8、§21）。实现 IPC 网关的 `SessionCommands`。
 *
 * - **创建与列表**：按项目路径找到或创建项目，创建会话并写入 `session.created`；列表状态由事件
 *   归约得出（`sessionStatus`），排队或启动中的会话显示为 `running`。
 * - **重命名与归档**（M2-02）：写入 `session.renamed` / `session.archived`；运行中的会话不能归档。
 * - **更换模型**（M2-04）：写入 `session.model.changed`，下一轮起生效。宿主的模型在启动时确定，
 *   因此下一次输入时如果宿主的模型与会话的不同，先停掉空闲的宿主，再用新模型启动（继续同一个运行，历史重建）。
 * - **输入**：`session.prompt` 先把 `message.user` 落库，再交给会话的宿主；会话没有宿主时排队，
 *   由调度启动。同一会话正在运行一轮（或已有排队的输入）时报 `run.busy`。
 * - **并发上限与排队**：同时存在的宿主（启动中 + 运行中）不超过上限（默认 3），超出的按先后排队；
 *   宿主退出后启动下一个。排队时如果有空闲的宿主，立即回收一个腾出名额。
 * - **空闲回收**：宿主空闲（没有进行中的一轮）超过时限（默认 5 分钟）后正常停止。
 * - **退出清理**：`shutdown()` 清空队列并停止所有宿主，等它们全部退出。
 * - **标记中断**：`recoverInterrupted()` 在启动时把仍处于运行中的运行标记为 `interrupted`（进行中的
 *   轮次记为 `turn.aborted`，原因 `shutdown`）；宿主崩溃后再次输入时同样处理。
 *
 * 会话级事件在还没有运行时以 `sessionId` 作为 `runId`。不依赖 Electron。
 */
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import {
  acceptsInput,
  activeExecutionPlan,
  activeTaskLists,
  applyStepTitles,
  approvedPlanMessage,
  compactionEventPayload,
  compactConversation,
  coveredSeqRange,
  buildGoalContinuation,
  createSessionView,
  isActiveRunState,
  openGoal,
  proposedPlan,
  rebuildHistory,
  reduceSessionEvents,
  resolveDelegationPolicy,
  rootRun,
  sessionStatus,
  userTurnContent,
  type CompactionBudget,
  type GoalView,
  type RunView,
  type SessionView,
} from '@cairn/core'
import {
  GOAL_MAX_DURATION_MS_DEFAULT,
  GOAL_MAX_TURNS_DEFAULT,
  RpcError,
  type ActiveGoal,
  type ActivePlan,
  type ActiveTaskList,
  type AgentDefinition,
  type ContentPart,
  type ModelRef,
  type PromptMode,
  type RunAgentRef,
  type RunLimits,
  type RunMode,
  type UnsequencedEvent,
  taskListIdForPlan,
} from '@cairn/protocol'
import type { SessionRecord, Storage } from '@cairn/storage'
import { latestBrief } from './brief.js'
import type { SessionEventService } from './event-service.js'
import type { HostHandle, HostInit, HostSupervisor } from './host-supervisor.js'
import type { SessionCommands } from './renderer-gateway.js'

export const SessionErrorCode = {
  NotFound: 'storage.not_found',
  Busy: 'run.busy',
  /** 管理器已关闭（应用正在退出）。 */
  Closed: 'run.disposed',
  InvalidParams: 'rpc.invalid_params',
  /** 创建会话时指定的模型没有配置。 */
  UnknownModel: 'session.unknown_model',
  /** 计划不是待审状态（不存在、已批准或已拒绝）。 */
  PlanNotPending: 'plan.not_pending',
  UnknownStep: 'plan.unknown_step',
  /** 会话要用的 Agent 不存在，或还没有发布过。 */
  AgentNotFound: 'agent.not_found',
  /** 试运行开始后草稿又改过；必须用新配置重新开始。 */
  DraftChanged: 'trial.draft_changed',
  /** 只有已归档的会话能彻底删除。 */
  NotArchived: 'session.not_archived',
  /** 会话已有未结束的目标（ADR-0047）。 */
  GoalExists: 'goal.exists',
  /** 没有可暂停 / 恢复 / 清除的目标。 */
  GoalNotFound: 'goal.not_found',
  /** 试运行、自动修复或已归档的会话不能使用目标。 */
  GoalUnavailable: 'goal.not_available',
  /** 存在待审计划；先批准或取消计划，再设置 / 恢复目标。 */
  GoalPlanPending: 'goal.plan_pending',
} as const

/** 新运行使用的配置。 */
export type RunDefaults = Pick<HostInit, 'agent' | 'model' | 'mode' | 'limits'>

export interface SessionManagerOptions {
  readonly storage: Pick<Storage, 'projects' | 'sessions'>
  readonly events: Pick<SessionEventService, 'publish' | 'readAfter' | 'subscribe'>
  readonly supervisor: HostSupervisor
  /** 新运行的配置；会话记录了模型时，用会话的模型。 */
  readonly runDefaults: RunDefaults
  /** 已配置的模型（M1-04a）：新会话默认使用 `defaultModel()`，指定的模型须已配置。省略表示不检查。 */
  readonly models?: {
    defaultModel(): ModelRef | undefined
    has(model: ModelRef): boolean
  }
  /**
   * 按引用取已发布的 Agent 定义（M3-11，Agent 服务）。省略时一律用 `runDefaults`；给出时用于固定
   * 模型与限额，以及 `session.setAgent` 的校验。
   */
  readonly resolveAgent?: (agent: RunAgentRef) => AgentDefinition | undefined
  /** 会话是否暂时不接受输入（如正在撤销改动，M1-08b），此时输入报 `run.busy`。 */
  readonly isLocked?: (sessionId: string) => boolean
  /** 同时存在的宿主上限，默认 3。 */
  readonly maxConcurrent?: number
  /** 宿主空闲多久后回收，默认 5 分钟。 */
  readonly idleTimeoutMs?: number
  /** 压缩时总结更早的对话（M3-03）。没有时，手动压缩只在历史超限且能丢掉工具输出时生效。 */
  readonly summarize?: (sessionId: string, transcript: string) => Promise<string | undefined>
  /** 这个会话的压缩预算。省略时用一个很大的窗口，手动压缩仍会总结更早的轮次。 */
  readonly contextBudget?: (sessionId: string) => CompactionBudget
  /**
   * 恢复一个预算已耗尽的目标时做最终判定（ADR-0047）。由 `GoalService` 提供；
   * 省略时直接结束为 `budget`，不会留下 active 但没有轮次的目标。
   */
  readonly finishGoalBudget?: (sessionId: string) => void | Promise<void>
  /** 会话被彻底删除：目标服务据此清空内存里的判定状态。 */
  readonly onSessionDeleted?: (sessionId: string) => void
  readonly createId?: () => string
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

type Sync<F> = F extends (params: infer P) => infer R
  ? (params: P) => Exclude<R, Promise<unknown>>
  : never

/** 创建、列表与输入是同步的（数据库接口同步，宿主在后台启动）。 */
export interface SessionManager extends SessionCommands {
  readonly create: Sync<SessionCommands['create']>
  readonly list: Sync<SessionCommands['list']>
  readonly prompt: Sync<SessionCommands['prompt']>
  readonly rename: Sync<SessionCommands['rename']>
  readonly setPinned: Sync<SessionCommands['setPinned']>
  readonly archive: Sync<SessionCommands['archive']>
  readonly setModel: Sync<SessionCommands['setModel']>
  readonly setAgent: SessionCommands['setAgent']
  /** 目标命令（ADR-0047）。 */
  readonly setGoal: SessionCommands['setGoal']
  readonly pauseGoal: SessionCommands['pauseGoal']
  readonly resumeGoal: SessionCommands['resumeGoal']
  readonly clearGoal: SessionCommands['clearGoal']
  /** 自动续轮的内部入口：会话忙或目标已不是 active 时返回 undefined，绝不 steer。 */
  promptGoal(
    sessionId: string,
    input: { readonly text: string; readonly goalId: string },
  ): { messageId: string } | undefined
  /** 会话空闲、未归档且目标 active 时才能自动续轮。 */
  canAutoContinue(sessionId: string): boolean
  /** 当前会话投影里的目标（未结束优先，否则最近结束的那个）。 */
  goalView(sessionId: string): GoalView | undefined
  /** 每会话一条串行队列：目标命令、事件处理与判定结果落库共用。 */
  withGoalLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T>
  /** 会话是否正在运行：排队、宿主启动中，或运行处于活动状态（撤销改动前检查，M1-08b）。 */
  isBusy(sessionId: string): boolean
  /** 启动时调用：把仍处于运行中的运行标记为中断，返回标记的运行数。 */
  recoverInterrupted(): number
  /** 有宿主（启动中或运行中）的会话。 */
  activeSessions(): string[]
  /** 排队等待宿主的会话，按先后顺序。 */
  queuedSessions(): string[]
  /**
   * 让运行中的宿主重新读取权限规则（M1-11b）：审批时新增了规则、切换了权限模式之后调用。
   * 给出 `sessionIds` 时只通知这些会话。失败交给 `onError`。
   */
  refreshPermissions(sessionIds?: readonly string[]): void
  /**
   * 宿主启动时拿到的工具清单过期了（M3-09：MCP 服务连上、断开或停用）。空闲的宿主马上停止，
   * 忙着的等这一轮结束再停；下一次输入重新启动宿主，拿到新的清单。
   */
  refreshTools(): void
  /** 应用退出时调用：清空队列、停止所有宿主并等待退出。之后的输入报 `run.disposed`。 */
  shutdown(): Promise<void>
}

interface PendingPrompt {
  readonly runId: string
  readonly messageId: string
  readonly content: ContentPart[]
  /** 这一轮的工作方式。省略的旧调用按正常模式。 */
  readonly mode: PromptMode
  readonly history: HostInit['history']
  readonly run: RunDefaults
  /** 继续已有的运行时为其当前状态。 */
  readonly resume: HostInit['resume']
  readonly workspacePath: string
}

interface Slot {
  handle: HostHandle | undefined
  /** 宿主启动时使用的模型。 */
  readonly model: ModelRef
  /** 已发送输入、尚未收到 `turn.started`。 */
  awaitingTurn: boolean
  /** 启动期间用户停止了排队的输入。 */
  cancelled: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 工具清单已过期：空闲后立即停止宿主，不等空闲超时。 */
  stale?: boolean
  /** 宿主退出（或启动失败）后 resolve。 */
  readonly gone: Promise<void>
}

/** 可被标记为中断的运行状态。 */
const interruptible = (run: RunView) => isActiveRunState(run.state) || run.state === 'aborting'

/**
 * 自动修复会话总是无人值守（ADR-0018）：修复在主进程里自动开始，没有人在场回答提问或即时审批。
 */
const runModeOf = (record: Pick<SessionRecord, 'kind'>, fallback: RunMode): RunMode =>
  record.kind === 'auto-fix' ? 'unattended' : fallback

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const { storage, events, supervisor } = options
  const maxConcurrent = options.maxConcurrent ?? 3
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000
  const createId = options.createId ?? randomUUID
  const now = options.now ?? Date.now
  const onError = (error: unknown) => options.onError?.(error)

  const views = new Map<string, SessionView>()
  const slots = new Map<string, Slot>()
  /** 等待宿主的输入；Map 保持插入顺序，即排队顺序。 */
  const waiting = new Map<string, PendingPrompt>()
  let closed = false
  /** 恢复只做一次：窗口创建后调用，重复调用不应再次重放全部历史。 */
  let recovered = false

  const unsubscribe = events.subscribe((sessionId, batch) => {
    const view = views.get(sessionId)
    if (view) views.set(sessionId, reduceSessionEvents(view, batch))
    const slot = slots.get(sessionId)
    if (!slot) return
    if (batch.some((e) => e.type === 'turn.started')) slot.awaitingTurn = false
    updateIdle(sessionId, slot)
  })

  function getView(sessionId: string): SessionView {
    let view = views.get(sessionId)
    if (!view) {
      view = reduceSessionEvents(createSessionView(sessionId), events.readAfter(sessionId, 0))
      views.set(sessionId, view)
    }
    return view
  }

  const header = (sessionId: string, runId: string) => ({
    v: 1 as const,
    sessionId,
    runId,
    ts: now(),
  })

  /** 把会话中仍处于运行中的运行标记为中断，返回标记的运行数。 */
  function markInterrupted(sessionId: string, reason: string): number {
    const out: UnsequencedEvent[] = []
    for (const runId of getView(sessionId).runOrder) {
      const run = getView(sessionId).runs[runId]
      if (!run || !interruptible(run)) continue
      const base = {
        ...header(sessionId, runId),
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      }
      if (run.turn?.status === 'running') {
        out.push({
          ...base,
          turnId: run.turn.turnId,
          type: 'turn.aborted',
          payload: { reason: 'shutdown' },
        })
      }
      out.push({
        ...base,
        type: 'run.state.changed',
        payload: { from: run.state, to: 'interrupted', reason },
      })
    }
    if (out.length > 0) events.publish(out)
    return out.filter((e) => e.type === 'run.state.changed').length
  }

  /** 会话是否正在运行一轮（宿主在运行，且已发送输入或运行处于运行中状态）。 */
  function isBusy(sessionId: string, slot: Slot): boolean {
    if (slot.awaitingTurn) return true
    const run = rootRun(getView(sessionId))
    return run !== undefined && interruptible(run)
  }

  /** 排队中、宿主启动中，或宿主正在执行。 */
  function sessionBusy(sessionId: string): boolean {
    const slot = slots.get(sessionId)
    if (waiting.has(sessionId)) return true
    if (!slot) return false
    if (!slot.handle) return true
    return slot.handle.state() === 'running' && isBusy(sessionId, slot)
  }

  const goalLocks = new Map<string, Promise<unknown>>()

  /**
   * 每会话一条 promise 链（ADR-0047）。目标命令、`GoalService` 的事件处理、启动扫描与判定结果
   * 落库共用；锁只覆盖同步的读取、校验与写入，判定模型调用在锁外进行。
   */
  function withGoalLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = goalLocks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    goalLocks.set(sessionId, tail)
    void tail.then(() => {
      if (goalLocks.get(sessionId) === tail) goalLocks.delete(sessionId)
    })
    return next
  }

  function updateIdle(sessionId: string, slot: Slot) {
    if (!slot.handle || slot.handle.state() !== 'running') return
    if (isBusy(sessionId, slot)) {
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
      slot.idleTimer = undefined
      return
    }
    if (slot.stale) {
      slot.stale = false
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
      slot.idleTimer = undefined
      void slot.handle.stop()
      return
    }
    if (slot.idleTimer !== undefined) return
    slot.idleTimer = setTimeout(() => void slot.handle?.stop(), idleTimeoutMs)
    // 有会话在排队时，空闲的宿主立即让出名额
    if (waiting.size > 0) pump()
  }

  /** 正在执行的计划。计划模式的新一轮不带上旧计划。 */
  function executionPlan(sessionId: string, mode: PromptMode): ActivePlan | undefined {
    if (mode === 'plan') return undefined
    const plan = activeExecutionPlan(getView(sessionId))
    if (!plan) return undefined
    return {
      planId: plan.planId,
      goal: plan.content.goal,
      steps: plan.steps.map((step) => ({ id: step.id, title: step.title })),
    }
  }

  /**
   * 本会话未关闭的待办列表（ADR-0038）。计划轮是只读调查，不带列表。
   * 每次 prompt 都从投影重建，因此恢复会话、宿主重启后仍然准确。
   */
  function executionTaskLists(sessionId: string, mode: PromptMode): ActiveTaskList[] | undefined {
    if (mode === 'plan') return undefined
    const lists = activeTaskLists(getView(sessionId))
    if (lists.length === 0) return undefined
    return lists.map((list) => ({
      listId: list.listId,
      title: list.title,
      source: list.source,
      ...(list.planId ? { planId: list.planId } : {}),
      items: list.items.map((item) => ({
        itemId: item.itemId,
        title: item.title,
        status: item.status,
        ...(item.note ? { note: item.note } : {}),
      })),
    }))
  }

  /**
   * 目标活动时的当前目标（ADR-0047）。计划轮与暂停 / 结束的目标不传；`turn` 从 1 起，
   * 由目标已经开始的根轮次推出。
   */
  function executionGoal(sessionId: string, mode: PromptMode): ActiveGoal | undefined {
    if (mode === 'plan') return undefined
    const goal = openGoal(getView(sessionId))
    if (!goal || goal.status !== 'active') return undefined
    return {
      goalId: goal.goalId,
      condition: goal.condition,
      limits: goal.limits,
      turn: goal.turnIds.length + 1,
    }
  }

  /**
   * Agent 定义决定运行用的模型与限额（M3-11）：`mode: 'fixed'` 时忽略会话模型；限额在
   * `runDefaults.limits` 之上覆盖。没有固定模型时用会话模型，再回退到已配置的默认模型；
   * 没有注入 `resolveAgent`（或未发布）时用默认配置。
   */
  function runConfig(
    agent: RunAgentRef,
    sessionModel: ModelRef | undefined,
  ): { model: ModelRef | undefined; limits: RunLimits } {
    const definition = options.resolveAgent?.(agent)
    if (!definition) return { model: sessionModel, limits: options.runDefaults.limits }
    const fixed = definition.model.mode === 'fixed' ? definition.model.primary : undefined
    return {
      model: fixed ?? sessionModel ?? options.models?.defaultModel(),
      limits: { ...options.runDefaults.limits, ...definition.limits },
    }
  }

  function send(
    sessionId: string,
    slot: Slot,
    handle: HostHandle,
    pending: Pick<PendingPrompt, 'messageId' | 'content' | 'mode'>,
  ) {
    slot.awaitingTurn = true
    updateIdle(sessionId, slot)
    const plan = executionPlan(sessionId, pending.mode)
    const taskLists = executionTaskLists(sessionId, pending.mode)
    const goal = executionGoal(sessionId, pending.mode)
    handle
      .prompt({
        messageId: pending.messageId,
        content: pending.content,
        ...(pending.mode === 'plan' ? { mode: 'plan' as const } : {}),
        ...(plan ? { plan } : {}),
        ...(taskLists ? { taskLists } : {}),
        ...(goal ? { goal } : {}),
      })
      .catch((error: unknown) => {
        onError(error)
        slot.awaitingTurn = false
        updateIdle(sessionId, slot)
      })
  }

  function start(sessionId: string, pending: PendingPrompt) {
    let resolveGone!: () => void
    const slot: Slot = {
      handle: undefined,
      model: pending.run.model,
      awaitingTurn: false,
      cancelled: false,
      idleTimer: undefined,
      gone: new Promise<void>((resolve) => (resolveGone = resolve)),
    }
    slots.set(sessionId, slot)
    const release = () => {
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
      if (slots.get(sessionId) === slot) slots.delete(sessionId)
      resolveGone()
      pump()
    }
    supervisor
      .startHost({
        sessionId,
        runId: pending.runId,
        workspacePath: pending.workspacePath,
        ...pending.run,
        history: pending.history,
        ...(pending.resume ? { resume: pending.resume } : {}),
      })
      .then(
        (handle) => {
          slot.handle = handle
          void handle.exited.then(release)
          if (closed) {
            void handle.stop()
            return
          }
          if (slot.cancelled) updateIdle(sessionId, slot)
          else send(sessionId, slot, handle, pending)
        },
        (error: unknown) => {
          // 启动失败已由监督器记录为 session.crashed
          onError(error)
          release()
        },
      )
  }

  /** 在名额内按顺序启动排队的会话；名额已满时回收一个空闲的宿主。 */
  function pump() {
    if (closed) return
    for (const [sessionId, pending] of waiting) {
      if (slots.size >= maxConcurrent) break
      // 上一个宿主仍在退出，等它释放后再启动
      if (slots.has(sessionId)) continue
      waiting.delete(sessionId)
      start(sessionId, pending)
    }
    if (waiting.size === 0) return
    for (const slot of slots.values()) {
      if (slot.idleTimer !== undefined && slot.handle?.state() === 'running') {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = undefined
        void slot.handle.stop()
        return
      }
    }
  }

  function requireSession(sessionId: string) {
    const record = storage.sessions.get(sessionId)
    if (!record) throw new RpcError(SessionErrorCode.NotFound, { sessionId })
    return record
  }

  /**
   * 会话当前的 Agent：试运行用它的草稿，普通会话用最近的根运行，都没有时用默认配置。
   * 输入框的 `@Agent` 候选与发送时展开按同一份定义取委派名单。
   */
  function currentAgent(sessionId: string): RunAgentRef {
    const record = requireSession(sessionId)
    if (record.kind === 'trial') {
      return record.trialAgentId !== undefined && record.trialDraftHash !== undefined
        ? { id: record.trialAgentId, draftHash: record.trialDraftHash }
        : options.runDefaults.agent
    }
    return rootRun(getView(sessionId))?.agent ?? options.runDefaults.agent
  }

  type PromptParams = Parameters<SessionCommands['prompt']>[0]

  /** 回退对话后重新开始时，必须先让宿主丢掉内存里的旧历史，下一次输入重建（见 runPrompt）。 */
  function publishRewind(
    sessionId: string,
    runId: string,
    fromSeq: number,
    reason: 'edit' | 'regenerate',
  ) {
    events.publish([
      {
        ...header(sessionId, runId),
        type: 'conversation.rewound',
        payload: { fromSeq, reason },
      },
    ])
  }

  /** 一条用户消息是不是它所在轮次的第一条（编辑只允许从轮次开头回退）。 */
  function isTurnStart(view: SessionView, messageId: string): boolean {
    const target = view.messages.find((message) => message.messageId === messageId)
    if (target === undefined || target.role !== 'user') return false
    const run = view.runs[target.runId]
    if (run !== undefined && run.parentRunId !== undefined) return false
    const turn = target.turnId
    if (turn === undefined) {
      // 还没有 turnId 的消息只能是最新一条（宿主还没开始这一轮）。
      return !view.messages.some((message) => message.role === 'user' && message.seq > target.seq)
    }
    return !view.messages.some(
      (message) => message.turnId === turn && message.role === 'user' && message.seq < target.seq,
    )
  }

  /**
   * 会话空闲时才能回退：正在进行的一轮、排队中的输入或撤销锁定都不允许。
   * 返回根运行的 runId 供回退事件使用。
   */
  function requireRewindable(sessionId: string): SessionView {
    if (closed) throw new RpcError(SessionErrorCode.Closed)
    requireSession(sessionId)
    if (options.isLocked?.(sessionId) || sessionBusy(sessionId)) {
      throw new RpcError(SessionErrorCode.Busy, { sessionId })
    }
    return getView(sessionId)
  }

  /**
   * 发送一轮输入（原 `session.prompt`）。`rewind` 时即使宿主还空闲在跑，也先停掉它：
   * 宿主持有内存里的历史，回退后必须按事件日志重建，否则模型会看到被丢弃的轮次。
   */
  function runPrompt(
    params: PromptParams,
    flags?: { readonly rewind?: 'edit' | 'regenerate' },
  ): { messageId: string }
  function runPrompt(
    params: PromptParams,
    flags: { readonly goalId: string; readonly rewind?: 'edit' | 'regenerate' },
  ): { messageId: string } | undefined
  function runPrompt(
    params: PromptParams,
    flags: { readonly rewind?: 'edit' | 'regenerate'; readonly goalId?: string } = {},
  ): { messageId: string } | undefined {
    const { sessionId, content: typed, mode = 'normal', mentions, skills, agents, context } = params
    if (closed) throw new RpcError(SessionErrorCode.Closed)
    const record = requireSession(sessionId)
    if (options.isLocked?.(sessionId)) {
      throw new RpcError(SessionErrorCode.Busy, { sessionId })
    }
    const slot = slots.get(sessionId)
    const running = slot?.handle?.state() === 'running'
    // 运行中（有进行中的轮次）：把输入作为引导注入当前轮，不打断、不另起一轮（Runtime §9）。
    // 宿主仍在运行时下面不会写中断标记，这里直接读当前状态。
    const activeRun = running ? rootRun(getView(sessionId)) : undefined
    const activeTurn = activeRun !== undefined && isActiveRunState(activeRun.state)
    if (!activeTurn && sessionBusy(sessionId)) {
      throw new RpcError(SessionErrorCode.Busy, { sessionId })
    }
    // 自动续轮只排队，绝不 steer 正在运行的一轮（ADR-0047）。
    if (flags.goalId !== undefined && (activeTurn || sessionBusy(sessionId))) return undefined
    // 没有宿主时仍处于运行中的运行，是上一个宿主崩溃留下的
    if (!running) markInterrupted(sessionId, 'host_lost')
    const view = getView(sessionId)
    const root = rootRun(view)
    if (
      record.kind === 'trial' &&
      (record.trialAgentId === undefined || record.trialDraftHash === undefined)
    ) {
      throw new RpcError(SessionErrorCode.NotFound, { sessionId })
    }
    const agent: RunAgentRef =
      record.kind === 'trial'
        ? { id: record.trialAgentId!, draftHash: record.trialDraftHash! }
        : (root?.agent ?? options.runDefaults.agent)
    if (record.kind === 'trial' && !options.resolveAgent?.(agent)) {
      throw new RpcError(SessionErrorCode.DraftChanged, { sessionId })
    }
    const next = runConfig(agent, record.model)
    // 会话换了模型：停掉空闲的宿主，用新模型重新启动（等旧宿主退出后由调度启动）。
    // 引导注入当前轮时不换模型，下一轮才换。
    const modelChanged =
      !activeTurn && running && next.model !== undefined && !sameModel(next.model, slot!.model)
    // 回退后旧宿主的历史已失效，同样停掉；新宿主启动时从事件日志重建。
    const restart = modelChanged || flags.rewind !== undefined
    if (restart) void slot?.handle?.stop()
    const hostReady = running && !restart
    const resume = root !== undefined && root.state !== 'disposed' && acceptsInput(root.state)
    // 引导沿用当前运行的 runId；其余情况按能否直接继续决定。
    const runId = activeTurn ? root!.runId : resume ? root.runId : createId()
    const history = hostReady ? [] : rebuildHistory(events.readAfter(sessionId, 0), { runId })

    const messageId = createId()
    const batch: UnsequencedEvent[] = []
    // 目标与只读计划轮互斥（ADR-0047）：开始计划轮前先暂停，保证计划轮不计入目标轮次。
    if (mode === 'plan' && !activeTurn) {
      const goal = openGoal(view)
      if (goal?.status === 'active') {
        batch.push({
          ...header(sessionId, sessionId),
          type: 'goal.paused',
          payload: { goalId: goal.goalId, reason: 'plan_mode' },
        })
      }
    }
    // 回退会在同一同步段暂停仍然活动的目标；重发轮不计入目标预算，也不注入目标。
    if (flags.rewind !== undefined) {
      const goal = openGoal(view)
      if (goal?.status === 'active') {
        batch.push({
          ...header(sessionId, sessionId),
          type: 'goal.paused',
          payload: { goalId: goal.goalId, reason: 'rewind', detail: flags.rewind },
        })
      }
    }
    batch.push({
      ...header(sessionId, runId),
      type: 'message.user',
      payload: {
        messageId,
        content: typed,
        ...(flags.goalId !== undefined ? { origin: 'goal' as const, goalId: flags.goalId } : {}),
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(agents && agents.length > 0 ? { agents } : {}),
        ...(context !== undefined ? { context } : {}),
      },
    })
    events.publish(batch)
    // 模型看到的是输入加上展开的引用；界面只显示输入本身。
    const content = userTurnContent({ content: typed, context })

    if (activeTurn && slot?.handle) {
      // 引导：注入当前轮，在下一次模型调用前生效。不置 awaitingTurn（不会产生新的 turn.started）。
      // 活跃计划可能在这轮里刚修订，传递最新步骤供宿主校验后续工具调用。
      const plan = executionPlan(sessionId, 'normal')
      const taskLists = executionTaskLists(sessionId, 'normal')
      slot.handle
        .prompt({
          messageId,
          content,
          send: 'steer',
          ...(plan ? { plan } : {}),
          ...(taskLists ? { taskLists } : {}),
        })
        .catch((error) => onError(error))
    } else if (slot?.handle && hostReady) {
      send(sessionId, slot, slot.handle, { messageId, content, mode })
    } else {
      waiting.set(sessionId, {
        runId,
        messageId,
        content,
        mode,
        history,
        run: resume
          ? {
              agent,
              model: next.model ?? root.model,
              mode: root.mode,
              limits: root.limits,
            }
          : {
              agent,
              model: next.model ?? record.model ?? options.runDefaults.model,
              mode: runModeOf(record, options.runDefaults.mode),
              limits: next.limits,
            },
        resume: resume ? { state: root.state } : undefined,
        workspacePath: record.workspacePath,
      })
      pump()
    }
    return { messageId }
  }

  /**
   * 目标只对普通会话开放（ADR-0047）：试运行与自动修复会话没有 `/goal` 入口；
   * 已归档的会话要先取消归档。
   */
  function requireGoalCapable(sessionId: string): SessionRecord {
    const record = requireSession(sessionId)
    if (record.kind !== 'normal' || record.archived) {
      throw new RpcError(SessionErrorCode.GoalUnavailable, { sessionId })
    }
    return record
  }

  const elapsedMs = (goal: GoalView): number =>
    goal.activeMs +
    (goal.status === 'active' && goal.activeSince !== undefined
      ? Math.max(0, now() - goal.activeSince)
      : 0)

  const budgetExhausted = (goal: GoalView): boolean =>
    goal.turnIds.length >= goal.limits.maxTurns || elapsedMs(goal) >= goal.limits.maxDurationMs

  /** 暂停仍活动的目标；已暂停 / 已结束的不重复写（幂等）。 */
  function pauseActiveGoal(
    sessionId: string,
    reason: 'user' | 'turn_failed',
    detail?: string,
  ): boolean {
    const goal = openGoal(getView(sessionId))
    if (goal?.status !== 'active') return false
    events.publish([
      {
        ...header(sessionId, sessionId),
        type: 'goal.paused',
        payload: { goalId: goal.goalId, reason, ...(detail !== undefined ? { detail } : {}) },
      },
    ])
    return true
  }

  /**
   * 自动续轮的内部入口（ADR-0047）。会话忙、目标已不是 active 时返回 undefined；
   * 绝不 steer：只在空闲时排队一轮。调用方负责在自己那一段同步代码里先确认条件。
   */
  function promptGoal(
    sessionId: string,
    input: { readonly text: string; readonly goalId: string },
  ): { messageId: string } | undefined {
    if (closed) return undefined
    const record = storage.sessions.get(sessionId)
    if (!record || record.archived) return undefined
    if (options.isLocked?.(sessionId) || sessionBusy(sessionId)) return undefined
    const goal = openGoal(getView(sessionId))
    if (!goal || goal.status !== 'active' || goal.goalId !== input.goalId) return undefined
    try {
      return runPrompt(
        { sessionId, content: [{ type: 'text', text: input.text }] },
        { goalId: input.goalId },
      )
    } catch (error) {
      onError(error)
      return undefined
    }
  }

  function canAutoContinue(sessionId: string): boolean {
    if (closed) return false
    const record = storage.sessions.get(sessionId)
    if (!record || record.archived) return false
    if (options.isLocked?.(sessionId) || sessionBusy(sessionId)) return false
    const view = getView(sessionId)
    const goal = openGoal(view)
    if (!goal || goal.status !== 'active') return false
    const root = rootRun(view)
    return root === undefined || !isActiveRunState(root.state)
  }

  function goalView(sessionId: string): GoalView | undefined {
    const view = getView(sessionId)
    return view.latestGoalId === undefined ? undefined : view.goals[view.latestGoalId]
  }

  async function setGoal(
    params: Parameters<SessionCommands['setGoal']>[0],
  ): Promise<{ goalId: string; messageId: string }> {
    const { sessionId, condition } = params
    return withGoalLock(sessionId, () => {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireGoalCapable(sessionId)
      if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      const view = getView(sessionId)
      if (openGoal(view) !== undefined) {
        throw new RpcError(SessionErrorCode.GoalExists, { sessionId })
      }
      if (proposedPlan(view) !== undefined) {
        throw new RpcError(SessionErrorCode.GoalPlanPending, { sessionId })
      }
      const goalId = createId()
      const limits = {
        maxTurns: params.maxTurns ?? GOAL_MAX_TURNS_DEFAULT,
        maxDurationMs: params.maxDurationMs ?? GOAL_MAX_DURATION_MS_DEFAULT,
      }
      // 检查与开始第一轮之间不放 await：goal.created 一定先于 turn.started 落库。
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'goal.created',
          payload: { goalId, condition, limits },
        },
      ])
      try {
        const started = runPrompt({
          sessionId,
          content: [{ type: 'text', text: condition }],
        })
        if (started === undefined) throw new RpcError(SessionErrorCode.Busy, { sessionId })
        return { goalId, messageId: started.messageId }
      } catch (error) {
        pauseActiveGoal(sessionId, 'turn_failed', 'start_failed')
        throw error
      }
    })
  }

  async function pauseGoal(params: { readonly sessionId: string }): Promise<Record<string, never>> {
    const { sessionId } = params
    return withGoalLock(sessionId, () => {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireGoalCapable(sessionId)
      const goal = openGoal(getView(sessionId))
      if (goal === undefined) throw new RpcError(SessionErrorCode.GoalNotFound, { sessionId })
      // 已经暂停时无操作；暂停不中止正在跑的一轮。
      if (goal.status === 'active') pauseActiveGoal(sessionId, 'user')
      return {}
    })
  }

  async function resumeGoal(params: {
    readonly sessionId: string
  }): Promise<{ messageId?: string }> {
    const { sessionId } = params
    const outcome = await withGoalLock(sessionId, () => {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireGoalCapable(sessionId)
      const view = getView(sessionId)
      const goal = openGoal(view)
      if (goal === undefined) throw new RpcError(SessionErrorCode.GoalNotFound, { sessionId })
      if (goal.status === 'active') return { kind: 'noop' as const }
      if (proposedPlan(view) !== undefined) {
        throw new RpcError(SessionErrorCode.GoalPlanPending, { sessionId })
      }
      if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'goal.resumed',
          payload: { goalId: goal.goalId },
        },
      ])
      // 预算已耗尽：先写 resumed，再在锁外做最终判定（不启动新轮）。
      if (budgetExhausted(goal)) {
        return {
          kind: 'budget' as const,
          goalId: goal.goalId,
          turns: goal.turnIds.length,
          durationMs: elapsedMs(goal),
        }
      }
      const started = promptGoal(sessionId, {
        goalId: goal.goalId,
        text: buildGoalContinuation({
          condition: goal.condition,
          turn: goal.turnIds.length + 1,
          maxTurns: goal.limits.maxTurns,
          resumed: true,
        }),
      })
      if (started === undefined) {
        pauseActiveGoal(sessionId, 'turn_failed', 'start_failed')
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      return { kind: 'started' as const, messageId: started.messageId }
    })
    if (outcome.kind === 'budget') {
      const finish = options.finishGoalBudget
      if (finish !== undefined) {
        void Promise.resolve(finish(sessionId)).catch(onError)
      } else {
        events.publish([
          {
            ...header(sessionId, sessionId),
            type: 'goal.ended',
            payload: {
              goalId: outcome.goalId,
              reason: 'budget',
              turns: outcome.turns,
              durationMs: outcome.durationMs,
            },
          },
        ])
      }
      return {}
    }
    return outcome.kind === 'started' ? { messageId: outcome.messageId } : {}
  }

  async function clearGoal(params: { readonly sessionId: string }): Promise<Record<string, never>> {
    const { sessionId } = params
    return withGoalLock(sessionId, () => {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireGoalCapable(sessionId)
      const view = getView(sessionId)
      const goal = openGoal(view)
      if (goal === undefined) {
        // 会话从未有过目标才报 not_found；对已结束的目标幂等成功。
        if (view.latestGoalId === undefined) {
          throw new RpcError(SessionErrorCode.GoalNotFound, { sessionId })
        }
        return {}
      }
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'goal.ended',
          payload: {
            goalId: goal.goalId,
            reason: 'user',
            turns: goal.turnIds.length,
            durationMs: elapsedMs(goal),
          },
        },
      ])
      return {}
    })
  }

  const manager: SessionManager = {
    create({ projectPath, title, model: requested }) {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      if (!isAbsolute(projectPath))
        throw new RpcError(SessionErrorCode.InvalidParams, { projectPath })
      if (requested && options.models && !options.models.has(requested)) {
        throw new RpcError(SessionErrorCode.UnknownModel, { ...requested })
      }
      const model = requested ?? options.models?.defaultModel()
      const project =
        storage.projects.getByPath(projectPath) ??
        storage.projects.create({
          projectId: createId(),
          name: basename(projectPath),
          path: projectPath,
        })
      const sessionId = createId()
      const session = storage.sessions.create({
        sessionId,
        projectId: project.projectId,
        workspacePath: project.path,
        title: title ?? '',
        ...(model ? { model } : {}),
      })
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'session.created',
          payload: {
            projectId: project.projectId,
            projectPath: project.path,
            workspacePath: session.workspacePath,
            title: session.title,
            ...(model ? { model } : {}),
          },
        },
      ])
      return { sessionId }
    },

    list({ includeArchived }) {
      const sessions = storage.sessions
        .list(includeArchived ? { includeArchived } : {})
        .map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          projectPath: s.projectPath,
          status:
            waiting.has(s.sessionId) || (slots.has(s.sessionId) && !slots.get(s.sessionId)?.handle)
              ? ('running' as const)
              : sessionStatus(getView(s.sessionId)),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          ...(s.model ? { model: s.model } : {}),
          ...(s.pinned ? { pinned: true } : {}),
        }))
      return { sessions }
    },

    setPinned({ sessionId, pinned }) {
      requireSession(sessionId)
      storage.sessions.setPinned(sessionId, pinned)
      return {}
    },

    rename({ sessionId, title }) {
      requireSession(sessionId)
      const next = title.trim()
      storage.sessions.rename(sessionId, next)
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'session.renamed',
          payload: { title: next, source: 'user' },
        },
      ])
      return {}
    },

    archive({ sessionId }) {
      requireSession(sessionId)
      if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      storage.sessions.archive(sessionId)
      events.publish([{ ...header(sessionId, sessionId), type: 'session.archived', payload: {} }])
      return {}
    },

    unarchive({ sessionId }) {
      requireSession(sessionId)
      storage.sessions.unarchive(sessionId)
      events.publish([{ ...header(sessionId, sessionId), type: 'session.unarchived', payload: {} }])
      return {}
    },

    setModel({ sessionId, model }) {
      requireSession(sessionId)
      if (options.models && !options.models.has(model)) {
        throw new RpcError(SessionErrorCode.UnknownModel, { ...model })
      }
      storage.sessions.setModel(sessionId, model)
      events.publish([
        { ...header(sessionId, sessionId), type: 'session.model.changed', payload: { model } },
      ])
      return {}
    },

    /**
     * 彻底删除会话：连同事件一起删掉，不可恢复。只对已归档的会话用。
     * 运行中的会话不能删（归档的会话本来就不在跑）。
     */
    delete({ sessionId }) {
      const record = requireSession(sessionId)
      if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      if (!record.archived) throw new RpcError(SessionErrorCode.NotArchived, { sessionId })
      storage.sessions.remove(sessionId)
      options.onSessionDeleted?.(sessionId)
      return {}
    },

    /**
     * 设定本会话的思考强度：写库并广播事件，下一轮（下次启动宿主）生效。
     * 模型不支持推理时宿主会忽略这个设置。
     */
    setThinkingLevel({ sessionId, thinkingLevel }) {
      requireSession(sessionId)
      storage.sessions.setThinkingLevel(sessionId, thinkingLevel)
      events.publish([
        {
          ...header(sessionId, sessionId),
          type: 'session.thinkingLevel.changed',
          payload: { thinkingLevel },
        },
      ])
      return {}
    },

    /**
     * 切换 Agent（M3-11）：新建一个运行，`run.created` 引用 `id@version`，之前的对话作为历史
     * （下一次输入时重建）。运行中不能切换；空闲的宿主先停止，新宿主带新 Agent 的指令与工具。
     */
    /** 当前 Agent 的委派范围（M4-02）：`@Agent` 候选与展开都只认这份名单。 */
    delegationTargets({ sessionId }) {
      const ref = sessionId === undefined ? options.runDefaults.agent : currentAgent(sessionId)
      const policy = resolveDelegationPolicy(options.resolveAgent?.(ref)?.delegation)
      return { enabled: policy.enabled, agentIds: [...policy.allowedAgents] }
    },

    async setAgent({ sessionId, agent }) {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      const record = requireSession(sessionId)
      if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      if (!options.resolveAgent?.(agent)) {
        throw new RpcError(SessionErrorCode.AgentNotFound, { ...agent })
      }
      const slot = slots.get(sessionId)
      if (slot?.handle && slot.handle.state() === 'running') await slot.handle.stop()
      const next = runConfig(agent, record.model)
      const model = next.model ?? record.model ?? options.runDefaults.model
      if (!model) throw new RpcError(SessionErrorCode.UnknownModel)
      const runId = createId()
      events.publish([
        {
          ...header(sessionId, runId),
          type: 'run.created',
          payload: {
            agent,
            model,
            mode: runModeOf(record, options.runDefaults.mode),
            limits: next.limits,
          },
        },
      ])
      return {}
    },

    prompt: (params) => runPrompt(params),

    setGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    promptGoal,
    canAutoContinue,
    goalView,
    withGoalLock,

    editMessage({ sessionId, messageId, content, mentions, skills, agents }) {
      const view = requireRewindable(sessionId)
      const target = view.messages.find((message) => message.messageId === messageId)
      if (target === undefined || !isTurnStart(view, messageId)) {
        throw new RpcError(SessionErrorCode.InvalidParams, { messageId })
      }
      publishRewind(sessionId, target.runId, target.seq, 'edit')
      // 引用由网关按新内容重算后传入；计划模式不随编辑保留，按普通一轮重新开始。
      return runPrompt(
        {
          sessionId,
          content,
          ...(mentions && mentions.length > 0 ? { mentions } : {}),
          ...(skills && skills.length > 0 ? { skills } : {}),
          ...(agents && agents.length > 0 ? { agents } : {}),
        },
        { rewind: 'edit' },
      )
    },

    regenerate({ sessionId, messageId }) {
      const view = requireRewindable(sessionId)
      const target = view.messages.find((message) => message.messageId === messageId)
      if (target === undefined || target.turnId === undefined) {
        throw new RpcError(SessionErrorCode.InvalidParams, { messageId })
      }
      // 用这一轮第一条用户消息作为回退点，并复用原始事件里的完整输入（含 `@` 引用展开的上下文），
      // 保证模型看到的和上一轮一致。
      const start = view.messages.find(
        (message) => message.turnId === target.turnId && message.role === 'user',
      )
      if (start === undefined || start.role !== 'user') {
        throw new RpcError(SessionErrorCode.InvalidParams, { messageId })
      }
      const original = events
        .readAfter(sessionId, start.seq - 1)
        .find(
          (event) => event.type === 'message.user' && event.payload.messageId === start.messageId,
        )
      if (original === undefined || original.type !== 'message.user') {
        throw new RpcError(SessionErrorCode.InvalidParams, { messageId })
      }
      publishRewind(sessionId, start.runId, start.seq, 'regenerate')
      const { content, mentions, skills, agents, context } = original.payload
      return runPrompt(
        {
          sessionId,
          content,
          ...(mentions && mentions.length > 0 ? { mentions } : {}),
          ...(skills && skills.length > 0 ? { skills } : {}),
          ...(agents && agents.length > 0 ? { agents } : {}),
          ...(context !== undefined ? { context } : {}),
        },
        { rewind: 'regenerate' },
      )
    },

    approvePlan({ sessionId, planId, steps }) {
      const plan = requirePendingPlan(sessionId, planId)
      if (steps?.some((step) => !plan.content.steps.some((current) => current.id === step.id))) {
        throw new RpcError(SessionErrorCode.UnknownStep, { planId })
      }
      const content = applyStepTitles(plan.content, steps)
      const view = getView(sessionId)
      const root = rootRun(view)
      const runId = root?.runId ?? sessionId
      // 批准即创建执行待办列表（ADR-0038）：条目 id 与步骤 id 相同，状态由列表事件推进。
      // 先发 `tasklist.created` 再发 `plan.approved`，保证列表事件之后到达时能定位到它。
      const listId = taskListIdForPlan(planId)
      const batch: UnsequencedEvent[] = []
      for (const list of view.taskLists) {
        if (list.source === 'plan' && !list.closed && list.planId !== planId) {
          batch.push({
            ...header(sessionId, runId),
            type: 'tasklist.closed',
            payload: { listId: list.listId, reason: 'superseded' },
          })
        }
      }
      if (!view.taskLists.some((list) => list.listId === listId)) {
        batch.push({
          ...header(sessionId, runId),
          type: 'tasklist.created',
          payload: {
            listId,
            title: content.goal,
            source: 'plan',
            planId,
            items: content.steps.map((step) => ({ itemId: step.id, title: step.title })),
          },
        })
      }
      batch.push({
        ...header(sessionId, runId),
        type: 'plan.approved',
        payload: { planId, content },
      })
      events.publish(batch)
      return manager.prompt({
        sessionId,
        content: [{ type: 'text', text: approvedPlanMessage(plan.content, content) }],
      })
    },

    replan({ sessionId, planId, feedback }) {
      requirePendingPlan(sessionId, planId)
      const root = rootRun(getView(sessionId))
      events.publish([
        {
          ...header(sessionId, root?.runId ?? sessionId),
          type: 'plan.rejected',
          payload: { planId, feedback },
        },
      ])
      return manager.prompt({
        sessionId,
        content: [{ type: 'text', text: feedback }],
        mode: 'plan',
      })
    },

    abandonPlan({ sessionId, planId }) {
      requirePendingPlan(sessionId, planId)
      const root = rootRun(getView(sessionId))
      events.publish([
        {
          ...header(sessionId, root?.runId ?? sessionId),
          type: 'plan.rejected',
          payload: { planId },
        },
      ])
      return {}
    },

    async compact({ sessionId }) {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireSession(sessionId)
      if (options.isLocked?.(sessionId)) throw new RpcError(SessionErrorCode.Busy, { sessionId })
      const slot = slots.get(sessionId)
      if (waiting.has(sessionId) || (slot && slot.handle?.state() !== 'running')) {
        throw new RpcError(SessionErrorCode.Busy, { sessionId })
      }
      if (slot?.handle) return { compacted: await slot.handle.compact() }
      const recorded = events.readAfter(sessionId, 0)
      const root = rootRun(getView(sessionId))
      if (!root) return { compacted: false }
      const history = rebuildHistory(recorded, { runId: root.runId })
      const summarize = options.summarize
      const outcome = await compactConversation({
        messages: history,
        budget: options.contextBudget?.(sessionId) ?? {
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          overheadTokens: 0,
        },
        force: true,
        ...(summarize
          ? { summarize: (transcript: string) => summarize(sessionId, transcript) }
          : {}),
        now: now(),
      })
      if (outcome.kind === 'none') return { compacted: false }
      const payload = compactionEventPayload(outcome)
      const range = coveredSeqRange(recorded, outcome.coversTurns)
      events.publish([
        {
          ...header(sessionId, root.runId),
          type: 'context.compacted',
          payload: range ? { ...payload, replacedSeq: [range[0], range[1]] } : payload,
        },
      ])
      return { compacted: true }
    },

    updateBrief({ sessionId, content }) {
      if (closed) throw new RpcError(SessionErrorCode.Closed)
      requireSession(sessionId)
      const next = content.trim()
      const current = latestBrief(events.readAfter(sessionId, 0))?.content ?? ''
      if (current === next) return {}
      const root = rootRun(getView(sessionId))
      events.publish([
        {
          ...header(sessionId, root?.runId ?? sessionId),
          type: 'session.brief.updated',
          payload: { content: next, editedBy: 'user' },
        },
      ])
      return {}
    },

    async abort({ sessionId }) {
      requireSession(sessionId)
      // 排队中的输入直接取消（用户消息保留在历史中）；这一轮不会产生 turn.aborted，
      // 因此要在目标锁内暂停活动目标，避免目标停在“active 但没有轮次”（ADR-0047）。
      if (waiting.delete(sessionId)) {
        await withGoalLock(sessionId, () => pauseActiveGoal(sessionId, 'user'))
        return {}
      }
      const slot = slots.get(sessionId)
      if (slot && !slot.handle) slot.cancelled = true
      if (slot?.handle?.state() === 'running') {
        const root = rootRun(getView(sessionId))
        const activeTurn = root !== undefined && isActiveRunState(root.state)
        await slot.handle.abort('user')
        // 运行中的轮次由 GoalService 监听 turn.aborted(user) 后统一暂停，避免两条暂停事件；
        // 宿主空闲或正在判定时不会产生轮次事件，这里直接暂停。
        if (!activeTurn) {
          await withGoalLock(sessionId, () => pauseActiveGoal(sessionId, 'user'))
        }
        return {}
      }
      // 宿主还没启动或已经退出：没有轮次事件，直接暂停。
      await withGoalLock(sessionId, () => pauseActiveGoal(sessionId, 'user'))
      return {}
    },

    isBusy: sessionBusy,

    recoverInterrupted() {
      if (recovered) return 0
      recovered = true
      let count = 0
      for (const session of storage.sessions.list({
        includeArchived: true,
        includeTrial: true,
      })) {
        if (slots.has(session.sessionId)) continue
        try {
          count += markInterrupted(session.sessionId, 'app_restart')
        } catch (error) {
          onError(error)
        }
      }
      return count
    },

    activeSessions: () => [...slots.keys()],
    queuedSessions: () => [...waiting.keys()],

    refreshPermissions(sessionIds) {
      for (const [sessionId, slot] of slots) {
        if (sessionIds && !sessionIds.includes(sessionId)) continue
        slot.handle?.refreshPermissions().catch(onError)
      }
    },

    refreshTools() {
      for (const [sessionId, slot] of slots) {
        slot.stale = true
        updateIdle(sessionId, slot)
      }
    },

    async shutdown() {
      closed = true
      waiting.clear()
      unsubscribe()
      const all = [...slots.values()]
      for (const slot of all) {
        if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
        slot.idleTimer = undefined
        if (slot.handle) void slot.handle.stop()
      }
      await Promise.all(all.map((slot) => slot.gone))
    },
  }

  function requirePendingPlan(sessionId: string, planId: string) {
    if (closed) throw new RpcError(SessionErrorCode.Closed)
    requireSession(sessionId)
    if (sessionBusy(sessionId) || options.isLocked?.(sessionId)) {
      throw new RpcError(SessionErrorCode.Busy, { sessionId })
    }
    const plan = getView(sessionId).plans.find((item) => item.planId === planId)
    if (!plan || plan.status !== 'proposed') {
      throw new RpcError(SessionErrorCode.PlanNotPending, { planId })
    }
    return plan
  }

  return manager
}

const sameModel = (a: ModelRef, b: ModelRef): boolean =>
  a.providerId === b.providerId && a.modelId === b.modelId
