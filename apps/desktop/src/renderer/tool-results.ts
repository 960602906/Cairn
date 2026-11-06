/**
 * 从工具交给模型的文本中取出卡片要显示的内容（M2-06）。格式由 `@cairn/tools` 决定：
 * - `read_file`：`File: 路径 | lines a-b of N | 编码…`，下面每行是“行号\t内容”（空行只有行号），最后是
 *   方括号里的说明；
 * - `run_command`：`Exit code: N`（或超时、取消、信号说明）、`Duration: 1.2 s`，然后是 `stdout:` /
 *   `stderr:` 两段。只在 `tool.completed` 没有 `display`（M2-06 之前的事件）时使用。
 * 格式对不上时返回 undefined，界面退回显示原文。
 */
import type { ToolDisplay } from '@cairn/protocol'

export interface ReadFileResult {
  readonly path: string
  readonly startLine: number
  readonly code: string
  /** 正文之后的说明（分段读取、编码问题等）。 */
  readonly notes: readonly string[]
}

const READ_HEADER = /^File: (.+?) \| lines (\d+)-(\d+) of (\d+)(?: \| .*)?$/
const NUMBERED = /^ *(\d+)(?:\t(.*))?$/

export function parseReadFileOutput(text: string): ReadFileResult | undefined {
  const [header, ...rest] = text.split('\n')
  const match = header ? READ_HEADER.exec(header) : null
  if (!match) return undefined
  const startLine = Number(match[2])
  const endLine = Number(match[3])
  const lines: string[] = []
  const notes: string[] = []
  for (const line of rest) {
    const numbered = notes.length === 0 ? NUMBERED.exec(line) : null
    if (numbered && Number(numbered[1]) === startLine + lines.length) {
      lines.push(numbered[2] ?? '')
    } else if (line.startsWith('[')) {
      notes.push(line)
    } else {
      return undefined
    }
  }
  if (lines.length !== endLine - startLine + 1) return undefined
  return { path: match[1]!, startLine, code: lines.join('\n'), notes }
}

type TerminalFallback = Omit<ToolDisplay, 'shell' | 'cwd'> & {
  readonly shell?: undefined
  readonly cwd?: undefined
}

/** 从交给模型的文本重建终端卡片的数据（没有颜色、Shell 与工作目录）。 */
export function parseRunCommandOutput(text: string): TerminalFallback | undefined {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const exit = /^Exit code: (-?\d+)$/.exec(first)
  const signal = /^Terminated by signal (.+)\.$/.exec(first)
  const timedOut = first.startsWith('Timed out after ')
  const aborted = first.startsWith('Cancelled;')
  if (!exit && !signal && !timedOut && !aborted) return undefined
  const durationLine = lines.findIndex((l) => /^Duration: [\d.]+ s$/.test(l))
  if (durationLine < 0) return undefined
  const durationMs = Math.round(Number(/[\d.]+/.exec(lines[durationLine]!)![0]) * 1000)
  const body = lines.slice(durationLine + 1).join('\n')
  const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = []
  const sections = /(?:^|\n)\n(stdout|stderr):\n/g
  const found = [...body.matchAll(sections)]
  found.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = found[i + 1]?.index ?? body.length
    chunks.push({ stream: m[1] as 'stdout' | 'stderr', text: `${body.slice(start, end)}\n` })
  })
  return {
    kind: 'terminal',
    exitCode: exit ? Number(exit[1]) : null,
    ...(signal && signal[1] !== 'unknown' ? { signal: signal[1] } : {}),
    timedOut,
    aborted,
    durationMs,
    chunks,
    omittedChars: 0,
  }
}
