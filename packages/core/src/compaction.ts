/**
 * 上下文压缩（M3-03，Runtime §8.3）。
 *
 * 历史超过可用空间的 80% 时，保留最近 2 轮的完整内容，更早的部分交给模型总结。
 * 总结失败时改为丢掉最早的工具输出（调用记录还在），并只提示一次。
 * 这里只决定怎么切、怎么估算；真正调用模型由宿主注入。
 */
import type { CanonicalMessage, ContentPart, EventPayload } from '@cairn/protocol'
import { estimateTokens, truncateMiddle } from './context-budget.js'
import type { RuntimeToolSpec } from './runtime.js'

/** 保留的最近轮数（Runtime §8.3，默认 2）。 */
export const COMPACTION_KEEP_TURNS = 2

/** 历史占用超过可用空间的这个比例时触发。 */
export const COMPACTION_TRIGGER_RATIO = 0.8

/** 交给摘要模型的转录上限，避免摘要请求自己撑满窗口。 */
const TRANSCRIPT_MAX_TOKENS = 8_000

/**
 * 摘要放进模型上下文时的前缀（发给模型，因此用英文）。
 * pi 适配器把 `summary` 消息转成用户消息时使用同一句。
 */
export const SUMMARY_PREFIX = 'Summary of the earlier conversation:\n\n'

/** 丢掉工具输出时留给模型的说明（发给模型，因此用英文）。 */
export const OMITTED_TOOL_OUTPUT =
  'Tool output omitted to free context space. The call itself still happened; do not assume its output.'

/** 摘要模型的系统提示词（英文，和系统提示词的其他层一致）。 */
export const COMPACTION_SYSTEM_PROMPT = [
  'You summarize an earlier part of a coding session for another model that will continue the work.',
  "Preserve the user's goals, decisions already made, files that were changed, and unfinished work.",
  "Be faithful to the transcript. Do not invent. Write in the user's language. Output only the summary.",
].join('\n')

export interface CompactionBudget {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  /** 系统提示词与工具定义已经占用的估算 token。 */
  readonly overheadTokens: number
}

/** 历史本身允许占用的 token：可用空间（窗口 − 预留输出 − 系统提示词与工具）的 80%。 */
export function historyTokenLimit(budget: CompactionBudget): number {
  const reserved = Math.min(budget.maxOutputTokens, Math.floor(budget.contextWindow / 2))
  const available = budget.contextWindow - reserved - budget.overheadTokens
  if (available <= 0) return 0
  return Math.floor(available * COMPACTION_TRIGGER_RATIO)
}

export function estimateOverhead(systemPrompt: string, tools: readonly RuntimeToolSpec[]): number {
  const listed = tools
    .map((tool) => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`)
    .join('\n')
  return estimateTokens(systemPrompt) + estimateTokens(listed)
}

function partText(part: ContentPart): string {
  return part.type === 'text' ? part.text : '[image]'
}

export function estimateMessageTokens(message: CanonicalMessage): number {
  switch (message.role) {
    case 'summary':
      return estimateTokens(message.content)
    case 'user':
      return estimateTokens(message.content.map(partText).join(''))
    case 'tool':
      return estimateTokens(message.content.map(partText).join(''))
    case 'assistant': {
      const calls = message.toolCalls?.length ? JSON.stringify(message.toolCalls) : ''
      return estimateTokens(
        `${message.content.map(partText).join('')}\n${message.reasoning?.text ?? ''}\n${calls}`,
      )
    }
  }
}

export function estimateMessagesTokens(messages: readonly CanonicalMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

interface TurnGroup {
  readonly id: string
  readonly messages: CanonicalMessage[]
}

function turnGroups(messages: readonly CanonicalMessage[]): {
  prefix: CanonicalMessage[]
  turns: TurnGroup[]
} {
  const prefix: CanonicalMessage[] = []
  const turns: TurnGroup[] = []
  let current: TurnGroup | undefined
  for (const message of messages) {
    if (message.role === 'summary' && !current) {
      prefix.push(message)
      continue
    }
    if (message.role === 'user') {
      if (current) turns.push(current)
      current = { id: message.turnId ?? `turn-${message.ts}`, messages: [message] }
      continue
    }
    if (!current) prefix.push(message)
    else current.messages.push(message)
  }
  if (current) turns.push(current)
  return { prefix, turns }
}

export interface SummarySplit {
  readonly earlier: readonly CanonicalMessage[]
  readonly kept: readonly CanonicalMessage[]
  readonly coversTurns: readonly [string, string]
}

/**
 * 切出要摘要的前缀。不足 `keepTurns` 轮时返回 undefined（没有可替换的更早轮次）。
 * 只在用户消息处切开，工具调用和它的结果留在同一侧。
 */
export function splitForSummary(
  messages: readonly CanonicalMessage[],
  keepTurns = COMPACTION_KEEP_TURNS,
): SummarySplit | undefined {
  const { prefix, turns } = turnGroups(messages)
  if (turns.length <= keepTurns) return undefined
  const dropped = turns.slice(0, turns.length - keepTurns)
  const kept = turns.slice(turns.length - keepTurns)
  const first = dropped[0]
  const last = dropped[dropped.length - 1]
  if (!first || !last) return undefined
  return {
    earlier: [...prefix, ...dropped.flatMap((turn) => turn.messages)],
    kept: kept.flatMap((turn) => turn.messages),
    coversTurns: [first.id, last.id],
  }
}

function messageText(message: CanonicalMessage): string {
  switch (message.role) {
    case 'summary':
      return `Previous summary:\n${message.content}`
    case 'user':
      return `User:\n${message.content.map(partText).join('')}`
    case 'assistant': {
      const calls = (message.toolCalls ?? [])
        .map((call) => `${call.name}(${JSON.stringify(call.input)})`)
        .join('\n')
      const body = message.content.map(partText).join('')
      return `Assistant:\n${body}${calls ? `\n${calls}` : ''}`
    }
    case 'tool':
      return `Tool ${message.toolCallId} (${message.status}):\n${message.content.map(partText).join('')}`
  }
}

/** 给摘要模型的转录。过长时保留开头和结尾。 */
export function renderTranscript(messages: readonly CanonicalMessage[]): string {
  const full = messages.map(messageText).join('\n\n')
  return truncateMiddle(full, TRANSCRIPT_MAX_TOKENS).text
}

export function summaryMessage(
  summary: string,
  coversTurns: readonly [string, string],
  ts: number,
): CanonicalMessage {
  return { role: 'summary', content: summary, coversTurns: [coversTurns[0], coversTurns[1]], ts }
}

export interface OmittedToolOutputs {
  readonly messages: readonly CanonicalMessage[]
  readonly omittedToolCallIds: readonly string[]
}

/**
 * 从最早的工具结果开始，把输出换成说明，直到不超过 `limit` 或没有可丢的输出。
 * 一次都没丢时返回 undefined。
 */
export function omitToolOutputs(
  messages: readonly CanonicalMessage[],
  limit: number,
): OmittedToolOutputs | undefined {
  const next = messages.map((message) => message)
  const omitted: string[] = []
  for (let i = 0; i < next.length; i += 1) {
    if (omitted.length > 0 && estimateMessagesTokens(next) <= limit) break
    const message = next[i]
    if (!message || message.role !== 'tool') continue
    const text = message.content.map(partText).join('')
    if (text === OMITTED_TOOL_OUTPUT) continue
    next[i] = { ...message, content: [{ type: 'text', text: OMITTED_TOOL_OUTPUT }] }
    omitted.push(message.toolCallId)
  }
  if (omitted.length === 0) return undefined
  return { messages: next, omittedToolCallIds: omitted }
}

export type CompactionSummarizer = (transcript: string) => Promise<string | undefined>

export type CompactionOutcome =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'summary'
      readonly messages: readonly CanonicalMessage[]
      readonly summary: string
      readonly coversTurns: readonly [string, string]
      readonly tokensBefore: number
      readonly tokensAfter: number
      readonly omittedToolCallIds: readonly string[]
    }
  | {
      readonly kind: 'degraded'
      readonly messages: readonly CanonicalMessage[]
      readonly coversTurns: readonly [string, string]
      readonly tokensBefore: number
      readonly tokensAfter: number
      readonly omittedToolCallIds: readonly string[]
    }

function contextTokens(budget: CompactionBudget, messages: readonly CanonicalMessage[]): number {
  return budget.overheadTokens + estimateMessagesTokens(messages)
}

function turnSpan(messages: readonly CanonicalMessage[]): readonly [string, string] | undefined {
  const { turns } = turnGroups(messages)
  const first = turns[0]
  const last = turns[turns.length - 1]
  if (!first || !last) return undefined
  return [first.id, last.id]
}

/**
 * 决定这一次调用模型前要不要压缩。`force` 时只要有可摘要的更早轮次就压缩，
 * 不管是否超过阈值（输入 `/compact`）。
 */
export async function compactConversation(input: {
  readonly messages: readonly CanonicalMessage[]
  readonly budget: CompactionBudget
  readonly force?: boolean
  readonly summarize?: CompactionSummarizer
  readonly now: number
}): Promise<CompactionOutcome> {
  const limit = historyTokenLimit(input.budget)
  const before = contextTokens(input.budget, input.messages)
  const over = estimateMessagesTokens(input.messages) > limit
  if (!input.force && !over) return { kind: 'none' }

  const split = splitForSummary(input.messages)
  if (split && input.summarize && (input.force || over)) {
    let summary: string | undefined
    try {
      summary = (await input.summarize(renderTranscript(split.earlier)))?.trim()
    } catch {
      summary = undefined
    }
    if (summary) {
      let messages: readonly CanonicalMessage[] = [
        summaryMessage(summary, split.coversTurns, input.now),
        ...split.kept,
      ]
      let omitted: readonly string[] = []
      if (estimateMessagesTokens(messages) > limit) {
        const dropped = omitToolOutputs(messages, limit)
        if (dropped) {
          messages = dropped.messages
          omitted = dropped.omittedToolCallIds
        }
      }
      return {
        kind: 'summary',
        messages,
        summary,
        coversTurns: split.coversTurns,
        tokensBefore: before,
        tokensAfter: contextTokens(input.budget, messages),
        omittedToolCallIds: omitted,
      }
    }
  }

  // 没超过阈值（只是用户要求压缩，但没有可摘要的更早轮次，或摘要失败）：不改历史。
  if (!over) return { kind: 'none' }
  const chosen = omitToolOutputs(input.messages, limit)
  if (!chosen) return { kind: 'none' }
  const span = turnSpan(input.messages) ?? (['compacted', 'compacted'] as const)
  return {
    kind: 'degraded',
    messages: chosen.messages,
    coversTurns: span,
    tokensBefore: before,
    tokensAfter: contextTokens(input.budget, chosen.messages),
    omittedToolCallIds: chosen.omittedToolCallIds,
  }
}

export function compactionEventPayload(
  outcome: Exclude<CompactionOutcome, { readonly kind: 'none' }>,
): EventPayload<'context.compacted'> {
  const base = {
    coversTurns: [outcome.coversTurns[0], outcome.coversTurns[1]] as [string, string],
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
    ...(outcome.omittedToolCallIds.length > 0
      ? { omittedToolCallIds: [...outcome.omittedToolCallIds] }
      : {}),
  }
  if (outcome.kind === 'summary') return { ...base, summary: outcome.summary }
  return { ...base, summary: '', degraded: true }
}

/** 被摘要替换的事件 seq 范围：从开始轮次的第一条到结束轮次的最后一条。 */
export function coveredSeqRange(
  events: readonly { readonly seq: number; readonly turnId?: string | undefined }[],
  coversTurns: readonly [string, string],
): readonly [number, number] | undefined {
  const [start, end] = coversTurns
  let from = -1
  let to = -1
  for (const event of events) {
    if (from === -1 && event.turnId === start) from = event.seq
    if (from !== -1 && event.turnId === end) to = event.seq
  }
  if (from === -1 || to === -1 || to < from) return undefined
  return [from, to]
}
