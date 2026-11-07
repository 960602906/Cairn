/**
 * RunSupervisor：管理一个会话宿主中的运行（Runtime §4、§17）。
 *
 * 接口按 Runtime §17 完整定义；M0 只实现单运行版本：同一时间只有一个未释放的运行，
 * 审批（`resolveApproval`）在 M1 接入。多 Agent 委派（ADR-0020）在之后的阶段放开数量限制。
 *
 * 用户在运行中继续输入时（Runtime §9）：
 * - `queue`（默认）：排在当前轮次之后，按发送顺序依次执行；
 * - `steer`：交给运行时在下一次调用模型前插入，不打断工具；没有进行中的轮次时按 `queue` 处理；
 * - `interrupt`：先中止当前轮次，再进入队列。
 */
import type {
  AgentDefinitionRef,
  CanonicalMessage,
  ContentPart,
  EventPayload,
  RunLimits,
  RunMode,
  RunState,
  UnsequencedEvent,
} from '@cairn/protocol'
import {
  RunEngine,
  RunEngineError,
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
  /** M0 同一时间只支持一个运行。 */
  TooManyRuns: 'run.too_many_runs',
  /** M0 未实现的能力（如审批）。 */
  Unsupported: 'run.unsupported',
} as const

/** 运行发出的事件（尚无 seq，由主进程分配）。 */
export type RunEvent = UnsequencedEvent

export type ApprovalDecision = Exclude<EventPayload<'approval.resolved'>['decision'], 'cancelled'>

export type SendMode = 'queue' | 'steer' | 'interrupt'

export interface RunInput {
  /** 主进程已落库的 `message.user` 的 id。 */
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
  /** 新运行的 id；省略时由 `createId` 生成。恢复时以 `restoreFrom.runId` 为准。 */
  readonly runId?: string
  readonly agent: AgentDefinitionRef
  readonly workspace: WorkspaceInfo
  readonly parentRunId?: string
  readonly mode: RunMode
  readonly limitsOverride?: Partial<RunLimits>
  readonly restoreFrom?: RunRestoreData
}

export interface AgentRunHandle {
  readonly runId: string
  readonly state: RunState
  readonly workspace: WorkspaceInfo
  /** 本次输入对应的轮次结束后 resolve。 */
  send(input: RunInput, mode?: SendMode): Promise<void>
  abort(reason?: 'user' | 'shutdown'): Promise<void>
  resolveApproval(approvalId: string, decision: ApprovalDecision): void
  updateLimits(limits: Partial<RunLimits>): void
  /** 订阅此后发出的事件（创建时的 `run.created` 请用 `RunSupervisor.onEvent` 接收）。 */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe
  dispose(reason?: string): Promise<void>
}

export interface RunSupervisor {
  createRun(init: CreateRunInput): Promise<AgentRunHandle>
  getRun(runId: string): AgentRunHandle | undefined
  abortAll(reason: 'user' | 'shutdown'): Promise<void>
  /** 订阅所有运行的事件（宿主据此转发 `host.event`）。 */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe
  /** 释放所有运行。 */
  dispose(): Promise<void>
}

export interface RunSupervisorOptions {
  readonly runtime: AgentRuntime
  readonly model: ResolvedModel
  /** Agent 定义中的默认限额（`limitsOverride` 在此之上覆盖）。 */
  readonly limits: RunLimits
  readonly systemPrompt?: string
  /** 每轮开始前准备系统提示词和 `turn.started` 上下文（M3-02）。 */
  readonly prepareTurn?: () => Promise<TurnPreparation | undefined>
  readonly tools?: readonly RuntimeToolSpec[]
  readonly executeTool?: ToolExecutor
  /** 工具流水线（M1-05b）；给出时优先于 `executeTool`。 */
  readonly toolPipeline?: ToolPipeline
  /** 每轮开始时的检查点（M1-12b）。 */
  readonly checkpoints?: ToolCheckpoints
  readonly onCheckpointError?: (error: unknown) => void
  /** 模型请求的重试策略（M1-14a），默认 `DEFAULT_RETRY_POLICY`。 */
  readonly retry?: RetryPolicy
  /** 宿主级中止信号。 */
  readonly signal: AbortSignalLike
  readonly now?: () => number
  readonly createId?: () => string
}

class RunHandle implements AgentRunHandle {
  readonly runId: string
  readonly workspace: WorkspaceInfo
  readonly #engine: RunEngine
  readonly #listeners: Set<(event: RunEvent) => void>
  readonly #onDisposed: () => void
  /** 排队输入的执行链。 */
  #queue: Promise<void> = Promise.resolve()

  constructor(
    engine: RunEngine,
    workspace: WorkspaceInfo,
    listeners: Set<(event: RunEvent) => void>,
    onDisposed: () => void,
  ) {
    this.runId = engine.runId
    this.workspace = workspace
    this.#engine = engine
    this.#listeners = listeners
    this.#onDisposed = onDisposed
  }

  get state(): RunState {
    return this.#engine.state
  }

  async send(input: RunInput, mode: SendMode = 'queue'): Promise<void> {
    if (mode === 'steer' && (await this.#engine.steer(input))) return
    if (mode === 'interrupt') await this.#engine.abort('user')
    const job = this.#queue.then(() => this.#engine.prompt(input))
    // 一次输入失败（例如运行已释放）不影响之后的排队输入
    this.#queue = job.catch(() => {})
    return job
  }

  abort(reason: 'user' | 'shutdown' = 'user'): Promise<void> {
    return this.#engine.abort(reason)
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

  async dispose(reason?: string): Promise<void> {
    await this.#engine.dispose(reason)
    this.#listeners.clear()
    this.#onDisposed()
  }
}

/** 单运行版本的 RunSupervisor（M0）。 */
export function createRunSupervisor(options: RunSupervisorOptions): RunSupervisor {
  const runs = new Map<string, RunHandle>()
  const listeners = new Set<(event: RunEvent) => void>()
  let counter = 0
  const createId = options.createId ?? (() => `run-${++counter}`)

  return {
    async createRun(init) {
      if (runs.size > 0) throw new RunEngineError(RunSupervisorErrorCode.TooManyRuns)
      const runId = init.restoreFrom?.runId ?? init.runId ?? createId()
      const runListeners = new Set<(event: RunEvent) => void>()
      const engine = await RunEngine.create({
        sessionId: init.sessionId,
        runId,
        ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
        agent: init.agent,
        mode: init.mode,
        limits: { ...options.limits, ...init.limitsOverride } as RunLimits,
        runtime: options.runtime,
        model: options.model,
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(options.prepareTurn ? { prepareTurn: options.prepareTurn } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.executeTool ? { executeTool: options.executeTool } : {}),
        ...(options.toolPipeline ? { toolPipeline: options.toolPipeline } : {}),
        ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
        ...(options.onCheckpointError ? { onCheckpointError: options.onCheckpointError } : {}),
        ...(options.retry ? { retry: options.retry } : {}),
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
      const handle = new RunHandle(engine, init.workspace, runListeners, () => runs.delete(runId))
      runs.set(runId, handle)
      return handle
    },

    getRun: (runId) => runs.get(runId),

    async abortAll(reason) {
      await Promise.all([...runs.values()].map((run) => run.abort(reason)))
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async dispose() {
      await Promise.all([...runs.values()].map((run) => run.dispose('shutdown')))
      listeners.clear()
    },
  }
}
