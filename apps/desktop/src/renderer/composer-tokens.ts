/**
 * 输入框草稿的分词：把一段文字切成普通文本、`/` 指令、`@` 引用、网址和代码片段。
 *
 * 纯函数，输入框的高亮层和消息渲染共用，保证两边认出来的东西一致。分词不改动文字：
 * 所有片段按顺序拼起来就是原文。
 *
 * 规则：
 * - 指令只认消息开头的 `/名称`，名称必须在指令表里，后面是空白或结尾；
 * - 代码是成对的三个反引号（可跨行）或同一行里成对的单个反引号，内部不再识别别的东西；
 * - 网址以 `http://` 或 `https://` 开头，只含 ASCII 字符（中文里网址后面常常直接跟汉字或
 *   全角标点，不能算进去），末尾的标点和不成对的右括号不算在内；
 * - 引用是开头或空白后面的 `@路径`，路径里有空格时写成 `@"路 径"`；后面可以跟行号
 *   `:12` 或 `:12-30`（ADR-0037）。遇到全角标点就断开，末尾的英文标点也不算在内。
 */
import type { PromptMention } from '@cairn/protocol'

export type ComposerTokenType = 'text' | 'command' | 'mention' | 'url' | 'code'

export interface ComposerToken {
  readonly type: ComposerTokenType
  readonly text: string
  /** 在原文里的起止位置（UTF-16 下标，止不含）。 */
  readonly start: number
  readonly end: number
}

export interface TokenizeOptions {
  /** 可用指令的名称（不含斜杠）。 */
  readonly commands?: Iterable<string>
}

/** 代码片段：围栏代码块在前，保证 ``` 不会被当成三个行内反引号。 */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g
const URL = /https?:\/\/[!#-&(-;=?-~]+/g
/** `@` 引用：开头或空白之后；带引号的路径可以有空格。 */
/** 全角标点不会出现在路径里：中文里引用后面常常直接跟标点，在这里断开。 */
const FULLWIDTH_PUNCT = '，。；：！？、（）【】「」『』《》'
const MENTION = new RegExp(
  `(?<=^|\\s)@(?:"[^"\\n]+"(?::\\d+(?:-\\d+)?)?|[^\\s"\`${FULLWIDTH_PUNCT}]+)`,
  'g',
)
/** 紧跟引用的中英文标点，不属于路径。 */
const MENTION_TRAILING = /[.,;!?，。；：！？、)）\]】」』'"]+$/u
const ACTIVE_MENTION = new RegExp(`(?<=^|\\s)@("[^"\\n]*|[^\\s"\`${FULLWIDTH_PUNCT}]*)$`)
const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$/
/** 一条消息最多带多少个引用，和主进程的上限一致。 */
export const MAX_MENTIONS = 20
/** 句子里紧跟网址的标点，不属于网址。 */
const TRAILING = /[.,;:!?]$/
const BRACKETS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

const count = (text: string, char: string) => text.split(char).length - 1

/** 去掉网址末尾的标点，以及没有对应左括号的右括号。 */
export function trimUrl(url: string): string {
  let result = url
  for (;;) {
    const last = result.at(-1) as string
    const open = BRACKETS[last]
    if (open !== undefined) {
      if (count(result, last) <= count(result, open)) return result
    } else if (!TRAILING.test(result)) {
      return result
    }
    result = result.slice(0, -1)
  }
}

interface Span {
  readonly type: Exclude<ComposerTokenType, 'text'>
  readonly start: number
  readonly end: number
}

function commandSpan(text: string, commands: ReadonlySet<string>): Span | undefined {
  const match = /^\/(\S+)(?=\s|$)/.exec(text)
  if (match === null || !commands.has(match[1] as string)) return undefined
  return { type: 'command', start: 0, end: match[0].length }
}

/** 引用的原文（不含 `@`）去掉末尾标点；`:` 只在后面不是行号时去掉。 */
function trimMention(raw: string): string {
  if (raw.startsWith('"')) return raw
  let result = raw.replace(MENTION_TRAILING, '')
  while (result.endsWith(':')) result = result.slice(0, -1).replace(MENTION_TRAILING, '')
  return result
}

/** 解析一个引用（不含 `@`）：路径和可选的行号范围。不是有效引用时返回 undefined。 */
export function parseMention(raw: string): PromptMention | undefined {
  let body = raw
  let lines: PromptMention['lines']
  const suffix = LINE_SUFFIX.exec(body)
  if (suffix !== null) {
    const start = Number(suffix[1])
    const end = suffix[2] === undefined ? start : Number(suffix[2])
    if (start >= 1 && end >= start) lines = { start, end }
    body = body.slice(0, suffix.index)
  }
  const path = body.startsWith('"') ? body.slice(1, -1) : body
  if (path.trim() === '' || path.includes('"')) return undefined
  return lines === undefined ? { path } : { path, lines }
}

/** 在 `[from, to)` 这段普通文字里找引用和网址。 */
function inlineSpans(text: string, from: number, to: number): Span[] {
  const slice = text.slice(from, to)
  const spans: Span[] = []
  for (const match of slice.matchAll(MENTION)) {
    const body = trimMention(match[0].slice(1))
    if (parseMention(body) === undefined) continue
    const start = from + match.index
    spans.push({ type: 'mention', start, end: start + 1 + body.length })
  }
  for (const match of slice.matchAll(URL)) {
    const url = trimUrl(match[0])
    // 只有协议头、没有主机的不算网址。
    if (!/^https?:\/\/[^/]/.test(url)) continue
    const start = from + match.index
    const end = start + url.length
    // `@` 引用里带着网址时以引用为准。
    if (spans.some((span) => span.start < end && start < span.end)) continue
    spans.push({ type: 'url', start, end })
  }
  return spans.sort((a, b) => a.start - b.start)
}

export function tokenize(text: string, options: TokenizeOptions = {}): ComposerToken[] {
  const spans: Span[] = []
  const command = commandSpan(text, new Set(options.commands ?? []))
  let cursor = 0
  if (command !== undefined) {
    spans.push(command)
    cursor = command.end
  }
  CODE.lastIndex = cursor
  for (let match = CODE.exec(text); match !== null; match = CODE.exec(text)) {
    spans.push(...inlineSpans(text, cursor, match.index))
    spans.push({ type: 'code', start: match.index, end: match.index + match[0].length })
    cursor = match.index + match[0].length
  }
  spans.push(...inlineSpans(text, cursor, text.length))

  const tokens: ComposerToken[] = []
  const push = (type: ComposerTokenType, start: number, end: number) => {
    if (end > start) tokens.push({ type, text: text.slice(start, end), start, end })
  }
  let position = 0
  for (const span of spans) {
    push('text', position, span.start)
    push(span.type, span.start, span.end)
    position = span.end
  }
  push('text', position, text.length)
  return tokens
}

/** 草稿里的所有引用，去重，最多 {@link MAX_MENTIONS} 个。代码片段里的 `@` 不算。 */
export function extractMentions(text: string): PromptMention[] {
  const mentions: PromptMention[] = []
  const seen = new Set<string>()
  for (const token of tokenize(text)) {
    if (token.type !== 'mention') continue
    const mention = parseMention(token.text.slice(1))
    if (mention === undefined) continue
    const key = `${mention.path}:${mention.lines?.start ?? ''}-${mention.lines?.end ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push(mention)
    if (mentions.length === MAX_MENTIONS) break
  }
  return mentions
}

/** 光标所在的、正在输入的引用：`start` 是 `@` 的位置，`query` 是 `@` 到光标之间的文字。 */
export function activeMention(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | undefined {
  const before = text.slice(0, caret)
  const match = ACTIVE_MENTION.exec(before)
  if (match === null) return undefined
  // 光标后面紧跟着非空白字符时说明在改一个已有的词，不弹候选。
  const after = text.slice(caret, caret + 1)
  if (after !== '' && !/\s/.test(after)) return undefined
  const raw = match[1] as string
  return { start: match.index, query: raw.startsWith('"') ? raw.slice(1) : raw }
}

/** 选中候选后写进草稿的文字：路径里有空白时加引号，目录以 `/` 结尾，末尾带一个空格。 */
export function mentionText(path: string, kind: 'file' | 'dir'): string {
  const full = kind === 'dir' ? `${path.replace(/\/+$/, '')}/` : path
  return /\s/.test(full) ? `@"${full}" ` : `@${full} `
}
