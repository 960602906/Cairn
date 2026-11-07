/**
 * 基于 pi-agent-core `Agent` 的 `AgentRuntime` 实现（M1-01c；ADR-0004；Runtime §17）。
 *
 * 事件映射（pi → `RuntimeEvent`）：
 * - 助手消息 `message_start` → `step.started`；`text_delta` / `thinking_delta` → `text.delta` / `reasoning.delta`；
 * - 助手消息 `message_end` → `message.completed`（正常结束时）+ `step.completed`。被中止或出错的一步
 *   不发出 `message.completed`，部分回复由 `RunEngine` 用增量保存；
 * - `agent_end` → `loop.ended`，结果按最后一条助手消息与是否被中止判断。
 *
 * 中止：中止之后到达的增量不再转发。pi 在中止后仍会处理同一网络块中已收到的事件，否则转发的增量数取决于
 *   网络分块（M1-02b 的真实录制发现）。
 *
 * 非法工具调用（M1-14b）：工具不存在、参数不是合法 JSON（`argumentsError`）或不符合 schema 时，pi 自己把错误
 * 作为工具结果回给模型，不调用工具的 `execute`。会话从 `tool_execution_start` / `tool_execution_end` 中找出
 * 这些调用，经 `hooks.toolCallRejected` 报告（`tool.not_found` / `tool.invalid_input`），上层据此记录事件。
 *
 * 重试（M1-14a）：pi 的 SDK 重试关闭（`maxRetries: 0`），由 `RunEngine` 决定是否重试。`retry()` 从 pi 的
 * 消息中去掉失败的助手消息，再用 `Agent.continue()` 从最后的用户消息或工具结果继续，不重复执行工具。
 *
 * 工具：每个 `RuntimeToolSpec` 包装为 pi 工具，`execute` 中先调用 `hooks.beforeToolCall`，放行后调用
 * `hooks.executeTool`，并把中止信号传下去。结果状态（ok、denied 等）写入 pi 工具结果的 `details`，
 * 历史中可以原样恢复。并行（M1-05c；Runtime §6.2）：标为 `parallel` 的工具设为 pi 的 `parallel` 执行模式，
 * 其余为 `sequential`；pi 在一批调用中只要有一个 `sequential` 就整批按顺序执行，否则并行执行，结果
 * 按模型给出的顺序回填。并发上限由工具流水线控制。
 *
 * 历史：会话自己维护 `CanonicalMessage[]`，在 pi 的 `message_end` 时追加（用户消息用调用方传入的原对象），
 * `exportHistory` 直接返回。出错或被中止的助手消息不进入历史（与 pi 自己回传时的规则一致）。
 */
import type {
  AbortSignalLike,
  AgentRuntime,
  RuntimeEvent,
  RuntimeHooks,
  RuntimeSession,
  RuntimeSessionInit,
  RuntimeToolResult,
  RuntimeToolSpec,
  StepFinishReason,
  UserMessage,
} from '@cairn/core'
import type { CanonicalMessage, ErrorInfo } from '@cairn/protocol'
import { ToolErrorCode } from '@cairn/core'
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
} from '@earendil-works/pi-ai'
import { PiErrorCode, toFailure } from './errors.js'
import { fromPiAssistant, fromPiMessages, fromPiUsage, toPiMessages, toPiUser } from './messages.js'
import { bindModel } from './model.js'

export interface PiRuntimeOptions {
  /** 支持推理的模型使用的思考等级，默认 `high`；不支持推理的模型总是 `off`。 */
  readonly thinkingLevel?: ThinkingLevel
}

export class PiRuntime implements AgentRuntime {
  readonly id = 'pi'
  readonly #options: PiRuntimeOptions

  constructor(options: PiRuntimeOptions = {}) {
    this.#options = options
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    return new PiSession(init, this.#options)
  }
}

const FINISH: Readonly<Record<PiAssistantMessage['stopReason'], StepFinishReason>> = {
  stop: 'stop',
  toolUse: 'tool_calls',
  length: 'length',
  aborted: 'aborted',
  error: 'error',
  pending: 'error',
  deferred: 'error',
}

let sessionCounter = 0

class PiSession implements RuntimeSession {
  readonly #init: RuntimeSessionInit
  readonly #agent: Agent
  readonly #binding: ReturnType<typeof bindModel>
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  readonly #history: CanonicalMessage[]
  /** 已交给 pi、尚未在 `message_end` 中出现的用户消息（prompt 与 steer），按顺序。 */
  readonly #pendingUsers: UserMessage[] = []
  readonly #unsubscribe: () => void
  readonly #onSessionAbort = () => {
    this.#agent.abort()
  }
  #running = false
  #abortRequested = false
  #inStep = false
  #loopEnded = false
  #lastAssistant: PiAssistantMessage | undefined
  /** 本次循环中 pi 开始处理的工具调用的参数，`execute` 被调用后移除。 */
  readonly #toolCalls = new Map<string, unknown>()
  #disposed = false

  constructor(init: RuntimeSessionInit, options: PiRuntimeOptions) {
    this.#init = init
    this.#binding = bindModel(init.model)
    this.#history = [...init.history]
    const thinkingLevel: ThinkingLevel = init.model.profile.supportsReasoning
      ? (options.thinkingLevel ?? 'high')
      : 'off'
    const held: { agent?: Agent } = {}
    this.#agent = new Agent({
      initialState: {
        systemPrompt: init.systemPrompt,
        model: this.#binding.model,
        thinkingLevel,
        tools: init.tools.map((spec) => this.#toAgentTool(spec)),
        messages: toPiMessages(init.history, this.#binding.identity),
      },
      streamFn: this.#binding.streamFn,
      sessionId: `cairn-${++sessionCounter}`,
      toolExecution: 'parallel',
      identity: { attribution: null },
      transformContext: (messages) => this.#transformContext(held.agent ?? this.#agent, messages),
    })
    held.agent = this.#agent
    this.#unsubscribe = this.#agent.subscribe((event) => this.#handle(event))
    init.signal.addEventListener('abort', this.#onSessionAbort, { once: true })
  }

  onEvent(listener: (event: RuntimeEvent) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  exportHistory(): CanonicalMessage[] {
    return [...this.#history]
  }

  replaceMessages(messages: readonly CanonicalMessage[]): void {
    this.#history.splice(0, this.#history.length, ...messages)
    this.#writeAgentMessages(messages)
  }

  /** 换掉开头的系统消息正文（M3-02）。工具声明留在原消息上。 */
  setSystemPrompt(prompt: string): void {
    const messages = this.#agent.state.messages
    const first = messages[0]
    if (first?.role !== 'system') return
    this.#agent.state.messages = [{ ...first, content: prompt }, ...messages.slice(1)]
  }

  async prompt(input: UserMessage): Promise<void> {
    this.#checkIdle()
    this.#pendingUsers.push(input)
    await this.#run(() => this.#agent.prompt(toPiUser(input.content, input.ts)))
  }

  async retry(): Promise<void> {
    this.#checkIdle()
    const messages = this.#agent.state.messages
    const index = messages.findLastIndex((m) => m.role === 'assistant')
    const failed = messages[index] as PiAssistantMessage | undefined
    if (failed?.stopReason === 'error') {
      // 出错的助手消息不回传给模型；去掉后最后一条是用户消息或工具结果（空闲时的引导消息在它之后）
      this.#agent.state.messages = messages.filter((_, i) => i !== index)
    }
    await this.#run(() => this.#agent.continue())
  }

  /**
   * 调用模型前压缩（M3-03）。pi 只把返回值用于这一次请求，同一轮后面的步骤仍用传入的数组，
   * 下一轮则从 `state.messages` 重新取快照。所以三处都要换成压缩后的历史。
   */
  async #transformContext(agent: Agent, messages: AgentMessage[]): Promise<AgentMessage[]> {
    const hook = this.#init.hooks.beforeModelCall
    if (!hook) return messages
    const system = messages.filter((message) => message.role === 'system')
    const head = system[0]
    const systemPrompt =
      head && 'content' in head && typeof head.content === 'string'
        ? head.content
        : this.#init.systemPrompt
    const next = await hook({ systemPrompt, messages: this.#history })
    if (next.messages === this.#history) return messages
    this.#history.splice(0, this.#history.length, ...next.messages)
    const replaced = this.#compose(agent, next.messages)
    messages.splice(0, messages.length, ...replaced)
    agent.state.messages = [...replaced]
    return messages
  }

  #writeAgentMessages(messages: readonly CanonicalMessage[]): void {
    this.#agent.state.messages = this.#compose(this.#agent, messages)
  }

  #compose(agent: Agent, messages: readonly CanonicalMessage[]): AgentMessage[] {
    const system = agent.state.messages.filter((message) => message.role === 'system')
    return [...system, ...toPiMessages(messages, this.#binding.identity)]
  }

  #checkIdle(): void {
    if (this.#disposed) throw new Error('pi 会话已释放')
    if (this.#running) throw new Error('pi 会话正在运行')
  }

  /** 运行一次 agent 循环，保证恰好一个 `loop.ended`。 */
  async #run(start: () => Promise<void>): Promise<void> {
    this.#running = true
    this.#abortRequested = this.#init.signal.aborted
    this.#loopEnded = false
    this.#inStep = false
    this.#lastAssistant = undefined
    this.#toolCalls.clear()
    try {
      if (this.#abortRequested) {
        // 会话已被中止：不发请求，直接以 aborted 结束
        this.#pendingUsers.length = 0
        this.#endLoop()
        return
      }
      await start()
    } catch {
      // pi 的 prompt 不应抛出；万一抛出，按失败结束本轮，保证恰好一个 loop.ended
    } finally {
      this.#pendingUsers.length = 0
      if (!this.#loopEnded) {
        if (this.#inStep) this.#emit({ type: 'step.completed', finishReason: 'error' })
        this.#emit({
          type: 'loop.ended',
          outcome: 'failed',
          error: { code: PiErrorCode.Unknown },
          retryable: false,
        })
        this.#loopEnded = true
      }
      this.#inStep = false
      this.#running = false
    }
  }

  async steer(input: UserMessage): Promise<void> {
    if (this.#running) {
      this.#pendingUsers.push(input)
      this.#agent.steer(toPiUser(input.content, input.ts))
      return
    }
    // 空闲时直接进入历史，下一次 prompt 时生效
    this.#history.push(input)
    this.#agent.state.messages = [...this.#agent.state.messages, toPiUser(input.content, input.ts)]
  }

  async abort(): Promise<void> {
    if (!this.#running) return
    this.#abortRequested = true
    this.#agent.abort()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    await this.abort()
    await this.#agent.waitForIdle()
    this.#disposed = true
    this.#unsubscribe()
    this.#init.signal.removeEventListener('abort', this.#onSessionAbort)
    this.#listeners.clear()
  }

  #toAgentTool(spec: RuntimeToolSpec): AgentTool {
    const hooks: RuntimeHooks = this.#init.hooks
    const sessionSignal = this.#init.signal
    return {
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      executionMode: spec.parallel ? 'parallel' : 'sequential',
      execute: async (toolCallId, params, signal): Promise<AgentToolResult> => {
        this.#toolCalls.delete(toolCallId)
        const call = { id: toolCallId, name: spec.name, input: params }
        const gate = await hooks.beforeToolCall(call)
        const result: RuntimeToolResult =
          gate.action === 'deny'
            ? { status: 'denied', content: [{ type: 'text', text: gate.reason }] }
            : await hooks.executeTool(call, (signal ?? sessionSignal) as AbortSignalLike)
        const [message] = toPiMessages(
          [
            {
              role: 'tool',
              toolCallId,
              content: [...result.content],
              status: result.status,
              ts: 0,
            },
          ],
          this.#binding.identity,
        )
        const { content, details } = message as Extract<PiMessage, { role: 'toolResult' }>
        return { content, details, isError: result.status !== 'ok' }
      },
    }
  }

  #handle(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.#startStep()
        break
      case 'message_update': {
        const e = event.assistantMessageEvent
        // 中止后不再转发增量：pi 会继续解析已经收到的同一网络块中剩余的事件
        if (this.#abortRequested || this.#agent.signal?.aborted) break
        if (e.type === 'text_delta') this.#emit({ type: 'text.delta', text: e.delta })
        else if (e.type === 'thinking_delta') this.#emit({ type: 'reasoning.delta', text: e.delta })
        break
      }
      case 'message_end':
        this.#endMessage(event.message as PiMessage)
        break
      case 'tool_execution_start':
        this.#toolCalls.set(event.toolCallId, event.args)
        break
      case 'tool_execution_end':
        this.#endToolCall(event.toolCallId, event.toolName, event.isError)
        break
      case 'agent_end':
        this.#endLoop()
        break
      default:
        break
    }
  }

  /** pi 没有调用 `execute` 就结束的调用：pi 自己拒绝了它（中止时取消的除外）。 */
  #endToolCall(toolCallId: string, name: string, isError: boolean): void {
    if (!this.#toolCalls.has(toolCallId)) return
    const input = this.#toolCalls.get(toolCallId)
    this.#toolCalls.delete(toolCallId)
    if (!isError || this.#abortRequested || this.#agent.signal?.aborted) return
    const known = this.#init.tools.some((t) => t.name === name)
    const error: ErrorInfo = {
      code: known ? ToolErrorCode.InvalidInput : ToolErrorCode.NotFound,
      params: { name },
    }
    this.#init.hooks.toolCallRejected?.({ id: toolCallId, name, input }, error)
  }

  #startStep(): void {
    if (this.#inStep) return
    this.#inStep = true
    this.#emit({ type: 'step.started', model: this.#init.model.ref })
  }

  #endMessage(message: PiMessage): void {
    switch (message.role) {
      case 'user':
        this.#history.push(
          this.#pendingUsers.shift() ?? fromPiMessages([message], this.#init.model.ref)[0]!,
        )
        break
      case 'toolResult':
        this.#history.push(...fromPiMessages([message], this.#init.model.ref))
        break
      case 'assistant': {
        this.#startStep()
        this.#lastAssistant = message
        const finishReason = FINISH[message.stopReason]
        if (finishReason !== 'error' && finishReason !== 'aborted') {
          const canonical = fromPiAssistant(message, this.#init.model.ref)
          this.#history.push(canonical)
          this.#emit({ type: 'message.completed', message: canonical })
        }
        const usage = fromPiUsage(message.usage)
        this.#inStep = false
        this.#emit({
          type: 'step.completed',
          finishReason,
          ...(usage.inputTokens > 0 || usage.outputTokens > 0 ? { usage } : {}),
        })
        break
      }
      default:
        break
    }
  }

  #endLoop(): void {
    if (this.#loopEnded) return
    this.#loopEnded = true
    if (this.#inStep) {
      this.#inStep = false
      this.#emit({
        type: 'step.completed',
        finishReason: this.#abortRequested ? 'aborted' : 'error',
      })
    }
    const last = this.#lastAssistant
    if (this.#abortRequested || last?.stopReason === 'aborted') {
      this.#emit({ type: 'loop.ended', outcome: 'aborted' })
    } else if (last && FINISH[last.stopReason] === 'error') {
      const { error, retryable } = toFailure(last, this.#init.model.profile.contextWindow)
      this.#emit({ type: 'loop.ended', outcome: 'failed', error, retryable })
    } else {
      this.#emit({ type: 'loop.ended', outcome: 'completed' })
    }
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
