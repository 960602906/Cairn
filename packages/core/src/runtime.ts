/**
 * 底层运行时接口（ADR-0004；Runtime §17）。
 *
 * `AgentRuntime` 隔离具体的 agent 框架：M1 由 `packages/runtime-pi` 用 pi 实现，
 * M0 由 `FakeRuntime`（M0-07b）实现。上层的 `RunEngine`（M0-07c）只依赖这里的类型，
 * 不接触 pi 的类型与事件。
 *
 * 分工：运行时负责"调用模型 → 解析工具调用 → 回填结果 → 再次调用"的循环与模型通信；
 * 工具是否放行、如何执行由上层通过 `hooks` 决定（ToolPipeline，M1-05）。
 */
import type {
  CanonicalMessage,
  ContentPart,
  ErrorInfo,
  EventPayload,
  ModelCompat,
  ModelRef,
  TokenUsage,
  ToolCall,
} from '@nexus/protocol'

export type Unsubscribe = () => void

/**
 * 中止信号的结构类型。core 不引入 DOM / Node 类型（与 protocol 的 `Timers` 同样做法），
 * 标准 `AbortSignal` 可以直接赋值给它。
 */
export interface AbortSignalLike {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

/** 模型接口格式（ADR-0021）。 */
export type ProviderKind = 'openai' | 'anthropic' | 'gemini'

/** 模型能力（ADR-0011；架构 §12.1）。 */
export interface ModelProfile {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsTools: boolean
  readonly supportsParallelToolCalls: boolean
  readonly supportsReasoning: boolean
}

/** 已解析的模型：运行时直接据此发起请求。 */
export interface ResolvedModel {
  readonly ref: ModelRef
  readonly providerKind: ProviderKind
  readonly baseUrl: string
  /** 由凭据服务在 `host.init` 时提供（ADR-0010）；本地模型可以没有。 */
  readonly apiKey?: string
  readonly profile: ModelProfile
  /** 兼容参数（M1-04b）：只对 openai 格式生效；省略的项由运行时按地址自动判断。 */
  readonly compat?: ModelCompat
}

/** 提供给模型的工具说明。 */
export interface RuntimeToolSpec {
  readonly name: string
  readonly description: string
  /** 参数的 JSON Schema。 */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** 模型发出的一次工具调用。 */
export type RuntimeToolCall = ToolCall

/** `beforeToolCall` 的判定：放行，或拒绝并把原因回给模型。 */
export type RuntimeToolGate =
  { readonly action: 'allow' } | { readonly action: 'deny'; readonly reason: string }

/** 工具执行结果，回填给模型。状态与 `CanonicalMessage` 的工具结果一致（`unknown` 只用于恢复）。 */
export interface RuntimeToolResult {
  readonly status: 'ok' | 'error' | 'denied' | 'cancelled'
  readonly content: readonly ContentPart[]
}

/** 每次调用模型之前，上层可以调整的上下文（上下文压缩等，M1-13）。 */
export interface ModelCallContext {
  readonly systemPrompt: string
  readonly messages: readonly CanonicalMessage[]
}

export interface RuntimeHooks {
  beforeToolCall(call: RuntimeToolCall): Promise<RuntimeToolGate>
  executeTool(call: RuntimeToolCall, signal: AbortSignalLike): Promise<RuntimeToolResult>
  beforeModelCall?(ctx: ModelCallContext): Promise<ModelCallContext>
}

export interface RuntimeSessionInit {
  readonly model: ResolvedModel
  readonly systemPrompt: string
  readonly tools: readonly RuntimeToolSpec[]
  /** 恢复时的历史（M0-06d `rebuildHistory`）；新会话为空。 */
  readonly history: readonly CanonicalMessage[]
  /** 中止整个会话（例如宿主关闭）。 */
  readonly signal: AbortSignalLike
  readonly hooks: RuntimeHooks
}

export type UserMessage = Extract<CanonicalMessage, { role: 'user' }>
export type AssistantMessage = Extract<CanonicalMessage, { role: 'assistant' }>
export type StepFinishReason = EventPayload<'step.completed'>['finishReason']

/**
 * 运行时发出的事件。一次 `prompt` 内的顺序为：
 *
 * ```
 * ( step.started
 *   ( text.delta | reasoning.delta )*
 *   message.completed?            // 本步的完整助手消息（含工具调用）
 *   step.completed
 * )*
 * loop.ended                      // 恰好一次，之后 prompt() 才 resolve
 * ```
 *
 * 工具的执行经由 `hooks`，不产生运行时事件；`RunEngine` 在钩子中自行发出工具事件。
 * 被中止或出错的一步不发出 `message.completed`；`RunEngine` 用已收到的增量保存部分回复。
 */
export type RuntimeEvent =
  | { readonly type: 'step.started'; readonly model: ModelRef }
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'reasoning.delta'; readonly text: string }
  | { readonly type: 'message.completed'; readonly message: AssistantMessage }
  | {
      readonly type: 'step.completed'
      readonly finishReason: StepFinishReason
      readonly usage?: TokenUsage
    }
  | {
      readonly type: 'loop.ended'
      /** completed：模型给出最终回复；aborted：被中止；failed：不可恢复的错误。 */
      readonly outcome: 'completed' | 'aborted' | 'failed'
      readonly error?: ErrorInfo
      /** outcome 为 failed 时，是否值得重试（如限流、网络错误）。 */
      readonly retryable?: boolean
    }

export type RuntimeEventType = RuntimeEvent['type']

export interface RuntimeSession {
  /** 发送用户消息并运行 agent 循环，循环结束（发出 `loop.ended`）后 resolve；不因模型错误而 reject。 */
  prompt(input: UserMessage): Promise<void>
  /** 在运行中插入引导消息，在下一次调用模型前生效。 */
  steer(input: UserMessage): Promise<void>
  /** 中止当前循环；循环以 `loop.ended { outcome: 'aborted' }` 结束。 */
  abort(reason?: string): Promise<void>
  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe
  /** 当前完整历史（含本会话中新增的消息）。 */
  exportHistory(): CanonicalMessage[]
  dispose(): Promise<void>
}

export interface AgentRuntime {
  /** 实现标识，如 `fake`、`pi`。 */
  readonly id: string
  createSession(init: RuntimeSessionInit): Promise<RuntimeSession>
}
