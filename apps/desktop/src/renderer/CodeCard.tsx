/**
 * 代码卡片（M2-06，视觉规范 §7.1）：Markdown 代码块与 `read_file` 的结果都用它。
 *
 * - 标题栏 38px：语言图标、路径（目录灰、文件名加粗）或语言名、“新文件”标记、增删行数；右侧换行与复制。
 * - 正文：行号列 46px，不可选中，复制时不带行号；重点行用浅蓝底、左侧强调色竖线，行号变为强调色。
 * - 高亮在渲染后异步完成（Shiki，`highlight.ts`），之前先显示纯文本。
 */
import { WrapText } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from './CopyButton.js'
import { useHighlight, type HighlightToken } from './highlight.js'
import type { LanguageInfo } from './languages.js'
import { cn } from './ui/index.js'

export interface CodeCardProps {
  readonly code: string
  readonly language?: LanguageInfo | undefined
  /** 代码块写的语言名（不认识时也显示）。 */
  readonly languageName?: string | undefined
  /** 文件路径；没有时标题栏显示语言名。 */
  readonly path?: string | undefined
  /** 第一行的行号，默认 1。 */
  readonly startLine?: number
  /** 要提醒注意的行（行号）。 */
  readonly highlightLines?: ReadonlySet<number>
  readonly isNew?: boolean
  readonly added?: number
  readonly removed?: number
  /** 正文的最大高度（像素），超出后内部滚动。 */
  readonly maxHeight?: number
  readonly className?: string
}

/** 解析代码块 info string 中的重点行，例如 `ts {2,4-6}`。 */
export function parseLineRanges(meta: string | undefined): ReadonlySet<number> {
  const lines = new Set<number>()
  const match = meta ? /\{([\d,\s-]+)\}/.exec(meta) : null
  if (!match) return lines
  for (const part of match[1]!.split(',')) {
    const [from, to] = part.split('-').map((s) => Number(s.trim()))
    if (!from || !Number.isInteger(from)) continue
    const end = to && Number.isInteger(to) ? Math.min(to, from + 10_000) : from
    for (let n = from; n <= end; n++) lines.add(n)
  }
  return lines
}

export function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

export function LanguageIcon({ language }: { readonly language: LanguageInfo | undefined }) {
  const label = language?.label ?? 'TXT'
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[7.5px] leading-none font-semibold tracking-tight"
      style={{
        color: `var(${language?.tone ?? '--muted'})`,
        background: `color-mix(in srgb, var(${language?.tone ?? '--muted'}) 14%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}

export function Token({ token }: { readonly token: HighlightToken }) {
  const style: CSSProperties = {
    ...(token.color ? { color: token.color } : {}),
    ...(token.italic ? { fontStyle: 'italic' } : {}),
    ...(token.bold ? { fontWeight: 600 } : {}),
  }
  return <span style={style}>{token.content}</span>
}

export function CodeCard({
  code,
  language,
  languageName,
  path,
  startLine = 1,
  highlightLines,
  isNew = false,
  added,
  removed,
  maxHeight,
  className,
}: CodeCardProps) {
  const { t } = useTranslation('session')
  const [wrap, setWrap] = useState(false)
  const text = useMemo(() => code.replace(/\r\n?/g, '\n').replace(/\n$/, ''), [code])
  const lines = useMemo(() => text.split('\n'), [text])
  const tokens = useHighlight(text, language)
  const { dir, name } = path ? splitPath(path) : { dir: '', name: '' }
  const title = path ?? (languageName?.trim() || language?.id || t('code.plainText'))
  const gutter = String(startLine + lines.length - 1).length > 4 ? 'w-[58px]' : 'w-[46px]'

  return (
    <figure
      aria-label={t('code.label', { title })}
      className={cn('my-3 overflow-hidden rounded-card bg-code-bg shadow-hair2', className)}
    >
      <figcaption className="flex h-[38px] items-center gap-2 bg-code-head pr-1.5 pl-3 text-note">
        <LanguageIcon language={language} />
        {path ? (
          <span className="min-w-0 truncate font-mono text-[12px]" title={path}>
            <span className="text-muted">{dir}</span>
            <span className="font-semibold text-fg">{name}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate font-mono text-[12px] text-muted">{title}</span>
        )}
        {isNew && (
          <span className="shrink-0 rounded-[4px] bg-ok-soft px-1.5 py-px text-[11px] text-ok">
            {t('code.new')}
          </span>
        )}
        {(added !== undefined || removed !== undefined) && (
          <span className="tabular shrink-0 font-mono text-[12px]">
            {added !== undefined && <span className="text-add-fg">+{added}</span>}{' '}
            {removed !== undefined && <span className="text-del-fg">−{removed}</span>}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 text-muted">
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((v) => !v)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5',
              wrap && 'text-accent',
            )}
          >
            <WrapText aria-hidden />
            {t('code.wrap')}
          </button>
          <CopyButton text={text} className="hover:bg-hover hover:text-fg" />
        </span>
      </figcaption>
      <div
        className="overflow-auto py-2.5 font-mono text-code [tab-size:4]"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <div className={cn(wrap ? 'w-full' : 'w-max min-w-full')}>
          {lines.map((line, i) => {
            const n = startLine + i
            const marked = highlightLines?.has(n) ?? false
            const lineTokens = tokens?.[i]
            return (
              <div
                key={i}
                data-line={n}
                data-highlighted={marked || undefined}
                className={cn('flex', marked && 'bg-line-hl shadow-[inset_2px_0_0_var(--accent)]')}
              >
                <span
                  aria-hidden
                  className={cn(
                    'tabular shrink-0 pr-4 text-right select-none',
                    gutter,
                    marked ? 'text-accent' : 'text-gutter',
                  )}
                >
                  {n}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 pr-4 text-tk-v',
                    wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
                  )}
                >
                  {lineTokens
                    ? lineTokens.map((token, j) => <Token key={j} token={token} />)
                    : line}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </figure>
  )
}
