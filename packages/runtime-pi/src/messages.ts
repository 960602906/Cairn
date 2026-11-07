/**
 * `CanonicalMessage`（持久化格式，与 pi 无关）与 pi 消息的双向转换（M1-01b；Runtime §17）。
 *
 * 规则：
 * - 用户消息、工具结果、助手消息一一对应；`summary` 转为一条用户消息（单向，M1-13 的上下文压缩使用）。
 * - 推理：pi 的 thinking 块 ↔ `ReasoningPart`。签名、被隐去的块、多块原样保存在 `blocks` 中，
 *   这样推理能带回给产生它的模型：DeepSeek 思考模式下的多轮工具调用需要回传 `reasoning_content`
 *   （pi 用 thinking 块的签名记录字段名，S2），Anthropic 需要 thinking 签名，Gemini 需要 thought signature。
 * - 推理只回传给同一提供方（Runtime §14）。助手消息的模型与当前模型相同时，转换结果带上当前模型的
 *   pi 标识（provider、api、model），pi 据此保留签名；不同时标为外来消息，pi 会去掉推理与签名。
 * - 工具调用的参数原样传递；Gemini 等附在调用上的签名存入 `ToolCall.signature`。
 * - 工具结果：pi 只区分成功与错误，`CanonicalMessage` 的状态（denied、cancelled 等）存入 `details`，
 *   转换回来时恢复。
 * - 用量：pi 的 `input` 不含缓存部分，`TokenUsage.inputTokens` 含缓存部分（见 protocol 中的说明）。
 * - 图片：`ContentPart` 中的图片只有 blob 引用（预留），暂时以文字占位，接入 blob 存储后再转换。
 *
 * 助手消息中的块顺序按“推理、正文、工具调用”重建。一次响应内的顺序本来就是如此；
 * 正文与工具调用交错的极少数情况只影响回传时的顺序，不影响配对。
 */
import type {
  CanonicalMessage,
  ContentPart,
  ModelRef,
  ReasoningBlock,
  ReasoningPart,
  TokenUsage,
  ToolCall as CanonicalToolCall,
} from '@cairn/protocol'
import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  ImageContent,
  JsonObject,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
  Usage as PiUsage,
  UserMessage as PiUserMessage,
} from '@earendil-works/pi-ai'

type ToolStatus = Extract<CanonicalMessage, { role: 'tool' }>['status']
type CanonicalAssistant = Extract<CanonicalMessage, { role: 'assistant' }>

/** 当前会话所用模型在 Cairn 与 pi 两边的标识。 */
export interface PiModelIdentity {
  readonly ref: ModelRef
  /** pi 模型定义中的 `provider`。 */
  readonly provider: string
  readonly api: Api
  /** pi 模型定义中的 `id`。 */
  readonly id: string
}

/** 不属于当前模型的助手消息使用的 api 标识。pi 只把与当前模型 provider、api、id 都相同的消息视为同一模型。 */
export const FOREIGN_API = 'cairn-foreign'

/** 图片暂不转换时的占位文字（发给模型，因此用英文）。 */
export const IMAGE_PLACEHOLDER = '[image omitted]'

/** `summary` 转为用户消息时的前缀（发给模型，因此用英文）。定义在 core，这里再导出。 */
import { SUMMARY_PREFIX } from '@cairn/core'
export { SUMMARY_PREFIX }

const DETAILS_STATUS_KEY = 'cairnStatus'

const TOOL_STATUSES: readonly ToolStatus[] = ['ok', 'error', 'denied', 'cancelled', 'unknown']

export const sameModel = (a: ModelRef, b: ModelRef) =>
  a.providerId === b.providerId && a.modelId === b.modelId

// ---------------------------------------------------------------------------
// CanonicalMessage → pi
// ---------------------------------------------------------------------------

/** 把规范化历史转为 pi 消息，供 pi `Agent` 作为上下文。 */
export function toPiMessages(
  messages: readonly CanonicalMessage[],
  target: PiModelIdentity,
): PiMessage[] {
  /** 工具调用 id → 工具名（pi 的工具结果需要工具名）。 */
  const toolNames = new Map<string, string>()
  const result: PiMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        result.push(toPiUser(message.content, message.ts))
        break
      case 'summary':
        result.push({
          role: 'user',
          content: [{ type: 'text', text: SUMMARY_PREFIX + message.content }],
          timestamp: message.ts,
        })
        break
      case 'assistant':
        for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name)
        result.push(toPiAssistant(message, target))
        break
      case 'tool':
        result.push(toPiToolResult(message, toolNames.get(message.toolCallId) ?? 'unknown'))
        break
    }
  }
  return result
}

export function toPiUser(content: readonly ContentPart[], ts: number): PiUserMessage {
  return { role: 'user', content: content.map(toPiContent), timestamp: ts }
}

export function toPiAssistant(
  message: CanonicalAssistant,
  target: PiModelIdentity,
): PiAssistantMessage {
  const same = sameModel(message.model, target.ref)
  const content: PiAssistantMessage['content'] = []
  if (message.reasoning && message.reasoning.providerId === target.ref.providerId) {
    content.push(...toPiThinking(message.reasoning))
  }
  for (const part of message.content) content.push(toPiContent(part) as TextContent)
  for (const call of message.toolCalls ?? []) content.push(toPiToolCall(call))
  return {
    role: 'assistant',
    content,
    provider: same ? target.provider : message.model.providerId,
    api: same ? target.api : FOREIGN_API,
    model: same ? target.id : message.model.modelId,
    usage: emptyUsage(),
    stopReason: message.toolCalls && message.toolCalls.length > 0 ? 'toolUse' : 'stop',
    timestamp: message.ts,
  }
}

function toPiThinking(reasoning: ReasoningPart): ThinkingContent[] {
  const blocks: readonly ReasoningBlock[] = reasoning.blocks ?? [{ text: reasoning.text }]
  return blocks.map((block) => ({
    type: 'thinking',
    thinking: block.text,
    ...(block.signature !== undefined ? { thinkingSignature: block.signature } : {}),
    ...(block.redacted ? { redacted: true } : {}),
  }))
}

function toPiToolCall(call: CanonicalToolCall): PiToolCall {
  return {
    type: 'toolCall',
    id: call.id,
    name: call.name,
    arguments: isJsonObject(call.input) ? call.input : {},
    ...(call.signature !== undefined ? { thoughtSignature: call.signature } : {}),
  }
}

function toPiToolResult(
  message: Extract<CanonicalMessage, { role: 'tool' }>,
  toolName: string,
): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName,
    content: message.content.map(toPiContent),
    details: { [DETAILS_STATUS_KEY]: message.status },
    isError: message.status !== 'ok',
    timestamp: message.ts,
  }
}

function toPiContent(part: ContentPart): TextContent | ImageContent {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'text', text: IMAGE_PLACEHOLDER }
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// pi → CanonicalMessage
// ---------------------------------------------------------------------------

/**
 * 把 pi 消息转为规范化历史。`model` 是产生这些助手消息的模型（会话当前模型）。
 * pi 的系统消息不属于历史（系统提示词由会话配置给出），忽略。
 */
export function fromPiMessages(
  messages: readonly PiMessage[],
  model: ModelRef,
): CanonicalMessage[] {
  const result: CanonicalMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        result.push({
          role: 'user',
          content:
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : message.content.map(fromPiContent),
          ts: message.timestamp,
        })
        break
      case 'assistant':
        result.push(fromPiAssistant(message, model))
        break
      case 'toolResult':
        result.push({
          role: 'tool',
          toolCallId: message.toolCallId,
          content: message.content.map(fromPiContent),
          status: toolStatus(message),
          ts: message.timestamp,
        })
        break
      default:
        break
    }
  }
  return result
}

export function fromPiAssistant(message: PiAssistantMessage, model: ModelRef): CanonicalAssistant {
  const content: ContentPart[] = []
  const thinking: ThinkingContent[] = []
  const toolCalls: CanonicalToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking') thinking.push(block)
    else toolCalls.push(fromPiToolCall(block))
  }
  const reasoning = fromPiThinking(thinking, model.providerId)
  return {
    role: 'assistant',
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    model,
    ts: message.timestamp,
  }
}

function fromPiThinking(
  blocks: readonly ThinkingContent[],
  providerId: string,
): ReasoningPart | undefined {
  if (blocks.length === 0) return undefined
  const text = blocks
    .filter((b) => !b.redacted)
    .map((b) => b.thinking)
    .join('\n\n')
  const exact = blocks.length > 1 || blocks.some((b) => b.redacted || b.thinkingSignature)
  if (!exact) return { text, providerId }
  return {
    text,
    providerId,
    blocks: blocks.map((b) => ({
      text: b.thinking,
      ...(b.thinkingSignature !== undefined ? { signature: b.thinkingSignature } : {}),
      ...(b.redacted ? { redacted: true } : {}),
    })),
  }
}

function fromPiToolCall(call: PiToolCall): CanonicalToolCall {
  return {
    id: call.id,
    name: call.name,
    input: call.arguments,
    ...(call.thoughtSignature !== undefined ? { signature: call.thoughtSignature } : {}),
  }
}

function fromPiContent(part: TextContent | ImageContent): ContentPart {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'text', text: IMAGE_PLACEHOLDER }
}

function toolStatus(message: PiToolResultMessage): ToolStatus {
  const details: unknown = message.details
  if (isJsonObject(details)) {
    const status = details[DETAILS_STATUS_KEY]
    if (TOOL_STATUSES.includes(status as ToolStatus)) return status as ToolStatus
  }
  return message.isError ? 'error' : 'ok'
}

/** pi 的用量 → `TokenUsage`。 */
export function fromPiUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
  }
}
