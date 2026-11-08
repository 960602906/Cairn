/**
 * 跨事件与 IPC 共用的数据结构。
 *
 * 这些是持久化格式和线上格式（与 pi 无关，ADR-0004、ADR-0005），因此放在最底层的 protocol 包，
 * core 中的领域类型（如 CanonicalMessage）直接复用它们。
 * 只能向后兼容地追加字段（架构 §7.3）。
 */
import { z } from 'zod'

export const Id = z.string().min(1)

/** 毫秒时间戳。 */
export const Timestamp = z.number().int().nonnegative()

export const DurationMs = z.number().int().nonnegative()

/** 错误以错误码加参数传递，由界面按当前语言翻译（ADR-0009、ADR-0013）。 */
export const ErrorInfo = z.object({
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
export type ErrorInfo = z.infer<typeof ErrorInfo>

/** 模型引用（Runtime §3.1）。 */
export const ModelRef = z.object({
  providerId: Id,
  modelId: Id,
})
export type ModelRef = z.infer<typeof ModelRef>

/** Agent 定义的某个版本（ADR-0016）。 */
export const AgentDefinitionRef = z.object({
  id: Id,
  version: z.number().int().positive(),
})
export type AgentDefinitionRef = z.infer<typeof AgentDefinitionRef>

/** 未发布草稿的引用（M4-12）：哈希标识试运行实际使用的草稿内容。 */
export const AgentDraftRef = z.object({
  id: Id,
  draftHash: Id,
})
export type AgentDraftRef = z.infer<typeof AgentDraftRef>

/** 运行可以引用已发布版本或试运行草稿。 */
export const RunAgentRef = z.union([AgentDefinitionRef, AgentDraftRef])
export type RunAgentRef = z.infer<typeof RunAgentRef>

export const isAgentDraftRef = (agent: RunAgentRef): agent is AgentDraftRef => 'draftHash' in agent

/** 消息内容片段（Runtime §17）。图片为预留。 */
export const ContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), blobRef: Id, mimeType: z.string().min(1) }),
])
export type ContentPart = z.infer<typeof ContentPart>

/**
 * 推理内容的一段原始块。签名等字段对应用不透明，只用于把推理原样带回给产生它的模型：
 * Anthropic 的 thinking 签名与 redacted_thinking 数据、Gemini 的 thought signature、
 * DeepSeek（openai 格式）回传推理时使用的字段名等（M1-01b）。
 */
export const ReasoningBlock = z.object({
  text: z.string(),
  signature: z.string().optional(),
  /** 被提供方的安全过滤隐去，内容只在 `signature` 中（加密）。 */
  redacted: z.boolean().optional(),
})
export type ReasoningBlock = z.infer<typeof ReasoningBlock>

/**
 * 推理内容（思考过程）。记录提供方，切换到其他提供方时不再发送给模型（Runtime §14）。
 * `text` 用于显示；`blocks` 只在需要原样回传时出现（有签名、被隐去或不止一块），此时以它为准。
 */
export const ReasoningPart = z.object({
  text: z.string(),
  providerId: Id,
  blocks: z.array(ReasoningBlock).optional(),
})
export type ReasoningPart = z.infer<typeof ReasoningPart>

/** 模型发出的工具调用。`input` 在工具流水线中按工具的参数 schema 校验。 */
export const ToolCall = z.object({
  id: Id,
  name: Id,
  input: z.unknown(),
  /** 提供方附在调用上的不透明签名（如 Gemini 的 thought signature），原样带回给同一模型。 */
  signature: z.string().optional(),
})
export type ToolCall = z.infer<typeof ToolCall>

/**
 * 一次模型调用的用量。`inputTokens` 含命中缓存的部分（`cacheReadTokens` 是其中的一部分），
 * `outputTokens` 含推理部分（`reasoningTokens` 是其中的一部分）。
 */
export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/** 运行状态（Runtime §5.1）。 */
export const RunState = z.enum([
  'idle',
  'thinking',
  'tooling',
  'awaiting_approval',
  'awaiting_children',
  'completed',
  'aborting',
  'failed',
  'interrupted',
  'disposed',
])
export type RunState = z.infer<typeof RunState>

/** 运行模式（ADR-0018）。 */
export const RunMode = z.enum(['interactive', 'unattended'])
export type RunMode = z.infer<typeof RunMode>

/**
 * 运行限额（Runtime §3.1、§10.3）。省略的项不限制：长任务（例如跑一整晚）不应被步数、时长或工具失败打断，
 * 默认全部不限，失败的工具结果照常交给模型自行处理（2026-11-07）。
 */
export const RunLimits = z.object({
  maxStepsPerTurn: z.number().int().positive().optional(),
  maxTurnDurationMs: DurationMs.optional(),
  maxTokensPerTurn: z.number().int().positive().optional(),
  maxCostPerTurn: z.number().positive().optional(),
  maxConsecutiveToolErrors: z.number().int().positive().optional(),
})
export type RunLimits = z.infer<typeof RunLimits>

/**
 * 规范化消息：持久化的对话历史格式，与 pi 无关（Runtime §17）。
 * 由事件推导，也用于 `host.init` 传递历史与 `run_snapshots` 快照。
 */
export const CanonicalMessage = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.array(ContentPart),
    ts: Timestamp,
    /** 这一轮的 id（M3-03）。压缩按轮次切开时用；旧历史没有。 */
    turnId: Id.optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.array(ContentPart),
    reasoning: ReasoningPart.optional(),
    toolCalls: z.array(ToolCall).optional(),
    model: ModelRef,
    ts: Timestamp,
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: Id,
    content: z.array(ContentPart),
    /** unknown：执行过程中被中断，结果未知（Runtime §13.2）。 */
    status: z.enum(['ok', 'error', 'denied', 'cancelled', 'unknown']),
    ts: Timestamp,
  }),
  z.object({
    role: z.literal('summary'),
    content: z.string(),
    coversTurns: z.tuple([Id, Id]),
    ts: Timestamp,
  }),
])
export type CanonicalMessage = z.infer<typeof CanonicalMessage>
