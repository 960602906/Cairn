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
 * 限额（M1-14b，Runtime §10.3）：每次调用模型（`step.started`）前检查最大步数、连续工具失败次数、单轮时长
 * （不含等待审批的时间）、token 与费用（模型有单价时）。超出时中止运行时，本轮以 `turn.limit_reached` 与
 * `turn.failed { retryable: true }` 结束；用户“继续”即开始新的一轮，计数重新开始。
 * 运行时自己拒绝的工具调用（工具不存在、参数非法，`hooks.toolCallRejected`）发出 `tool.requested` 与
 * `tool.failed`，与执行失败一样计入连续失败。
 *
 * 模型请求重试（M1-14a，Runtime §10.4）：运行时以可重试的失败结束循环（网络、429、5xx）时，本轮不结束，
 * 发出 `model.retry`，按指数退避等待后调用 `RuntimeSession.retry()` 从失败处继续，运行保持 `thinking`。
 * 等待期间可以停止。重试耗尽、运行时不支持重试、被停止或达到限额时照常结束本轮。
 *
 * 一步在没有 `message.completed` 的情况下结束（被停止、出错，或运行时直接结束循环）时，若已收到
 * 文本或推理增量，先以 `message.assistant.completed { incomplete: true }` 保存这部分回复
 * （Runtime §10.2），再发出 `step.completed` 或轮次结束事件。
 *
 * `message.user` 由主进程落库（`host.prompt` 携带其 messageId），RunEngine 不重复发出。
 * 工具调用交给 `toolPipeline`（M1-05b，Runtime §7：校验、权限、审批、检查点、执行、截断），按其结果发出
 * `tool.*` 事件；等待审批时运行进入 `awaiting_approval`。没有流水线时（M0、测试）交给 `executeTool`。
 * 有工具时，系统提示词末尾附加 `TOOL_RESULT_NOTICE`：工具结果是数据，不执行其中的指令（架构 §17）。
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
} from '@cairn/protocol'
import { acceptsInput, canTransition, isActiveRunState } from './run-state.js'
import { TOOL_RESULT_NOTICE } from './system-prompt.js'
import type { ToolCallObserver, ToolOutcome, ToolPipeline } from './tool-pipeline.js'
import type { ToolCheckpoints } from './tools.js'
import { billedTokens, estimateCost } from './usage.js'
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

/** 模型请求的重试策略（M1-14a）。 */
export interface RetryPolicy {
  /** 一轮中最多重试的次数（每次失败的请求各算一次）；0 表示不重试。 */
  readonly maxRetries: number
  /** 第一次重试前的等待毫秒数，之后每次翻倍。 */
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
}

/** 第 `attempt` 次（从 1 起）重试前的等待：`min(base × 2^(attempt-1), max)`。 */
export function retryDelay(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
}

type TimerHandle = { readonly __timer: unique symbol }
/** core 不引入 DOM / Node 类型；计时器每次从 globalThis 读取，测试中的假计时器也能生效。 */
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
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

/** `executeTool` 的结果转换为流水线结果（M0 的错误码不变）。 */
function toOutcome(result: RuntimeToolResult, hasExecutor: boolean): ToolOutcome {
  if (result.status === 'ok') return { status: 'ok', content: result.content, truncated: false }
  if (result.status === 'cancelled') return { status: 'cancelled', content: result.content }
  const message = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const code =
    result.status === 'denied'
      ? RunEngineErrorCode.ToolDenied
      : hasExecutor
        ? RunEngineErrorCode.ToolFailed
        : RunEngineErrorCode.ToolNotAvailable
  return { status: result.status, content: result.content, error: { code, params: { message } } }
}

/** 一轮开始前准备好的系统提示词和 `turn.started` 上下文（M3-02）。 */
export interface TurnPreparation {
  readonly systemPrompt?: string
  readonly context?: EventPayload<'turn.started'>['context']
}

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
  /**
   * 每轮开始、调用模型之前（M3-02）：可以换掉系统提示词，并给出要写进 `turn.started` 的上下文
   * （例如读到的 `AGENTS.md`）。失败时由调用方自己吞掉；这里抛出会让这一轮无法开始。
   */
  readonly prepareTurn?: () => Promise<TurnPreparation | undefined>
  readonly tools?: readonly RuntimeToolSpec[]
  readonly executeTool?: ToolExecutor
  /** 工具流水线（M1-05b）；给出时优先于 `executeTool`。 */
  readonly toolPipeline?: ToolPipeline
  /**
   * 检查点（M1-12b，架构 §11.2）：每轮开始、调用模型之前创建，发出 `checkpoint.created`。
   * 不可用或失败时本轮照常进行（失败交给 `onCheckpointError`）。
   */
  readonly checkpoints?: ToolCheckpoints
  readonly onCheckpointError?: (error: unknown) => void
  /** 模型请求的重试策略，默认 `DEFAULT_RETRY_POLICY`。 */
  readonly retry?: RetryPolicy
  /** 恢复时的历史与运行状态；新运行省略，并发出 `run.created`。 */
  readonly restore?: { readonly history: readonly CanonicalMessage[]; readonly state: RunState }
  /** 会话级中止信号（宿主关闭）。 */
  readonly signal: AbortSignalLike
  readonly emit: (event: UnsequencedEvent) => void
  readonly now?: () => number
  /** 生成轮次、步骤、消息 id；默认 `<runId>-<序号>`。 */
  readonly createId?: () => string
}

interface StepContext {
  readonly stepId: string
  readonly startedAt: number
  readonly model: ModelRef
  /** 已收到的增量，本步没有完整消息时作为部分回复保存。 */
  text: string
  reasoning: string
  /** 本步已发出 `message.assistant.completed`。 */
  completed: boolean
}

interface TurnContext {
  readonly turnId: string
  readonly startedAt: number
  steps: number
  step: StepContext | undefined
  /** 当前步骤的助手消息 id（增量与完成事件共用）。 */
  messageId: string | undefined
  abortReason: 'user' | 'shutdown' | undefined
  /** 触发的限额。 */
  limitHit: keyof RunLimits | undefined
  /** 连续失败的工具调用数；成功的调用清零，被拒绝或取消的不计。 */
  toolErrors: number
  /** 本轮已用的 token（输入加输出）与估算费用。 */
  tokens: number
  cost: number
  /** 等待审批的累计毫秒数与正在等待的起点（不计入单轮时长）。 */
  approvalMs: number
  approvalSince: number | undefined
  /** 已发出轮次结束事件。 */
  ended: boolean
  /** 本轮已重试的次数。 */
  retries: number
  /** 运行时以可重试的失败结束了循环，等待重试。 */
  retryPending: Extract<RuntimeEvent, { type: 'loop.ended' }> | undefined
  /** 正在退避等待时，提前结束等待（停止）。 */
  wake: (() => void) | undefined
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
  #limits: RunLimits

  private constructor(options: RunEngineOptions) {
    this.#o = options
    this.runId = options.runId
    this.#limits = options.limits
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
      // 组装好的系统提示词（`buildSystemPrompt`）已包含安全规则时不再附加
      systemPrompt:
        (o.tools?.length ?? 0) > 0 && !o.systemPrompt?.includes(TOOL_RESULT_NOTICE)
          ? [o.systemPrompt, TOOL_RESULT_NOTICE].filter(Boolean).join('\n\n')
          : (o.systemPrompt ?? ''),
      tools: o.tools ?? [],
      history: o.restore?.history ?? [],
      signal: o.signal,
      hooks: {
        beforeToolCall: (call) => this.#beforeToolCall(call),
        executeTool: (call, signal) => this.#executeTool(call, signal),
        toolCallRejected: (call, error) => this.#toolCallRejected(call, error),
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
      toolErrors: 0,
      tokens: 0,
      cost: 0,
      approvalMs: 0,
      approvalSince: undefined,
      ended: false,
      retries: 0,
      retryPending: undefined,
      wake: undefined,
    }
    this.#turn = turn
    let prepared: TurnPreparation | undefined
    try {
      prepared = await this.#o.prepareTurn?.()
    } catch (error) {
      this.#turn = undefined
      throw error
    }
    if (prepared?.systemPrompt !== undefined) session.setSystemPrompt?.(prepared.systemPrompt)
    this.#emit('turn.started', prepared?.context ? { context: prepared.context } : {})
    this.#transition('thinking')
    const run = async () => {
      try {
        await this.#turnCheckpoint()
        if (turn.abortReason) {
          // 创建检查点期间被停止：不再调用模型
          this.#endTurn(turn, { type: 'loop.ended', outcome: 'aborted' })
        } else {
          await session.prompt({ role: 'user', content: [...input.content], ts: this.#now() })
          await this.#retryLoop(turn)
        }
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

  /** 运行时以可重试的失败结束循环后：退避等待，再从失败处继续，直到不再需要重试。 */
  async #retryLoop(turn: TurnContext): Promise<void> {
    const session = this.#session!
    const policy = this.#o.retry ?? DEFAULT_RETRY_POLICY
    while (turn.retryPending && !turn.ended) {
      const failure = turn.retryPending
      turn.retryPending = undefined
      if (turn.abortReason) break
      turn.retries += 1
      const delayMs = retryDelay(policy, turn.retries)
      this.#emit('model.retry', {
        attempt: turn.retries,
        maxRetries: policy.maxRetries,
        delayMs,
        error: failure.error ?? { code: RunEngineErrorCode.ModelUnknown },
      })
      await this.#backoff(turn, delayMs)
      if (turn.abortReason || this.#o.signal.aborted) break
      await session.retry!()
    }
    // 循环结束前被停止（等待中或刚失败时）：本轮以中止结束
    if (!turn.ended && (turn.abortReason || this.#o.signal.aborted)) {
      this.#endTurn(turn, { type: 'loop.ended', outcome: 'aborted' })
    }
  }

  /** 等待 `ms` 毫秒；停止或会话级中止时提前结束。 */
  #backoff(turn: TurnContext, ms: number): Promise<void> {
    const signal = this.#o.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        timers.clearTimeout(handle)
        signal.removeEventListener('abort', wake)
        turn.wake = undefined
        resolve()
      }
      const handle = timers.setTimeout(wake, ms)
      signal.addEventListener('abort', wake)
      turn.wake = wake
    })
  }

  /** 这次失败是否重试：可重试、运行时支持、未停止、未达到限额、次数未用完。 */
  #shouldRetry(turn: TurnContext, event: Extract<RuntimeEvent, { type: 'loop.ended' }>): boolean {
    const policy = this.#o.retry ?? DEFAULT_RETRY_POLICY
    return (
      event.outcome === 'failed' &&
      event.retryable === true &&
      this.#session?.retry !== undefined &&
      !turn.abortReason &&
      !turn.limitHit &&
      turn.retries < policy.maxRetries
    )
  }

  async #turnCheckpoint(): Promise<void> {
    const checkpoints = this.#o.checkpoints
    if (!checkpoints) return
    try {
      const checkpointId = await checkpoints.create('turn_start')
      if (checkpointId !== undefined) {
        this.#emit('checkpoint.created', { checkpointId, reason: 'turn_start' })
      }
    } catch (error) {
      this.#o.onCheckpointError?.(error)
    }
  }

  get limits(): RunLimits {
    return this.#limits
  }

  /** 调整限额（Runtime §10.3"继续"），从下一次检查起生效。 */
  updateLimits(limits: Partial<RunLimits>): void {
    this.#limits = { ...this.#limits, ...limits } as RunLimits
  }

  /**
   * 引导（Runtime §9）：运行中把消息交给运行时，在下一次调用模型前生效；
   * 返回 false 表示当前没有进行中的轮次，调用方应改为 `prompt`。
   */
  async steer(input: { messageId: string; content: readonly ContentPart[] }): Promise<boolean> {
    const turn = this.#turn
    if (!turn || turn.ended) return false
    await this.#session!.steer({ role: 'user', content: [...input.content], ts: this.#now() })
    return true
  }

  /** 中止当前轮次；空闲时无效果。 */
  async abort(reason: 'user' | 'shutdown' = 'user'): Promise<void> {
    const turn = this.#turn
    if (!turn || !isActiveRunState(this.#state)) return
    turn.abortReason = reason
    this.#transition('aborting')
    // 正在退避等待重试：结束等待，本轮以中止结束
    turn.wake?.()
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
        const limit = this.#exceededLimit(turn)
        if (limit) {
          turn.limitHit = limit
          void this.#session!.abort('limit')
          return
        }
        turn.steps += 1
        turn.step = {
          stepId: this.#createId(),
          startedAt: this.#now(),
          model: event.model,
          text: '',
          reasoning: '',
          completed: false,
        }
        turn.messageId = undefined
        if (this.#state === 'tooling') this.#transition('thinking')
        this.#emit('step.started', { model: event.model })
        return
      }
      case 'text.delta':
      case 'reasoning.delta': {
        if (!turn.step) return
        turn.messageId ??= this.#createId()
        if (event.type === 'text.delta') turn.step.text += event.text
        else turn.step.reasoning += event.text
        const type =
          event.type === 'text.delta' ? 'message.assistant.delta' : 'message.reasoning.delta'
        this.#emit(type, { messageId: turn.messageId, text: event.text })
        return
      }
      case 'message.completed': {
        if (!turn.step) return
        const { content, reasoning, toolCalls, model } = event.message
        turn.step.completed = true
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
        this.#savePartial(turn)
        this.#emit('step.completed', {
          model: step.model,
          finishReason: event.finishReason,
          durationMs: Math.max(0, this.#now() - step.startedAt),
          ...(event.usage ? { usage: event.usage } : {}),
        })
        if (event.usage) {
          this.#emit('usage.reported', { model: step.model, usage: event.usage })
          turn.tokens += billedTokens(event.usage)
          const pricing = this.#o.model.profile.pricing
          if (pricing) turn.cost += estimateCost(event.usage, pricing)
        }
        turn.step = undefined
        turn.messageId = undefined
        return
      }
      case 'loop.ended':
        if (this.#shouldRetry(turn, event)) {
          // 本轮不结束；`prompt` 返回后由 `#retryLoop` 重试
          this.#savePartial(turn)
          turn.step = undefined
          turn.retryPending = event
          return
        }
        this.#endTurn(turn, event)
        return
    }
  }

  /** 调用模型前检查限额，返回第一个超出的限额。 */
  #exceededLimit(turn: TurnContext): keyof RunLimits | undefined {
    const limits = this.#limits
    if (turn.steps >= limits.maxStepsPerTurn) return 'maxStepsPerTurn'
    if (turn.toolErrors >= limits.maxConsecutiveToolErrors) return 'maxConsecutiveToolErrors'
    if (this.#activeMs(turn) >= limits.maxTurnDurationMs) return 'maxTurnDurationMs'
    if (limits.maxTokensPerTurn !== undefined && turn.tokens >= limits.maxTokensPerTurn) {
      return 'maxTokensPerTurn'
    }
    if (
      limits.maxCostPerTurn !== undefined &&
      this.#o.model.profile.pricing &&
      turn.cost >= limits.maxCostPerTurn
    ) {
      return 'maxCostPerTurn'
    }
    return undefined
  }

  /** 本轮已进行的时间，不含等待审批。 */
  #activeMs(turn: TurnContext): number {
    const now = this.#now()
    const waiting = turn.approvalSince === undefined ? 0 : now - turn.approvalSince
    return Math.max(0, now - turn.startedAt - turn.approvalMs - waiting)
  }

  /** 工具调用的结果计入连续失败。 */
  #countToolResult(status: RuntimeToolResult['status']): void {
    const turn = this.#turn
    if (!turn) return
    if (status === 'ok') turn.toolErrors = 0
    else if (status === 'error') turn.toolErrors += 1
  }

  #endTurn(
    turn: TurnContext,
    event: Extract<RuntimeEvent, { type: 'loop.ended' }>,
    fallbackCode: string = RunEngineErrorCode.ModelUnknown,
  ): void {
    if (turn.ended) return
    turn.ended = true
    this.#savePartial(turn)
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
      this.#emit('turn.limit_reached', { limit, value: this.#limits[limit] ?? 0 })
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

  /** 当前步骤没有完整消息但已收到增量时，保存为不完整的助手消息。 */
  #savePartial(turn: TurnContext): void {
    const step = turn.step
    if (!step || step.completed || turn.messageId === undefined) return
    step.completed = true
    this.#emit('message.assistant.completed', {
      messageId: turn.messageId,
      content: step.text === '' ? [] : [{ type: 'text', text: step.text }],
      ...(step.reasoning === ''
        ? {}
        : { reasoning: { text: step.reasoning, providerId: step.model.providerId } }),
      model: step.model,
      incomplete: true,
    })
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
    const pipeline = this.#o.toolPipeline
    let started = false
    const start = () => {
      if (started) return
      started = true
      this.#emit('tool.started', { toolCallId: call.id })
    }
    let outcome: ToolOutcome
    if (pipeline) {
      const observer: ToolCallObserver = {
        started: start,
        output: (text, stream) =>
          this.#emit('tool.output.delta', { toolCallId: call.id, stream, text }),
        awaitingApproval: (waiting) => this.#awaitingApproval(waiting),
        ...(this.#turn ? { turnId: this.#turn.turnId } : {}),
        emit: (type, payload) => this.#emit(type, payload),
      }
      outcome = await pipeline.run(call, signal, observer)
    } else {
      start()
      outcome = toOutcome(
        await (this.#o.executeTool ?? noTools)(call, signal),
        !!this.#o.executeTool,
      )
    }
    const toolCallId = call.id
    switch (outcome.status) {
      case 'ok':
        this.#emit('tool.completed', {
          toolCallId,
          output: [...outcome.content],
          ...(outcome.truncated ? { truncated: true } : {}),
          durationMs: Math.max(0, this.#now() - startedAt),
          ...(outcome.display ? { display: outcome.display } : {}),
        })
        break
      case 'cancelled':
        this.#emit('tool.cancelled', {
          toolCallId,
          reason: this.#turn?.abortReason === 'shutdown' ? 'shutdown' : 'user',
        })
        break
      default:
        this.#emit('tool.failed', { toolCallId, error: outcome.error })
    }
    this.#countToolResult(outcome.status)
    return { status: outcome.status, content: outcome.content }
  }

  #toolCallRejected(call: RuntimeToolCall, error: ErrorInfo): void {
    const turn = this.#turn
    if (!turn || turn.ended) return
    if (this.#state === 'thinking') this.#transition('tooling')
    this.#emit('tool.requested', { toolCallId: call.id, name: call.name, input: call.input })
    this.#emit('tool.failed', { toolCallId: call.id, error })
    this.#countToolResult('error')
  }

  /** 并行的多个调用可能同时等待审批：第一个开始时进入、最后一个结束时离开 `awaiting_approval`。 */
  #approvalsPending = 0

  #awaitingApproval(waiting: boolean): void {
    this.#approvalsPending += waiting ? 1 : -1
    const turn = this.#turn
    if (turn && waiting && this.#approvalsPending === 1) turn.approvalSince = this.#now()
    if (turn && !waiting && this.#approvalsPending === 0 && turn.approvalSince !== undefined) {
      turn.approvalMs += this.#now() - turn.approvalSince
      turn.approvalSince = undefined
    }
    if (waiting && this.#approvalsPending === 1 && this.#state === 'tooling') {
      this.#transition('awaiting_approval')
    } else if (!waiting && this.#approvalsPending === 0 && this.#state === 'awaiting_approval') {
      this.#transition('tooling')
    }
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
