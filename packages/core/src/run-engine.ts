/**
 * RunEngine：单个运行的编排（Runtime §4、§5、§6、§10.3）。
 *
 * 把 `AgentRuntime` 的运行时事件转换为协议事件（无 seq，由主进程分配，ADR-0005），
 * 管理轮次与步骤边界，并驱动运行状态机（M0-06a）。每次状态转换都发出 `run.state.changed`。
 *
 * 一轮的事件顺序：
 *
 * ```
 * turn.started → run.state.changed(→thinking)
 * ( step.started → message.*.delta* → message.assistant.completed? → step.completed → usage.reported?
 *   [ run.state.changed(→tooling) → tool.requested → tool.started → tool.completed|failed|cancelled
 *     → run.state.changed(→thinking) ] )*
 * 结束：
 *   完成  run.state.changed(→completed) → turn.completed
 *   中止  run.state.changed(→aborting) … run.state.changed(→idle) → turn.aborted
 *   失败  run.state.changed(→failed) → turn.failed
 *   限额  turn.limit_reached → run.state.changed(→failed) → turn.failed（retryable）
 * ```
 *
 * `message.user` 由主进程落库（`host.prompt` 携带其 messageId），RunEngine 不重复发出。
 * 工具的权限与审批在 M1 接入；M0 中所有工具调用直接放行，交给注入的 `executeTool`。
 */
import type {
  ContentPart,
  ErrorInfo,
  EventPayload,
  EventType,
  ModelRef,
  RunLimits,
  RunMode,
  RunState,
  AgentDefinitionRef,
  CanonicalMessage,
  UnsequencedEvent,
} from '@nexus/protocol'
import { acceptsInput, canTransition, isActiveRunState } from './run-state.js'
import type {
  AbortSignalLike,
  AgentRuntime,
  ResolvedModel,
  RuntimeEvent,
  RuntimeSession,
  RuntimeToolCall,
  RuntimeToolResult,
  RuntimeToolSpec,
} from './runtime.js'

export const RunEngineErrorCode = {
  /** 当前状态不能接受输入（运行中或已释放）。 */
  Busy: 'run.busy',
  Disposed: 'run.disposed',
  /** 达到限额，`params.limit` 为限额名。 */
  LimitReached: 'run.limit_reached',
  ToolNotAvailable: 'tool.not_available',
  ToolFailed: 'tool.failed',
  ToolDenied: 'tool.denied',
  /** 运行时报告失败但未给出错误。 */
  ModelUnknown: 'model.unknown_error',
  /** 运行时或钩子抛出异常、或未发出 loop.ended。 */
  Internal: 'run.internal_error',
} as const

export class RunEngineError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RunEngineError'
  }
}

export type ToolExecutor = (
  call: RuntimeToolCall,
  signal: AbortSignalLike,
) => Promise<RuntimeToolResult>

/** M0 默认没有任何可用工具。 */
const noTools: ToolExecutor = async (call) => ({
  status: 'error',
  content: [{ type: 'text', text: `Tool "${call.name}" is not available.` }],
})

export interface RunEngineOptions {
  readonly sessionId: string
  readonly runId: string
  readonly parentRunId?: string
  readonly agent: AgentDefinitionRef
  readonly mode: RunMode
  readonly limits: RunLimits
  readonly runtime: AgentRuntime
  readonly model: ResolvedModel
  readonly systemPrompt?: string
  readonly tools?: readonly RuntimeToolSpec[]
  readonly executeTool?: ToolExecutor
  /** 恢复时的历史与运行状态；新运行省略，并发出 `run.created`。 */
  readonly restore?: { readonly history: readonly CanonicalMessage[]; readonly state: RunState }
  /** 会话级中止信号（宿主关闭）。 */
  readonly signal: AbortSignalLike
  readonly emit: (event: UnsequencedEvent) => void
  readonly now?: () => number
  /** 生成轮次、步骤、消息 id；默认 `<runId>-<序号>`。 */
  readonly createId?: () => string
}

interface TurnContext {
  readonly turnId: string
  readonly startedAt: number
  steps: number
  step:
    { readonly stepId: string; readonly startedAt: number; readonly model: ModelRef } | undefined
  /** 当前步骤的助手消息 id（增量与完成事件共用）。 */
  messageId: string | undefined
  abortReason: 'user' | 'shutdown' | undefined
  /** M0 只检查最大步数；时长、token、成本限额在 M1-14 加入。 */
  limitHit: 'maxStepsPerTurn' | undefined
  /** 已发出轮次结束事件。 */
  ended: boolean
}

export class RunEngine {
  readonly runId: string
  readonly #o: RunEngineOptions
  readonly #now: () => number
  readonly #createId: () => string
  #state: RunState
  #session: RuntimeSession | undefined
  #turn: TurnContext | undefined
  /** 当前轮次结束时 resolve。 */
  #turnDone: Promise<void> | undefined

  private constructor(options: RunEngineOptions) {
    this.#o = options
    this.runId = options.runId
    this.#now = options.now ?? (() => Date.now())
    let counter = 0
    this.#createId = options.createId ?? (() => `${options.runId}-${++counter}`)
    // 恢复时若记录的是运行中状态（上次未正常结束），按中断处理（Runtime §13.2）。
    const restored = options.restore?.state ?? 'idle'
    this.#state = isActiveRunState(restored) || restored === 'aborting' ? 'interrupted' : restored
  }

  /** 创建运行时会话；新运行发出 `run.created`。 */
  static async create(options: RunEngineOptions): Promise<RunEngine> {
    const engine = new RunEngine(options)
    await engine.#init()
    return engine
  }

  get state(): RunState {
    return this.#state
  }

  async #init(): Promise<void> {
    const o = this.#o
    this.#session = await o.runtime.createSession({
      model: o.model,
      systemPrompt: o.systemPrompt ?? '',
      tools: o.tools ?? [],
      history: o.restore?.history ?? [],
      signal: o.signal,
      hooks: {
        beforeToolCall: (call) => this.#beforeToolCall(call),
        executeTool: (call, signal) => this.#executeTool(call, signal),
      },
    })
    this.#session.onEvent((event) => this.#onRuntimeEvent(event))
    if (!o.restore) {
      this.#emit('run.created', {
        agent: o.agent,
        model: o.model.ref,
        mode: o.mode,
        limits: o.limits,
      })
    }
  }

  /**
   * 运行一轮：以用户消息开始，到完成、中止、失败或达到限额结束后 resolve。
   * `messageId` 是主进程已落库的 `message.user` 的 id。
   */
  async prompt(input: { messageId: string; content: readonly ContentPart[] }): Promise<void> {
    if (this.#state === 'disposed') throw new RunEngineError(RunEngineErrorCode.Disposed)
    if (!acceptsInput(this.#state) || this.#turn) throw new RunEngineError(RunEngineErrorCode.Busy)
    const session = this.#session!
    const turn: TurnContext = {
      turnId: this.#createId(),
      startedAt: this.#now(),
      steps: 0,
      step: undefined,
      messageId: undefined,
      abortReason: undefined,
      limitHit: undefined,
      ended: false,
    }
    this.#turn = turn
    this.#emit('turn.started', {})
    this.#transition('thinking')
    const run = async () => {
      try {
        await session.prompt({ role: 'user', content: [...input.content], ts: this.#now() })
      } catch {
        // 运行时或工具钩子抛出异常：在下面按内部错误结束本轮
      }
      // 运行时异常或没有发出 loop.ended：以内部错误结束本轮，不让运行停在运行中状态
      this.#endTurn(turn, { type: 'loop.ended', outcome: 'failed' }, RunEngineErrorCode.Internal)
      this.#turn = undefined
    }
    this.#turnDone = run()
    await this.#turnDone
  }

  /** 中止当前轮次；空闲时无效果。 */
  async abort(reason: 'user' | 'shutdown' = 'user'): Promise<void> {
    const turn = this.#turn
    if (!turn || !isActiveRunState(this.#state)) return
    turn.abortReason = reason
    this.#transition('aborting')
    await this.#session!.abort(reason)
  }

  /** 结束运行：中止进行中的轮次，进入 `disposed`，发出 `run.disposed`。 */
  async dispose(reason?: string): Promise<void> {
    if (this.#state === 'disposed') return
    await this.abort('shutdown')
    await this.#turnDone
    this.#transition('disposed')
    this.#emit('run.disposed', reason === undefined ? {} : { reason })
    await this.#session!.dispose()
  }

  // ---------- 运行时事件 → 协议事件 ----------

  #onRuntimeEvent(event: RuntimeEvent): void {
    const turn = this.#turn
    // 轮次结束（loop.ended）之后的事件一律忽略
    if (!turn || turn.ended) return
    switch (event.type) {
      case 'step.started': {
        if (turn.limitHit) return
        if (turn.steps >= this.#o.limits.maxStepsPerTurn) {
          turn.limitHit = 'maxStepsPerTurn'
          void this.#session!.abort('limit')
          return
        }
        turn.steps += 1
        turn.step = { stepId: this.#createId(), startedAt: this.#now(), model: event.model }
        turn.messageId = undefined
        if (this.#state === 'tooling') this.#transition('thinking')
        this.#emit('step.started', { model: event.model })
        return
      }
      case 'text.delta':
      case 'reasoning.delta': {
        if (!turn.step) return
        turn.messageId ??= this.#createId()
        const type =
          event.type === 'text.delta' ? 'message.assistant.delta' : 'message.reasoning.delta'
        this.#emit(type, { messageId: turn.messageId, text: event.text })
        return
      }
      case 'message.completed': {
        if (!turn.step) return
        const { content, reasoning, toolCalls, model } = event.message
        turn.messageId ??= this.#createId()
        this.#emit('message.assistant.completed', {
          messageId: turn.messageId,
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls ? { toolCalls } : {}),
          model,
        })
        return
      }
      case 'step.completed': {
        const step = turn.step
        if (!step) return
        this.#emit('step.completed', {
          model: step.model,
          finishReason: event.finishReason,
          durationMs: Math.max(0, this.#now() - step.startedAt),
          ...(event.usage ? { usage: event.usage } : {}),
        })
        if (event.usage) this.#emit('usage.reported', { model: step.model, usage: event.usage })
        turn.step = undefined
        turn.messageId = undefined
        return
      }
      case 'loop.ended':
        this.#endTurn(turn, event)
        return
    }
  }

  #endTurn(
    turn: TurnContext,
    event: Extract<RuntimeEvent, { type: 'loop.ended' }>,
    fallbackCode: string = RunEngineErrorCode.ModelUnknown,
  ): void {
    if (turn.ended) return
    turn.ended = true
    turn.step = undefined
    const durationMs = Math.max(0, this.#now() - turn.startedAt)
    // 用户停止优先于同时发生的限额与错误
    if (turn.abortReason || (event.outcome === 'aborted' && !turn.limitHit)) {
      // 运行时自行中止（例如会话级信号）时，也经过 aborting
      if (this.#state !== 'aborting') this.#transition('aborting')
      this.#transition('idle')
      this.#emit('turn.aborted', { reason: turn.abortReason ?? 'shutdown' })
      return
    }
    if (turn.limitHit) {
      const limit = turn.limitHit
      this.#emit('turn.limit_reached', { limit, value: this.#o.limits[limit] })
      this.#fail({ code: RunEngineErrorCode.LimitReached, params: { limit } }, true)
      return
    }
    if (event.outcome === 'failed') {
      this.#fail(event.error ?? { code: fallbackCode }, event.retryable ?? false)
      return
    }
    // 运行时在工具之后直接结束循环时，先回到 thinking 再完成
    if (this.#state === 'tooling') this.#transition('thinking')
    this.#transition('completed')
    this.#emit('turn.completed', { durationMs })
  }

  #fail(error: ErrorInfo, retryable: boolean): void {
    this.#transition('failed')
    this.#emit('turn.failed', { error, retryable })
  }

  // ---------- 工具钩子 ----------

  async #beforeToolCall(call: RuntimeToolCall) {
    if (this.#state === 'thinking') this.#transition('tooling')
    this.#emit('tool.requested', { toolCallId: call.id, name: call.name, input: call.input })
    return { action: 'allow' } as const
  }

  async #executeTool(call: RuntimeToolCall, signal: AbortSignalLike): Promise<RuntimeToolResult> {
    const startedAt = this.#now()
    this.#emit('tool.started', { toolCallId: call.id })
    const result = await (this.#o.executeTool ?? noTools)(call, signal)
    const toolCallId = call.id
    switch (result.status) {
      case 'ok':
        this.#emit('tool.completed', {
          toolCallId,
          output: [...result.content],
          durationMs: Math.max(0, this.#now() - startedAt),
        })
        break
      case 'cancelled':
        this.#emit('tool.cancelled', {
          toolCallId,
          reason: this.#turn?.abortReason === 'shutdown' ? 'shutdown' : 'user',
        })
        break
      default: {
        const message = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
        const code =
          result.status === 'denied'
            ? RunEngineErrorCode.ToolDenied
            : this.#o.executeTool
              ? RunEngineErrorCode.ToolFailed
              : RunEngineErrorCode.ToolNotAvailable
        this.#emit('tool.failed', { toolCallId, error: { code, params: { message } } })
      }
    }
    return result
  }

  // ---------- 内部 ----------

  #transition(to: RunState): void {
    const from = this.#state
    /* v8 ignore next 3 -- 防御性检查：以上流程只发起合法转换（见测试中的状态序列断言） */
    if (!canTransition(from, to)) {
      throw new Error(`RunEngine 内部错误：非法状态转换 ${from} → ${to}`)
    }
    this.#state = to
    this.#emit('run.state.changed', { from, to })
  }

  #emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    const o = this.#o
    const turn = this.#turn
    const event = {
      v: 1,
      sessionId: o.sessionId,
      runId: o.runId,
      ...(o.parentRunId ? { parentRunId: o.parentRunId } : {}),
      ...(turn ? { turnId: turn.turnId } : {}),
      ...(turn?.step ? { stepId: turn.step.stepId } : {}),
      ts: this.#now(),
      type,
      payload,
    } as UnsequencedEvent
    o.emit(event)
  }
}
