/**
 * 终端卡片（M2-06，视觉规范 §7.3）：`run_command` 的命令与输出。
 *
 * - 浅色、深色主题都用深色终端令牌（`--term-*`）；ANSI 颜色映射到 `--term-c0`～`--term-c15`，
 *   标准错误中没有着色的文字用 `--term-err`。
 * - 标题栏：`$ 命令`、退出码徽标（0 绿色 ✓，非 0 红色 ✕；超时、取消、信号用文字）、耗时、复制
 *   （复制去掉控制符的输出）。
 * - 输出区最高 220px，内部滚动，不折行；按固定行高只渲染看得见的行，1 万行也不卡。执行中停在底部时
 *   跟着新输出滚动，往上翻看时不打扰。
 * - 底部一行：测试的通过 / 失败 / 跳过数（能识别时）、Shell 与工作目录。
 */
import { Check, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  parseAnsi,
  stripAnsi,
  type AnsiColor,
  type AnsiLine,
  type AnsiSegment,
  type ToolOutputChunk,
} from '@cairn/core'
import { CopyButton } from './CopyButton.js'
import { summarizeTests } from './test-summary.js'
import { formatDuration } from './format.js'
import { cn, Spinner } from './ui/index.js'

/** 输出行高（规范 §4：终端 12.5px / 21px）。 */
export const TERMINAL_LINE_HEIGHT = 21
/** 输出区最大高度。 */
export const TERMINAL_MAX_HEIGHT = 220
/** 可见区域上下多渲染的行数。 */
const OVERSCAN = 20
const PADDING_Y = 8

export interface TerminalCardProps {
  readonly command: string
  readonly chunks: readonly ToolOutputChunk[]
  /** 省略的字符数；`omittedAt` 是省略处之后第一段的下标（0 表示省略的是开头）。 */
  readonly omittedChars?: number
  readonly omittedAt?: number
  readonly running?: boolean
  readonly exitCode?: number | null | undefined
  readonly signal?: string | undefined
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly durationMs?: number | undefined
  readonly shell?: string | undefined
  readonly cwd?: string | undefined
  readonly className?: string
}

type Row = AnsiLine | { readonly omitted: number; readonly earlier: boolean }

const isOmitted = (row: Row): row is Exclude<Row, AnsiLine> => 'omitted' in row

function buildRows(
  chunks: readonly ToolOutputChunk[],
  omittedChars: number,
  omittedAt: number,
): Row[] {
  if (omittedChars <= 0) return parseAnsi(chunks)
  const head = parseAnsi(chunks.slice(0, omittedAt))
  const tail = parseAnsi(chunks.slice(omittedAt))
  return [...head, { omitted: omittedChars, earlier: omittedAt === 0 }, ...tail]
}

const colorOf = (color: AnsiColor) => (typeof color === 'number' ? `var(--term-c${color})` : color)

function segmentStyle(segment: AnsiSegment): CSSProperties {
  const { style } = segment
  let fg =
    style.fg !== undefined ? colorOf(style.fg) : segment.stderr ? 'var(--term-err)' : undefined
  let bg = style.bg !== undefined ? colorOf(style.bg) : undefined
  if (style.inverse) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)']
  const decoration = [style.underline && 'underline', style.strike && 'line-through'].filter(
    Boolean,
  )
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { background: bg } : {}),
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.dim ? { opacity: 0.6 } : {}),
    ...(style.italic ? { fontStyle: 'italic' } : {}),
    ...(decoration.length > 0 ? { textDecoration: decoration.join(' ') } : {}),
  }
}

function Line({ row }: { readonly row: Row }) {
  const { t } = useTranslation('session')
  if (isOmitted(row)) {
    return (
      <div className="text-term-dim italic" style={{ height: TERMINAL_LINE_HEIGHT }}>
        {row.earlier
          ? t('terminal.earlierOmitted', { count: row.omitted })
          : t('terminal.omitted', { count: row.omitted })}
      </div>
    )
  }
  return (
    <div className="whitespace-pre" style={{ height: TERMINAL_LINE_HEIGHT }}>
      {row.map((segment, i) =>
        Object.keys(segment.style).length === 0 && !segment.stderr ? (
          segment.text
        ) : (
          <span key={i} style={segmentStyle(segment)}>
            {segment.text}
          </span>
        ),
      )}
    </div>
  )
}

function Badge({
  running,
  exitCode,
  signal,
  timedOut,
  aborted,
}: Pick<TerminalCardProps, 'running' | 'exitCode' | 'signal' | 'timedOut' | 'aborted'>) {
  const { t } = useTranslation('session')
  const base = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px]'
  if (running) {
    return (
      <span className={cn(base, 'text-term-dim')}>
        <Spinner className="size-3" />
        {t('terminal.running')}
      </span>
    )
  }
  if (timedOut) return <span className={cn(base, 'text-term-c1')}>{t('terminal.timedOut')}</span>
  if (aborted) return <span className={cn(base, 'text-term-dim')}>{t('terminal.aborted')}</span>
  if (exitCode === null || exitCode === undefined) {
    return signal ? (
      <span className={cn(base, 'text-term-c1')}>{t('terminal.signal', { signal })}</span>
    ) : null
  }
  const ok = exitCode === 0
  return (
    <span
      className={cn(base, 'tabular font-mono', ok ? 'text-term-ok' : 'text-term-c1')}
      style={{
        background: `color-mix(in srgb, var(${ok ? '--term-ok' : '--term-c1'}) 14%, transparent)`,
      }}
    >
      {ok ? (
        <Check aria-hidden className="size-3" strokeWidth={3} />
      ) : (
        <X aria-hidden className="size-3" strokeWidth={3} />
      )}
      <span className="sr-only">{t('terminal.exitCode', { code: exitCode })}</span>
      <span aria-hidden>{exitCode}</span>
    </span>
  )
}

export function TerminalCard({
  command,
  chunks,
  omittedChars = 0,
  omittedAt = 0,
  running = false,
  exitCode,
  signal,
  timedOut = false,
  aborted = false,
  durationMs,
  shell,
  cwd,
  className,
}: TerminalCardProps) {
  const { t } = useTranslation('session')
  const rows = useMemo(
    () => buildRows(chunks, omittedChars, omittedAt),
    [chunks, omittedChars, omittedAt],
  )
  const plain = useMemo(() => stripAnsi(chunks.map((c) => c.text).join('')), [chunks])
  const tests = useMemo(() => (running ? undefined : summarizeTests(plain)), [plain, running])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [scrollTop, setScrollTop] = useState(0)

  const total = rows.length * TERMINAL_LINE_HEIGHT
  const first = Math.max(0, Math.floor((scrollTop - PADDING_Y) / TERMINAL_LINE_HEIGHT) - OVERSCAN)
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + TERMINAL_MAX_HEIGHT) / TERMINAL_LINE_HEIGHT) + OVERSCAN,
  )

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !running || !stick.current) return
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [rows.length, running])

  const onScroll = () => {
    const el = scroller.current!
    stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - TERMINAL_LINE_HEIGHT
    setScrollTop(el.scrollTop)
  }

  const footer = Boolean(shell || cwd)
  const empty = rows.length === 0

  return (
    <figure
      aria-label={t('terminal.label', { command })}
      className={cn(
        'my-1 overflow-hidden rounded-card bg-term-bg text-term-fg shadow-hair2',
        className,
      )}
    >
      <figcaption className="flex h-[38px] items-center gap-2 border-b-[0.5px] border-term-line pr-1.5 pl-3.5 font-mono text-[12.5px]">
        <span aria-hidden className="shrink-0 text-term-acc select-none">
          $
        </span>
        <code className="min-w-0 flex-1 truncate" title={command}>
          {command}
        </code>
        <Badge
          running={running}
          exitCode={exitCode}
          signal={signal}
          timedOut={timedOut}
          aborted={aborted}
        />
        {!running && durationMs !== undefined && (
          <span className="tabular shrink-0 font-sans text-note text-term-dim">
            {formatDuration(durationMs)}
          </span>
        )}
        <CopyButton
          text={() => plain.replace(/\n+$/, '')}
          className="font-sans text-term-dim hover:bg-term-line hover:text-term-fg"
        />
      </figcaption>
      <div
        ref={scroller}
        role="log"
        aria-label={t('terminal.output')}
        tabIndex={0}
        onScroll={onScroll}
        className="overflow-auto px-3.5 font-mono text-term outline-none"
        style={{ maxHeight: TERMINAL_MAX_HEIGHT, paddingTop: PADDING_Y, paddingBottom: PADDING_Y }}
      >
        {empty ? (
          <div className="text-term-dim" style={{ height: TERMINAL_LINE_HEIGHT }}>
            {running ? '' : t('terminal.noOutput')}
          </div>
        ) : (
          <div className="relative w-max min-w-full" style={{ height: total }}>
            <div className="absolute inset-x-0" style={{ top: first * TERMINAL_LINE_HEIGHT }}>
              {rows.slice(first, last).map((row, i) => (
                <Line key={first + i} row={row} />
              ))}
            </div>
          </div>
        )}
      </div>
      {(tests || footer) && (
        <div className="flex h-8 items-center gap-3 border-t-[0.5px] border-term-line px-3.5 text-note text-term-dim">
          {tests && (
            <span className="tabular flex shrink-0 items-center gap-2">
              <span className="text-term-ok">
                {t('terminal.tests.passed', { count: tests.passed })}
              </span>
              {tests.failed > 0 && (
                <span className="text-term-c1">
                  {t('terminal.tests.failed', { count: tests.failed })}
                </span>
              )}
              {tests.skipped > 0 && (
                <span>{t('terminal.tests.skipped', { count: tests.skipped })}</span>
              )}
            </span>
          )}
          {footer && (
            <span className="ml-auto min-w-0 truncate font-mono text-[11.5px]" title={cwd}>
              {shell}
              {shell && cwd && ' · '}
              {cwd && (
                <>
                  <span className="sr-only">{t('terminal.cwd')} </span>
                  {cwd}
                </>
              )}
            </span>
          )}
        </div>
      )}
    </figure>
  )
}
