/**
 * RunSupervisor：管理一个会话宿主中的运行（Runtime §4、§17；ADR-0020、ADR-0030）。
 *
 * M4-01 支持同一会话宿主内管理 N 个运行：
 * - 每个运行有独立的 RunEngine、运行时会话、模型、系统提示词、工具、检查点与中止信号；
 * - 父运行在等待子运行期间进入 awaiting_children；
 * - 取消信号树：父运行中止时级联中止子运行；单个子运行中止时父运行继续，子运行结果标记为 aborted；
 * - 预算继承：子运行限额继承自父运行剩余预算、任务书限额与 Agent 限额的交集；子运行消耗计入父运行本轮消耗；
 * - 运行 id 在会话内全局唯一，释放后自动从管理器中清理。
 */
import type {
  RunAgentRef,
  CanonicalMessage,
  ContentPart,
  EventPayload,
  EventType,
  RunLimits,
  RunMode,
  RunState,
  TokenUsage,
  UnsequencedEvent,
} from '@cairn/protocol'
import {
  type ModelCallSnapshot,
  RunEngine,
  RunEngineError,
  RunEngineErrorCode,
  type RetryPolicy,
  type ToolExecutor,
  type TurnPreparation,
} from './run-engine.js'
import type { ToolPipeline } from './tool-pipeline.js'
import type { ToolCheckpoints } from './tools.js'
import type {
  AbortSignalLike,
  AgentRuntime,
  ResolvedModel,
  RuntimeToolSpec,
  Unsubscribe,
} from './runtime.js'

export const RunSupervisorErrorCode = {
  /** 达到允许的最大运行数。 */
  TooManyRuns: 'run.too_many_runs',
  /** 运行 id 已存在。 */
  DuplicateRun: 'run.duplicate_run',
  /** 指定的父运行不存在。 */
  ParentNotFound: 'run.parent_not_found',
  /** 未实现或不支持的能力。 */
  Unsupported: 'run.unsupported',
} as const

/** 运行发出的事件（尚无 seq，由主进程分配）。 */
export type RunEvent = UnsequencedEvent

export type ApprovalDecision = Exclude<EventPayload<'approval.resolved'>['decision'], 'cancelled'>

export type SendMode = 'queue' | 'steer' | 'interrupt'

export interface RunInput {
  /** 主进程已落库的 message.user 的 id。 */
  readonly messageId: string
  readonly content: readonly ContentPart[]
}

export interface WorkspaceInfo {
  /** agent 工作的目录（架构 §14.3）。 */
  readonly path: string
}

export interface RunRestoreData {
  readonly runId: string
  readonly history: readonly CanonicalMessage[]
  readonly state: RunState
}

export interface CreateRunInput {
  readonly sessionId: string
  /** 新运行的 id；省略时由 createId 生成。恢复时以 restoreFrom.runId 为准。 */
  readonly runId?: string
  readonly agent: RunAgentRef
  readonly workspace: WorkspaceInfo
  readonly parentRunId?: string
  readonly mode: RunMode
  readonly limitsOverride?: Partial<RunLimits>
  readonly restoreFrom?: RunRestoreData
  /**
   * 这个运行的上下文（M4-01/M4-02）：子运行由委派直接给出运行时、模型、系统提示词与工具，
   * 省略时由 `createRunContext` 创建。
   */
  readonly context?: RunContext
}

export interface AgentRunHandle {
  readonly runId: string
  readonly parentRunId?: string | undefined
  readonly state: RunState
  readonly workspace: WorkspaceInfo
  readonly remainingLimits?: Partial<RunLimits> | undefined
  /** 本次输入对应的轮次结束后 resolve。 */
  send(input: RunInput, mode?: SendMode): Promise<void>
  /** 立刻压缩上下文（M3-03）。排在已有输入之后；返回是否压缩了或已排上。 */
  compact(): Promise<boolean>
  abort(reason?: 'user' | 'shutdown'): Promise<void>
  resolveApproval(approvalId: string, decision: ApprovalDecision): void
  updateLimits(limits: Partial<RunLimits>): void
  /** 在执行子运行期间包裹父运行，进入 awaiting_children，结束后恢复 tooling。 */
  awaitChildren<T>(action: () => Promise<T>): Promise<T>
  setAwaitingChildren(waiting: boolean): void
  /** 将子运行产生的用量累加到父运行当前轮次（ADR-0030）。 */
  recordChildUsage(usage: TokenUsage): void
  /** 以这个运行的信封发出一条事件（M4-02）：委派事件归在父运行名下。 */
  emitEvent<T extends EventType>(type: T, payload: EventPayload<T>): void
  /** 订阅此后发出的事件（创建时的 run.created 请用 RunSupervisor.onEvent 接收）。 */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe
  /** 委派子运行完成后释放其占用的名额，同时保留可查询的运行树记录。重复调用无效果。 */
  completeChild(): void
  dispose(reason?: string): Promise<void>
}

export interface RunSupervisor {
  createRun(init: CreateRunInput): Promise<AgentRunHandle>
  getRun(runId: string): AgentRunHandle | undefined
  listRuns(): readonly AgentRunHandle[]
  listChildren(parentRunId: string): readonly AgentRunHandle[]
  abortAll(reason?: 'user' | 'shutdown'): Promise<void>
  /** 订阅所有运行的事件（宿主据此转发 host.event）。 */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe
  /** 释放所有运行。 */
  dispose(): Promise<void>
}

/** 单个运行的上下文，支持按运行独立定义模型、运行时、系统提示词与工具。 */
export interface RunContext {
  readonly runtime?: AgentRuntime | undefined
  readonly model?: ResolvedModel | undefined
  readonly limits?: RunLimits | undefined
  readonly systemPrompt?: string | undefined
  readonly prepareTurn?: (() => Promise<TurnPreparation | undefined>) | undefined
  readonly summarize?: ((transcript: string) => Promise<string | undefined>) | undefined
  readonly sessionBrief?: (() => Promise<string | undefined>) | undefined
  readonly onModelCall?: ((snapshot: ModelCallSnapshot) => void | Promise<void>) | undefined
  readonly onModelCallError?: ((error: unknown) => void) | undefined
  readonly tools?: readonly RuntimeToolSpec[] | undefined
  readonly executeTool?: ToolExecutor | undefined
  readonly toolPipeline?: ToolPipeline | undefined
  readonly checkpoints?: ToolCheckpoints | undefined
  readonly onCheckpointError?: ((error: unknown) => void) | undefined
  readonly retry?: RetryPolicy | undefined
}

export type CreateRunContext = (init: CreateRunInput) => Promise<RunContext> | RunContext

export interface RunSupervisorOptions {
  /** 按运行创建独立上下文（M4-01），优先于全局默认配置。 */
  readonly createRunContext?: CreateRunContext
  readonly runtime?: AgentRuntime
  readonly model?: ResolvedModel
  /** Agent 定义中的默认限额（limitsOverride 在此之上覆盖）。 */
  readonly limits?: RunLimits
  readonly systemPrompt?: string
  /** 每轮开始前准备系统提示词和 turn.started 上下文（M3-02）。 */
  readonly prepareTurn?: () => Promise<TurnPreparation | undefined>
  /** 上下文压缩的摘要（M3-03）。 */
  readonly summarize?: (transcript: string) => Promise<string | undefined>
  /** 会话要点（M3-04）。见 RunEngineOptions.sessionBrief。 */
  readonly sessionBrief?: () => Promise<string | undefined>
  /** 每次模型调用前的实际上下文（M4-04）。 */
  readonly onModelCall?: (snapshot: ModelCallSnapshot) => void | Promise<void>
  readonly onModelCallError?: (error: unknown) => void
  readonly tools?: readonly RuntimeToolSpec[]
  readonly executeTool?: ToolExecutor
  /** 工具流水线（M1-05b）；给出时优先于 executeTool。 */
  readonly toolPipeline?: ToolPipeline
  /** 每轮开始时的检查点（M1-12b）。 */
  readonly checkpoints?: ToolCheckpoints
  readonly onCheckpointError?: (error: unknown) => void
  /** 模型请求的重试策略（M1-14a），默认 DEFAULT_RETRY_POLICY。 */
  readonly retry?: RetryPolicy
  /** 宿主级中止信号。 */
  readonly signal: AbortSignalLike
  readonly now?: () => number
  readonly createId?: () => string
  /**
   * 同时存在的运行上限（M4-13）。达到上限时新的根运行排队等待，而不是失败。
   * 省略时不限制。
   */
  readonly maxRuns?: number
  /** 排队等待运行名额的上限，默认 32；队列满了才抛出 TooManyRuns。 */
  readonly maxQueuedRuns?: number
  /**
   * 名额已满时，子运行（带 parentRunId）允许临时超出的数量，默认 8。
   *
   * 子运行不能排队：父运行在等待子运行期间无法释放自己的名额，父子互相等待会死锁。
   * 子运行的数量由委派策略（并发、深度、每轮数量）约束，这里只防止策略配置错误导致无上限增长。
   */
  readonly maxOverflowRuns?: number
}

/** `maxQueuedRuns` 的默认值。 */
export const DEFAULT_MAX_QUEUED_RUNS = 32

/** `maxOverflowRuns` 的默认值。 */
export const DEFAULT_MAX_OVERFLOW_RUNS = 8

export interface ComputeChildLimitsInput {
  readonly childAgentLimits?: Partial<RunLimits> | undefined
  readonly taskLimits?: Partial<RunLimits> | undefined
  readonly parentRemainingLimits?: Partial<RunLimits> | undefined
  readonly childBudgetShare?: number | undefined
}

/**
 * 预算继承（ADR-0030）：
 * 子运行限额取“子 Agent 限额、任务书预算、父运行剩余预算 × childBudgetShare”三者的最小值。
 */
export function computeChildLimits(input: ComputeChildLimitsInput): RunLimits {
  const { childAgentLimits, taskLimits, parentRemainingLimits, childBudgetShare } = input
  const share =
    typeof childBudgetShare === 'number' && Number.isFinite(childBudgetShare)
      ? Math.max(0, Math.min(1, childBudgetShare))
      : 1

  const minOf = (
    a: number | undefined,
    b: number | undefined,
    parentVal: number | undefined,
  ): number | undefined => {
    const parentBudget = parentVal !== undefined ? Math.floor(parentVal * share) : undefined
    const candidates = [a, b, parentBudget].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    )
    if (candidates.length === 0) return undefined
    return Math.min(...candidates)
  }

  const result: Partial<RunLimits> = {}

  const steps = minOf(
    childAgentLimits?.maxStepsPerTurn,
    taskLimits?.maxStepsPerTurn,
    parentRemainingLimits?.maxStepsPerTurn,
  )
  if (steps !== undefined) result.maxStepsPerTurn = Math.max(1, steps)

  const tokens = minOf(
    childAgentLimits?.maxTokensPerTurn,
    taskLimits?.maxTokensPerTurn,
    parentRemainingLimits?.maxTokensPerTurn,
  )
  if (tokens !== undefined) result.maxTokensPerTurn = Math.max(1, tokens)

  const duration = minOf(
    childAgentLimits?.maxTurnDurationMs,
    taskLimits?.maxTurnDurationMs,
    parentRemainingLimits?.maxTurnDurationMs,
  )
  if (duration !== undefined) result.maxTurnDurationMs = duration

  const cost = minOf(
    childAgentLimits?.maxCostPerTurn,
    taskLimits?.maxCostPerTurn,
    parentRemainingLimits?.maxCostPerTurn,
  )
  if (cost !== undefined) result.maxCostPerTurn = cost

  if (childAgentLimits?.maxConsecutiveToolErrors !== undefined) {
    result.maxConsecutiveToolErrors = childAgentLimits.maxConsecutiveToolErrors
  } else if (taskLimits?.maxConsecutiveToolErrors !== undefined) {
    result.maxConsecutiveToolErrors = taskLimits.maxConsecutiveToolErrors
  }

  return result as RunLimits
}

class RunHandle implements AgentRunHandle {
  readonly runId: string
  readonly parentRunId?: string | undefined
  readonly workspace: WorkspaceInfo
  readonly #engine: RunEngine
  readonly #getChildren: (parentRunId: string) => readonly RunHandle[]
  readonly #listeners: Set<(event: RunEvent) => void>
  readonly #onDisposed: () => void
  readonly #onCompleteChild: () => void
  /** 排队输入的执行链。 */
  #queue: Promise<void> = Promise.resolve()

  constructor(
    engine: RunEngine,
    workspace: WorkspaceInfo,
    listeners: Set<(event: RunEvent) => void>,
    parentRunId: string | undefined,
    getChildren: (parentRunId: string) => readonly RunHandle[],
    onDisposed: () => void,
    onCompleteChild: () => void,
  ) {
    this.runId = engine.runId
    this.parentRunId = parentRunId
    this.workspace = workspace
    this.#engine = engine
    this.#listeners = listeners
    this.#getChildren = getChildren
    this.#onDisposed = onDisposed
    this.#onCompleteChild = onCompleteChild
  }

  get state(): RunState {
    return this.#engine.state
  }

  get remainingLimits(): Partial<RunLimits> {
    return this.#engine.remainingLimits
  }

  async send(input: RunInput, mode: SendMode = 'queue'): Promise<void> {
    if (mode === 'steer' && (await this.#engine.steer(input))) return
    if (mode === 'interrupt') await this.abort('user')
    const job = this.#queue.then(() => this.#engine.prompt(input))
    // 一次输入失败（例如运行已释放）不影响之后的排队输入
    this.#queue = job.catch(() => {})
    return job
  }

  compact(): Promise<boolean> {
    const job = this.#queue.then(() => this.#engine.compact())
    this.#queue = job.then(
      () => {},
      () => {},
    )
    return job
  }

  async abort(reason: 'user' | 'shutdown' = 'user'): Promise<void> {
    // 级联中止所有子运行（ADR-0030 取消树）
    const children = this.#getChildren(this.runId)
    await Promise.all(children.map((child) => child.abort(reason)))
    await this.#engine.abort(reason)
  }

  async awaitChildren<T>(action: () => Promise<T>): Promise<T> {
    this.#engine.awaitingChildren(true)
    try {
      return await action()
    } finally {
      this.#engine.awaitingChildren(false)
    }
  }

  setAwaitingChildren(waiting: boolean): void {
    this.#engine.awaitingChildren(waiting)
  }

  recordChildUsage(usage: TokenUsage): void {
    this.#engine.recordChildUsage(usage)
  }

  emitEvent<T extends EventType>(type: T, payload: EventPayload<T>): void {
    this.#engine.emitEvent(type, payload)
  }

  resolveApproval(): void {
    throw new RunEngineError(RunSupervisorErrorCode.Unsupported)
  }

  updateLimits(limits: Partial<RunLimits>): void {
    this.#engine.updateLimits(limits)
  }

  onEvent(listener: (event: RunEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  completeChild(): void {
    this.#onCompleteChild()
  }

  async dispose(reason?: string): Promise<void> {
    const children = this.#getChildren(this.runId)
    await Promise.all(children.map((child) => child.dispose(reason)))
    await this.#engine.dispose(reason)
    this.#listeners.clear()
    this.#onDisposed()
  }
}

/** 多运行调度的 RunSupervisor（M4-01，ADR-0030）。 */
export function createRunSupervisor(options: RunSupervisorOptions): RunSupervisor {
  const runs = new Map<string, RunHandle>()
  const listeners = new Set<(event: RunEvent) => void>()
  let counter = 0
  const createId = options.createId ?? (() => `run-${++counter}`)
  const maxRuns = options.maxRuns
  const maxQueuedRuns = options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS
  const maxOverflowRuns = options.maxOverflowRuns ?? DEFAULT_MAX_OVERFLOW_RUNS
  /** 占用运行名额的运行：创建中或创建后到释放前。 */
  const active = new Set<string>()
  /** 创建中的 id 在异步创建完成前也必须保持唯一。 */
  const creating = new Set<string>()
  /** 已完成的子运行按 id 保留在 runs 中，但不再占用并发名额或参与取消树。 */
  const completedChildren = new Set<string>()
  /** 等待名额的根运行；Map 保持插入顺序，即到达顺序。 */
  const waiting = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>()
  let closed = false
  const onShutdown = () => {
    for (const waiter of waiting.values()) {
      waiter.reject(new RunEngineError(RunEngineErrorCode.Disposed))
    }
    waiting.clear()
  }
  options.signal.addEventListener('abort', onShutdown)
  if (options.signal.aborted) onShutdown()

  /** 释放名额并按排队顺序补位。 */
  const release = (runId: string): void => {
    if (!active.delete(runId)) return
    pump()
  }

  function pump(): void {
    if (closed || maxRuns === undefined) return
    while (active.size < maxRuns) {
      const next = waiting.entries().next()
      if (next.done) return
      const [runId, waiter] = next.value
      waiting.delete(runId)
      if (options.signal.aborted) {
        waiter.reject(new RunEngineError(RunEngineErrorCode.Disposed))
        continue
      }
      active.add(runId)
      waiter.resolve()
    }
  }

  const getChildren = (parentRunId: string): readonly RunHandle[] => {
    const result: RunHandle[] = []
    for (const run of runs.values()) {
      if (run.parentRunId === parentRunId) result.push(run)
    }
    return result
  }

  const getActiveChildren = (parentRunId: string): readonly RunHandle[] =>
    getChildren(parentRunId).filter((run) => !completedChildren.has(run.runId))

  async function createHandle(init: CreateRunInput, runId: string): Promise<RunHandle> {
    const runListeners = new Set<(event: RunEvent) => void>()
    const ctx =
      init.context ?? (options.createRunContext ? await options.createRunContext(init) : {})
    if (closed || options.signal.aborted) throw new RunEngineError(RunEngineErrorCode.Disposed)
    const runtime = ctx.runtime ?? options.runtime
    const model = ctx.model ?? options.model
    if (!runtime || !model) {
      throw new RunEngineError(
        RunSupervisorErrorCode.Unsupported,
        'runtime and model are required for run creation',
      )
    }

    const baseLimits = ctx.limits ?? options.limits ?? {}
    const limits = { ...baseLimits, ...init.limitsOverride } as RunLimits

    const engine = await RunEngine.create({
      sessionId: init.sessionId,
      runId,
      ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
      agent: init.agent,
      mode: init.mode,
      limits,
      runtime,
      model,
      ...(ctx.systemPrompt !== undefined
        ? { systemPrompt: ctx.systemPrompt }
        : options.systemPrompt !== undefined
          ? { systemPrompt: options.systemPrompt }
          : {}),
      ...(ctx.prepareTurn
        ? { prepareTurn: ctx.prepareTurn }
        : options.prepareTurn
          ? { prepareTurn: options.prepareTurn }
          : {}),
      ...(ctx.summarize
        ? { summarize: ctx.summarize }
        : options.summarize
          ? { summarize: options.summarize }
          : {}),
      ...(ctx.sessionBrief
        ? { sessionBrief: ctx.sessionBrief }
        : options.sessionBrief
          ? { sessionBrief: options.sessionBrief }
          : {}),
      ...(ctx.onModelCall
        ? { onModelCall: ctx.onModelCall }
        : options.onModelCall
          ? { onModelCall: options.onModelCall }
          : {}),
      ...(ctx.onModelCallError
        ? { onModelCallError: ctx.onModelCallError }
        : options.onModelCallError
          ? { onModelCallError: options.onModelCallError }
          : {}),
      ...(ctx.tools ? { tools: ctx.tools } : options.tools ? { tools: options.tools } : {}),
      ...(ctx.executeTool
        ? { executeTool: ctx.executeTool }
        : options.executeTool
          ? { executeTool: options.executeTool }
          : {}),
      ...(ctx.toolPipeline
        ? { toolPipeline: ctx.toolPipeline }
        : options.toolPipeline
          ? { toolPipeline: options.toolPipeline }
          : {}),
      ...(ctx.checkpoints
        ? { checkpoints: ctx.checkpoints }
        : options.checkpoints
          ? { checkpoints: options.checkpoints }
          : {}),
      ...(ctx.onCheckpointError
        ? { onCheckpointError: ctx.onCheckpointError }
        : options.onCheckpointError
          ? { onCheckpointError: options.onCheckpointError }
          : {}),
      ...(ctx.retry ? { retry: ctx.retry } : options.retry ? { retry: options.retry } : {}),
      ...(init.restoreFrom
        ? { restore: { history: init.restoreFrom.history, state: init.restoreFrom.state } }
        : {}),
      signal: options.signal,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
      emit: (event) => {
        for (const l of listeners) l(event)
        for (const l of runListeners) l(event)
      },
    })

    if (closed || options.signal.aborted) {
      await engine.dispose('shutdown')
      throw new RunEngineError(RunEngineErrorCode.Disposed)
    }
    const handle = new RunHandle(
      engine,
      init.workspace,
      runListeners,
      init.parentRunId,
      getActiveChildren,
      () => {
        runs.delete(runId)
        completedChildren.delete(runId)
        release(runId)
      },
      () => {
        if (init.parentRunId !== undefined) {
          completedChildren.add(runId)
          release(runId)
        }
      },
    )
    runs.set(runId, handle)
    return handle
  }

  return {
    async createRun(init) {
      if (closed || options.signal.aborted) throw new RunEngineError(RunEngineErrorCode.Disposed)
      const runId = init.restoreFrom?.runId ?? init.runId ?? createId()
      if (runs.has(runId) || creating.has(runId)) {
        throw new RunEngineError(RunSupervisorErrorCode.DuplicateRun, `run ${runId} already exists`)
      }
      creating.add(runId)

      try {
        if (maxRuns !== undefined && (active.size >= maxRuns || waiting.size > 0)) {
          if (init.parentRunId !== undefined) {
            if (active.size >= maxRuns + maxOverflowRuns) {
              throw new RunEngineError(
                RunSupervisorErrorCode.TooManyRuns,
                `run ${runId} exceeds the child run capacity`,
              )
            }
            // 子运行直接占用一个名额：父运行正等着它，排队会父子互相等待。
            active.add(runId)
          } else {
            if (waiting.size >= maxQueuedRuns) {
              throw new RunEngineError(
                RunSupervisorErrorCode.TooManyRuns,
                `run ${runId} exceeds the run queue capacity`,
              )
            }
            // 名额由 pump 授予，届时 active 已包含 runId。
            await new Promise<void>((resolve, reject) => waiting.set(runId, { resolve, reject }))
          }
        } else {
          active.add(runId)
        }

        if (closed || options.signal.aborted) throw new RunEngineError(RunEngineErrorCode.Disposed)
        const handle = await createHandle(init, runId)
        return handle
      } catch (error) {
        release(runId)
        throw error
      } finally {
        creating.delete(runId)
      }
    },

    getRun: (runId) => runs.get(runId),
    listRuns: () => [...runs.values()],
    listChildren: (parentRunId) => getChildren(parentRunId),

    async abortAll(reason = 'user') {
      await Promise.all([...runs.values()].map((run) => run.abort(reason)))
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async dispose() {
      closed = true
      onShutdown()
      await Promise.all([...runs.values()].map((run) => run.dispose('shutdown')))
      // 创建中但尚无 RunHandle 的名额由各自的 createRun finally 清理。
      options.signal.removeEventListener('abort', onShutdown)
      listeners.clear()
    },
  }
}
