/**
 * 上下文预算（M1-13a，架构 §9.4、§13，Runtime §8.2）。
 *
 * - `estimateTokens`：没有分词器时按字符粗略估算：中日韩文字、全角符号与表情（U+2E80 及以上）每个按
 *   1 token，其余每 4 个字符按 1 token，向上取整。偏保守。
 * - `toolOutputBudget`：单个工具结果的上限（token）：上下文窗口减去预留的输出后，取剩余部分的 25%，
 *   限制在 [`TOOL_OUTPUT_MIN_TOKENS`, `TOOL_OUTPUT_MAX_TOKENS`] 之间。预留的输出不超过窗口的一半，
 *   避免配置的最大输出与窗口相同时没有剩余。
 * - `truncateMiddle`：按估算的 token 保留开头与结尾，中间注明省略的字符数。
 *
 * 不依赖 DOM 与 Node 类型。
 */
import type { ModelProfile } from '@nexus/protocol'

/** 单个工具结果的绝对上限（约 3 万个英文字符）。 */
export const TOOL_OUTPUT_MAX_TOKENS = 8_000
/** 上下文很小的模型也至少给这么多。 */
export const TOOL_OUTPUT_MIN_TOKENS = 500
/** 单个工具结果最多占剩余空间的比例（Runtime §8.2）。 */
export const TOOL_OUTPUT_SHARE = 0.25

/** 按估算方式，每个字符的 token 数。 */
export function charTokens(codePoint: number): number {
  return codePoint >= 0x2e80 ? 1 : 0.25
}

export function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! >= 0x2e80) wide++
    else narrow++
  }
  return wide + Math.ceil(narrow / 4)
}

export function toolOutputBudget(
  profile: Pick<ModelProfile, 'contextWindow' | 'maxOutputTokens'>,
): number {
  const reserved = Math.min(profile.maxOutputTokens, Math.floor(profile.contextWindow / 2))
  const share = Math.floor((profile.contextWindow - reserved) * TOOL_OUTPUT_SHARE)
  return Math.min(TOOL_OUTPUT_MAX_TOKENS, Math.max(TOOL_OUTPUT_MIN_TOKENS, share))
}

/** `text` 开头不超过 `tokens` 的部分的长度（UTF-16 单元，不切开代理对）。 */
export function prefixWithinTokens(text: string, tokens: number): number {
  let used = 0
  let end = 0
  for (const ch of text) {
    used += charTokens(ch.codePointAt(0)!)
    if (used > tokens) break
    end += ch.length
  }
  return end
}

/** `text` 结尾不超过 `tokens` 的部分的起点。 */
function tailStart(text: string, tokens: number): number {
  let used = 0
  let start = text.length
  while (start > 0) {
    let size = 1
    const low = text.charCodeAt(start - 1)
    if (low >= 0xdc00 && low <= 0xdfff && start >= 2) {
      const high = text.charCodeAt(start - 2)
      if (high >= 0xd800 && high <= 0xdbff) size = 2
    }
    used += charTokens(text.codePointAt(start - size)!)
    if (used > tokens) break
    start -= size
  }
  return start
}

export interface TruncatedText {
  readonly text: string
  /** 省略的字符数（UTF-16 单元）；没有截断时为 0。 */
  readonly omitted: number
}

/**
 * 超过 `maxTokens` 时保留开头与结尾各约一半，中间换成 `marker(omitted)`（默认注明省略的字符数）。
 * 标记本身不计入预算。
 */
export function truncateMiddle(
  text: string,
  maxTokens: number,
  marker: (omitted: number) => string = (n) => `\n[... ${n} characters omitted ...]\n`,
): TruncatedText {
  if (estimateTokens(text) <= maxTokens) return { text, omitted: 0 }
  const head = prefixWithinTokens(text, Math.ceil(maxTokens / 2))
  const start = Math.max(head, tailStart(text, Math.floor(maxTokens / 2)))
  const omitted = start - head
  return { text: `${text.slice(0, head)}${marker(omitted)}${text.slice(start)}`, omitted }
}
