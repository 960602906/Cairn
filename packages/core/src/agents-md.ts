/**
 * 项目说明 `AGENTS.md`（M3-02，Runtime §8.1）。
 *
 * 这里只处理已经读到的字节：按 32 KB 截断、不把多字节字符截断在中间、统计行数。
 * 读文件在主进程（要看项目开关），不放在这里。
 */

/** 放进系统提示词的上限。超出的部分截掉并注明。 */
export const AGENTS_MD_MAX_BYTES = 32 * 1024

/** 截断时附在正文后面的说明（英文，和系统提示词的其他层一致）。 */
export const AGENTS_MD_TRUNCATION_NOTE =
  '[Truncated: AGENTS.md is larger than 32 KB. Only the first 32 KB is included.]'

export interface AgentsMdText {
  /** 放进提示词的正文，不含标题；截断时已附上说明。 */
  readonly text: string
  /** 实际纳入的原始字节（不含截断说明）。用来计算版本哈希。 */
  readonly included: Uint8Array
  readonly truncated: boolean
  /** 纳入的正文有多少行（不含截断说明）。 */
  readonly lines: number
}

/** 截到不超过 `max` 的完整 UTF-8 字符边界。`bytes` 比 `max` 长时才需要回退。 */
export function utf8PrefixEnd(bytes: Uint8Array, max: number): number {
  const end = Math.min(bytes.length, max)
  if (end === bytes.length || end === 0) return end
  let i = end
  while (i > 0 && (bytes[i - 1]! & 0xc0) === 0x80) i -= 1
  if (i === 0) return end
  const lead = bytes[i - 1]!
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
  return i - 1 + width > end ? i - 1 : end
}

/** 后续字节的低 6 位。不是后续字节时返回 undefined。 */
function continuation(bytes: Uint8Array, index: number): number | undefined {
  const byte = bytes[index]
  if (byte === undefined || (byte & 0xc0) !== 0x80) return undefined
  return byte & 0x3f
}

/** 把纳入的字节解成字符串。非法序列换成 U+FFFD。不依赖 DOM 或 Node 的解码器。 */
function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i]!
    if (lead < 0x80) {
      if (lead !== 0) out += String.fromCharCode(lead)
      i += 1
      continue
    }
    const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
    const c1 = continuation(bytes, i + 1)
    const c2 = width < 3 ? 0 : continuation(bytes, i + 2)
    const c3 = width < 4 ? 0 : continuation(bytes, i + 3)
    if (c1 === undefined || c2 === undefined || c3 === undefined) {
      out += '\uFFFD'
      i += 1
      continue
    }
    const code =
      width === 2
        ? ((lead & 0x1f) << 6) | c1
        : width === 3
          ? ((lead & 0x0f) << 12) | (c1 << 6) | c2
          : ((lead & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3
    const malformed =
      (width === 2 && code < 0x80) ||
      (width === 3 && code < 0x800) ||
      (width === 4 && (code < 0x10000 || code > 0x10ffff)) ||
      (code >= 0xd800 && code <= 0xdfff)
    out += malformed ? '\uFFFD' : String.fromCodePoint(code)
    i += width
  }
  return out
}

/** 统计行数。末尾的换行不算多出来的空行。 */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * 把读到的前缀变成提示词正文。`totalBytes` 是文件的完整大小：大于上限时截断并注明。
 * 正文只有空白时返回 undefined（当作没有这份文件）。
 */
export function decodeAgentsMd(
  bytes: Uint8Array,
  totalBytes: number,
  maxBytes = AGENTS_MD_MAX_BYTES,
): AgentsMdText | undefined {
  const end = utf8PrefixEnd(bytes, maxBytes)
  const included = bytes.subarray(0, end)
  const body = decodeUtf8(included)
  if (body.trim() === '') return undefined
  const truncated = totalBytes > maxBytes
  const lines = countLines(body)
  return {
    text: truncated ? `${body.trimEnd()}\n\n${AGENTS_MD_TRUNCATION_NOTE}` : body.trimEnd(),
    included,
    truncated,
    lines,
  }
}
