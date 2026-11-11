/**
 * 输入框草稿的分词：把一段文字切成普通文本、`/` 指令、网址和代码片段。
 *
 * 纯函数，输入框的高亮层和消息渲染共用，保证两边认出来的东西一致。分词不改动文字：
 * 所有片段按顺序拼起来就是原文。
 *
 * 规则：
 * - 指令只认消息开头的 `/名称`，名称必须在指令表里，后面是空白或结尾；
 * - 代码是成对的三个反引号（可跨行）或同一行里成对的单个反引号，内部不再识别别的东西；
 * - 网址以 `http://` 或 `https://` 开头，只含 ASCII 字符（中文里网址后面常常直接跟汉字或
 *   全角标点，不能算进去），末尾的标点和不成对的右括号不算在内。
 */

export type ComposerTokenType = 'text' | 'command' | 'url' | 'code'

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

/** 在 `[from, to)` 这段普通文字里找网址。 */
function urlSpans(text: string, from: number, to: number): Span[] {
  const spans: Span[] = []
  for (const match of text.slice(from, to).matchAll(URL)) {
    const url = trimUrl(match[0])
    // 只有协议头、没有主机的不算网址。
    if (!/^https?:\/\/[^/]/.test(url)) continue
    const start = from + match.index
    spans.push({ type: 'url', start, end: start + url.length })
  }
  return spans
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
    spans.push(...urlSpans(text, cursor, match.index))
    spans.push({ type: 'code', start: match.index, end: match.index + match[0].length })
    cursor = match.index + match[0].length
  }
  spans.push(...urlSpans(text, cursor, text.length))

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
