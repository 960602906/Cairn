/**
 * ANSI 控制符（M2-06）：命令输出交给模型前去掉（`stripAnsi`、`AnsiStripper`），界面的终端卡片按 SGR 着色
 * （`AnsiParser`）。纯函数，不依赖 Node，宿主与渲染进程共用。
 *
 * - 识别 CSI（`ESC [ … 终止符`）、OSC（`ESC ] … BEL` 或 `ESC ] … ESC \`）与两字符的 ESC 序列；末尾不完整的
 *   序列也去掉。除制表符、换行、回车外的 C0 控制符一并去掉。
 * - 回车（不是 `\r\n` 的一部分）表示回到行首重写，常见于进度条：一行只保留最后一段非空内容。
 * - 颜色：0–15 为调色板序号（界面映射到 `--term-c*` 令牌）；256 色映射到最近的调色板颜色；真彩色保留
 *   `#rrggbb`。
 */

/** 调色板序号（0–15）或真彩色 `#rrggbb`。 */
export type AnsiColor = number | string

export interface AnsiStyle {
  readonly fg?: AnsiColor
  readonly bg?: AnsiColor
  readonly bold?: true
  readonly dim?: true
  readonly italic?: true
  readonly underline?: true
  readonly inverse?: true
  readonly strike?: true
}

export interface AnsiSegment {
  readonly text: string
  readonly style: AnsiStyle
  /** 来自标准错误。 */
  readonly stderr?: true
}

export type AnsiLine = readonly AnsiSegment[]

// 依次是：完整的 CSI、完整的 OSC、末尾不完整的 CSI / OSC、两字符序列、单独的 ESC、回车、换行、其他控制符
const TOKEN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*$|\x1b\][^\x07]*$|\x1b[ -/]*[0-~]|\x1b|(\r)|(\n)|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

interface Handlers {
  text(text: string): void
  sgr?(params: string): void
  cr(): void
  newline(): void
}

function scan(input: string, handlers: Handlers): void {
  TOKEN.lastIndex = 0
  let last = 0
  for (let match = TOKEN.exec(input); match !== null; match = TOKEN.exec(input)) {
    if (match.index > last) handlers.text(input.slice(last, match.index))
    last = TOKEN.lastIndex
    if (match[3] !== undefined) {
      // `\r\n` 只算换行
      if (input[last] !== '\n') handlers.cr()
    } else if (match[4] !== undefined) {
      handlers.newline()
    } else if (match[2] === 'm' && handlers.sgr) {
      handlers.sgr(match[1]!)
    }
  }
  if (last < input.length) handlers.text(input.slice(last))
}

/** 一行中按回车分段：遇到回车后，下一段非空内容开始时清空这一行。 */
class LineBuffer<T> {
  items: T[] = []
  private reset = false

  cr(): void {
    if (this.items.length > 0) this.reset = true
  }

  add(item: T): void {
    if (this.reset) {
      this.items = []
      this.reset = false
    }
    this.items.push(item)
  }

  take(): T[] {
    const items = this.items
    this.items = []
    this.reset = false
    return items
  }
}

/** 去掉 ANSI 控制符，并按回车只保留每行最后一段内容。 */
export function stripAnsi(text: string): string {
  const out: string[] = []
  const line = new LineBuffer<string>()
  scan(text, {
    text: (t) => line.add(t),
    cr: () => line.cr(),
    newline: () => {
      out.push(line.take().join(''), '\n')
    },
  })
  out.push(line.take().join(''))
  return out.join('')
}

/** 一行没有换行时最多暂存的字符数，超出就先交出去（不再按回车重写）。 */
export const ANSI_STRIPPER_MAX_PENDING = 8192

/**
 * 流式去除控制符：输出分块到达，序列和回车可能跨块。`push` 只交出已经结束的行，未结束的行暂存
 * （超过 `ANSI_STRIPPER_MAX_PENDING` 时先交出）；`end` 交出剩下的部分。
 */
export class AnsiStripper {
  private pending = ''

  push(text: string): string {
    this.pending += text
    const newline = this.pending.lastIndexOf('\n')
    if (newline >= 0) {
      const done = this.pending.slice(0, newline + 1)
      this.pending = this.pending.slice(newline + 1)
      return stripAnsi(done) + this.overflow()
    }
    return this.overflow()
  }

  private overflow(): string {
    if (this.pending.length <= ANSI_STRIPPER_MAX_PENDING) return ''
    // 保留可能不完整的序列，其余交出
    const esc = this.pending.lastIndexOf('\x1b')
    const cut = esc >= 0 && this.pending.length - esc < 256 ? esc : this.pending.length
    const done = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    return stripAnsi(done)
  }

  end(): string {
    const rest = stripAnsi(this.pending)
    this.pending = ''
    return rest
  }
}

// xterm 默认调色板，只用于把 256 色映射到最近的调色板颜色
const PALETTE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

function rgbOf256(n: number): readonly [number, number, number] {
  if (n < 16) return PALETTE[n]!
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return [v, v, v]
  }
  const i = n - 16
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return [level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)]
}

/** 256 色序号映射到最近的调色板序号（0–15）。 */
export function nearestPaletteColor(n: number): number {
  if (n < 16) return n
  const [r, g, b] = rgbOf256(n)
  let best = 0
  let bestDistance = Infinity
  PALETTE.forEach(([pr, pg, pb], index) => {
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')

type MutableStyle = { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] }

/** 解析扩展颜色（`38;5;n`、`38;2;r;g;b`，也接受冒号分隔），返回颜色与用掉的参数个数。 */
function extendedColor(
  params: readonly number[],
  at: number,
): { color: AnsiColor | undefined; used: number } {
  const mode = params[at]
  if (mode === 5) {
    const n = params[at + 1]
    const valid = n !== undefined && n >= 0 && n <= 255
    return { color: valid ? nearestPaletteColor(n) : undefined, used: 2 }
  }
  if (mode === 2) {
    const [r, g, b] = [params[at + 1], params[at + 2], params[at + 3]]
    if (r === undefined || g === undefined || b === undefined) return { color: undefined, used: 4 }
    return { color: `#${hex(r)}${hex(g)}${hex(b)}`, used: 4 }
  }
  return { color: undefined, used: 1 }
}

function applySgr(style: MutableStyle, raw: string): void {
  const groups = raw === '' ? [''] : raw.split(';')
  // 冒号分隔的子参数（`38:2::r:g:b`）展开成普通参数；色彩空间 id 为空时去掉
  const params: number[] = []
  for (const group of groups) {
    if (group.includes(':')) {
      const parts = group.split(':')
      const rgb = parts[1] === '2' && parts.length === 6
      parts.forEach((part, i) => {
        if (rgb && i === 2) return
        params.push(part === '' ? 0 : Number(part))
      })
    } else {
      params.push(group === '' ? 0 : Number(group))
    }
  }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) {
      for (const key of Object.keys(style) as (keyof MutableStyle)[]) delete style[key]
    } else if (p === 1) style.bold = true
    else if (p === 2) style.dim = true
    else if (p === 3) style.italic = true
    else if (p === 4 || p === 21) style.underline = true
    else if (p === 7) style.inverse = true
    else if (p === 9) style.strike = true
    else if (p === 22) {
      delete style.bold
      delete style.dim
    } else if (p === 23) delete style.italic
    else if (p === 24) delete style.underline
    else if (p === 27) delete style.inverse
    else if (p === 29) delete style.strike
    else if (p >= 30 && p <= 37) style.fg = p - 30
    else if (p >= 90 && p <= 97) style.fg = p - 90 + 8
    else if (p === 39) delete style.fg
    else if (p >= 40 && p <= 47) style.bg = p - 40
    else if (p >= 100 && p <= 107) style.bg = p - 100 + 8
    else if (p === 49) delete style.bg
    else if (p === 38 || p === 48) {
      const { color, used } = extendedColor(params, i + 1)
      i += used
      if (color === undefined) continue
      if (p === 38) style.fg = color
      else style.bg = color
    }
  }
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle) => {
  const keys = Object.keys(a) as (keyof AnsiStyle)[]
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * 把输出解析成带样式的行。样式状态跨 `write` 调用保留（stdout 与 stderr 共用一个终端）；
 * 同一行中样式相同、来源相同的相邻片段合并。
 */
export class AnsiParser {
  private readonly done: AnsiLine[] = []
  private readonly line = new LineBuffer<AnsiSegment>()
  private style: MutableStyle = {}
  /** 上一块末尾不完整的序列，留到下一块拼上。 */
  private carry = ''

  write(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    let input = this.carry + text
    this.carry = ''
    // eslint-disable-next-line no-control-regex
    const incomplete = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/.exec(input)
    if (incomplete && incomplete[0].length < 4096) {
      this.carry = incomplete[0]
      input = input.slice(0, incomplete.index)
    }
    const stderr = stream === 'stderr'
    scan(input, {
      text: (t) => this.line.add({ text: t, style: { ...this.style }, ...(stderr ? { stderr } : {}) }),
      sgr: (params) => {
        const next = { ...this.style }
        applySgr(next, params)
        this.style = next
      },
      cr: () => this.line.cr(),
      newline: () => this.done.push(merge(this.line.take())),
    })
  }

  /** 已经结束的行与最后一行（没有换行结尾时）。 */
  lines(): AnsiLine[] {
    const rest = this.line.items
    return rest.length > 0 ? [...this.done, merge(rest)] : [...this.done]
  }
}

function merge(segments: readonly AnsiSegment[]): AnsiLine {
  const out: AnsiSegment[] = []
  for (const segment of segments) {
    const prev = out.at(-1)
    if (prev && prev.stderr === segment.stderr && sameStyle(prev.style, segment.style)) {
      out[out.length - 1] = { ...prev, text: prev.text + segment.text }
    } else {
      out.push(segment)
    }
  }
  return out
}

/** 解析一段输出（或按顺序的 stdout / stderr 片段）。 */
export function parseAnsi(
  input: string | readonly { readonly text: string; readonly stream: 'stdout' | 'stderr' }[],
): AnsiLine[] {
  const parser = new AnsiParser()
  if (typeof input === 'string') parser.write(input)
  else for (const chunk of input) parser.write(chunk.text, chunk.stream)
  return parser.lines()
}
