/**
 * diff 卡片（M2-07，视觉规范 §7.2）。
 *
 * - 标题栏与代码卡片相同：文件类型图标、路径、新文件 / 已删除标记、增删行数与 5 个比例方块；右侧是“合并 / 分栏”
 *   切换与“撤销此文件”（传入 `onRevert` 时才有）。卡片窄于 `SPLIT_MIN_WIDTH` 时只用合并视图，不显示切换。
 * - 每个 hunk 先是标题行（`@@ -a,b +c,d @@` 加所在函数名）。悬停标题行出现“撤销此块”（M3-06）；
 *   已撤销的块变灰并标注。每行是旧行号、新行号、`+` / `−` 标记与内容；
 *   新增行与删除行整行着色、行号槽更深，行内真正改动的词再加深一层。语法高亮对改动前后的全文分别进行。
 * - hunk 之间未改动的行折叠成一行“展开下方 N 行未改动的代码”；一次最多显示 `DIFF_MAX_ROWS` 行，其余点击后显示。
 * - 分栏视图左旧右新，对侧没有对应行时用斜线底纹占位，长行换行显示。
 */
import { Undo2, UnfoldVertical } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileChangeKind, FileChangeStatus } from '@cairn/protocol'
import { splitPath } from './CodeCard.js'
import {
  fileDiff,
  formatHunkHeader,
  ratioBlocks,
  toSplitRows,
  type DiffRow,
  type DiffSegment,
  type Range,
} from './diff-model.js'
import { FileTypeIcon } from './file-icons.js'
import { useHighlight, type HighlightedLines, type HighlightToken } from './highlight.js'
import type { LanguageInfo } from './languages.js'
import { cn } from './ui/index.js'

/** 卡片宽度不足时只用合并视图。 */
export const SPLIT_MIN_WIDTH = 640
export const DIFF_MAX_ROWS = 1000
const BODY_MAX_HEIGHT = 480

export type DiffContent =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly before: string; readonly after: string }
  | { readonly state: 'binary' }
  | { readonly state: 'too_large' }
  | { readonly state: 'error' }

export interface DiffCardProps {
  readonly path: string
  readonly kind: FileChangeKind
  readonly language?: LanguageInfo | undefined
  readonly content: DiffContent
  /** 内容还没读到时显示的增删行数（来自改动记录）。 */
  readonly added: number
  readonly removed: number
  readonly onRevert?: (() => void) | undefined
  readonly revertDisabled?: boolean
  /** 记录下来的块。与标题行号对上时才能撤销这一块。 */
  readonly hunks?: readonly DiffHunkState[]
  readonly onRevertHunk?: ((hunkIndex: number) => void) | undefined
  readonly revertHunkDisabled?: boolean
  readonly className?: string
}

export interface DiffHunkState {
  readonly index: number
  readonly status: FileChangeStatus
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

/** 增删比例的 5 个小方块。 */
export function RatioBlocks({
  added,
  removed,
}: {
  readonly added: number
  readonly removed: number
}) {
  const { add, del, empty } = ratioBlocks(added, removed)
  const block = 'size-[7px] rounded-[1.5px]'
  return (
    <span aria-hidden className="flex shrink-0 gap-[2px]">
      {Array.from({ length: add }, (_, i) => (
        <span key={`a${i}`} className={cn(block, 'bg-ok')} />
      ))}
      {Array.from({ length: del }, (_, i) => (
        <span key={`d${i}`} className={cn(block, 'bg-danger')} />
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className={cn(block, 'bg-hair2')} />
      ))}
    </span>
  )
}

export function ChangeCounts({
  added,
  removed,
}: {
  readonly added: number
  readonly removed: number
}) {
  return (
    <span className="tabular shrink-0 font-mono text-[12px]">
      <span className="text-add-fg">+{added}</span> <span className="text-del-fg">−{removed}</span>
    </span>
  )
}

export function KindBadge({ kind }: { readonly kind: FileChangeKind }) {
  const { t } = useTranslation('session')
  if (kind === 'modify') return null
  return (
    <span
      className={cn(
        'shrink-0 rounded-[4px] px-1.5 py-px text-[11px]',
        kind === 'create' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger',
      )}
    >
      {t(kind === 'create' ? 'code.new' : 'diff.deleted')}
    </span>
  )
}

/** 某一行的高亮结果；与行内容对不上（例如单独的 CR）时按纯文本显示。 */
function lineTokens(lines: HighlightedLines | undefined, no: number | undefined, text: string) {
  const tokens = no === undefined ? undefined : lines?.[no - 1]
  if (tokens && tokens.map((t) => t.content).join('') === text) return tokens
  return [{ content: text }]
}

const tokenStyle = (token: HighlightToken): CSSProperties => ({
  ...(token.color ? { color: token.color } : {}),
  ...(token.italic ? { fontStyle: 'italic' } : {}),
  ...(token.bold ? { fontWeight: 600 } : {}),
})

/** 按词级范围切开高亮片段，改动的部分加深底色。 */
export function LineContent({
  tokens,
  words,
  wordClass,
}: {
  readonly tokens: readonly HighlightToken[]
  readonly words: readonly Range[] | undefined
  readonly wordClass: string
}) {
  const parts: { token: HighlightToken; text: string; marked: boolean }[] = []
  let at = 0
  for (const token of tokens) {
    const end = at + token.content.length
    let cursor = at
    for (const [from, to] of words ?? []) {
      if (to <= cursor || from >= end) continue
      if (from > cursor) {
        parts.push({ token, text: token.content.slice(cursor - at, from - at), marked: false })
      }
      const stop = Math.min(to, end)
      parts.push({
        token,
        text: token.content.slice(Math.max(from, cursor) - at, stop - at),
        marked: true,
      })
      cursor = stop
    }
    if (cursor < end) parts.push({ token, text: token.content.slice(cursor - at), marked: false })
    at = end
  }
  return parts.map((part, i) => (
    <span
      key={i}
      style={tokenStyle(part.token)}
      className={part.marked ? cn('rounded-[2px]', wordClass) : undefined}
    >
      {part.text}
    </span>
  ))
}

const ROW_STYLE = {
  context: { row: '', gutter: 'bg-gutter-bg', marker: '', word: '' },
  add: { row: 'bg-add-bg', gutter: 'bg-add-gut', marker: 'text-add-fg', word: 'bg-add-word' },
  del: { row: 'bg-del-bg', gutter: 'bg-del-gut', marker: 'text-del-fg', word: 'bg-del-word' },
} as const

const MARKER = { context: ' ', add: '+', del: '−' } as const

interface Highlights {
  readonly old: HighlightedLines | undefined
  readonly new: HighlightedLines | undefined
}

const rowTokens = (row: DiffRow, hl: Highlights) =>
  row.type === 'add'
    ? lineTokens(hl.new, row.newNo, row.text)
    : lineTokens(hl.old, row.oldNo, row.text)

function UnifiedRow({ row, hl }: { readonly row: DiffRow; readonly hl: Highlights }) {
  const style = ROW_STYLE[row.type]
  const gutter = cn('w-[46px] shrink-0 pr-2.5 text-right select-none', style.gutter)
  return (
    <div className={cn('flex', style.row)} data-type={row.type}>
      <span aria-hidden className={cn(gutter, 'text-gutter')}>
        {row.oldNo}
      </span>
      <span aria-hidden className={cn(gutter, 'text-gutter')}>
        {row.newNo}
      </span>
      <span aria-hidden className={cn('w-5 shrink-0 text-center select-none', style.marker)}>
        {MARKER[row.type]}
      </span>
      <span className="flex-1 pr-4 whitespace-pre text-tk-v">
        <LineContent tokens={rowTokens(row, hl)} words={row.words} wordClass={style.word} />
      </span>
    </div>
  )
}

function SplitHalf({ row, hl }: { readonly row: DiffRow | undefined; readonly hl: Highlights }) {
  if (!row) {
    return (
      <div
        aria-hidden
        className="min-w-0 flex-1 bg-[repeating-linear-gradient(135deg,var(--hair)_0_1px,transparent_1px_7px)]"
      />
    )
  }
  const style = ROW_STYLE[row.type]
  const no = row.type === 'add' ? row.newNo : row.oldNo
  return (
    <div className={cn('flex min-w-0 flex-1', style.row)} data-type={row.type}>
      <span
        aria-hidden
        className={cn('w-[46px] shrink-0 pr-2.5 text-right text-gutter select-none', style.gutter)}
      >
        {no}
      </span>
      <span aria-hidden className={cn('w-5 shrink-0 text-center select-none', style.marker)}>
        {MARKER[row.type]}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap text-tk-v">
        <LineContent tokens={rowTokens(row, hl)} words={row.words} wordClass={style.word} />
      </span>
    </div>
  )
}

function Rows({
  rows,
  split,
  hl,
}: {
  readonly rows: readonly DiffRow[]
  readonly split: boolean
  readonly hl: Highlights
}) {
  if (!split) return rows.map((row, i) => <UnifiedRow key={i} row={row} hl={hl} />)
  return toSplitRows(rows).map((pair, i) => (
    <div key={i} className="flex">
      <SplitHalf row={pair.left} hl={hl} />
      <div aria-hidden className="w-[0.5px] shrink-0 bg-hair2" />
      <SplitHalf row={pair.right} hl={hl} />
    </div>
  ))
}

/** 卡片宽度；没有 ResizeObserver（测试环境）时为 undefined。 */
function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function sameHunk(hunk: DiffHunkState, header: DiffSegment & { kind: 'hunk' }) {
  const { oldStart, oldLines, newStart, newLines } = header.header
  return (
    hunk.oldStart === oldStart &&
    hunk.oldLines === oldLines &&
    hunk.newStart === newStart &&
    hunk.newLines === newLines
  )
}

function DiffBody({
  segments,
  split,
  hl,
  hunks,
  onRevertHunk,
  revertHunkDisabled,
}: {
  readonly segments: readonly DiffSegment[]
  readonly split: boolean
  readonly hl: Highlights
  readonly hunks: readonly DiffHunkState[]
  readonly onRevertHunk: ((hunkIndex: number) => void) | undefined
  readonly revertHunkDisabled: boolean
}) {
  const { t } = useTranslation('session')
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [showAll, setShowAll] = useState(false)
  let budget = showAll ? Infinity : DIFF_MAX_ROWS
  let hidden = 0
  let truncated = false
  const used = new Set<number>()
  const out = segments.map((segment, index) => {
    const open = segment.kind === 'hunk' || expanded.has(index)
    const count = open ? segment.rows.length : 0
    if (budget <= 0) {
      truncated = true
      hidden += count
      return null
    }
    const rows = segment.rows.slice(0, budget)
    budget -= open ? rows.length : 1
    if (open && rows.length < count) {
      truncated = true
      hidden += count - rows.length
    }
    const hunk =
      segment.kind === 'hunk'
        ? hunks.find((item, at) => {
            if (used.has(at) || !sameHunk(item, segment)) return false
            used.add(at)
            return true
          })
        : undefined
    const reverted = hunk?.status === 'reverted'
    return (
      <Fragment key={index}>
        {segment.kind === 'hunk' && (
          <div
            data-reverted={reverted ? '' : undefined}
            className={cn(reverted && 'opacity-60 saturate-0')}
          >
            <div className="group/hunk relative flex bg-hunk-bg text-hunk-fg">
              <span aria-hidden className="w-[46px] shrink-0 select-none" />
              {!split && <span aria-hidden className="w-[46px] shrink-0 select-none" />}
              <span className="truncate px-2">
                {formatHunkHeader(segment.header)}
                {segment.header.fn && <span className="ml-2 text-muted">{segment.header.fn}</span>}
              </span>
              {reverted ? (
                <span className="ml-auto shrink-0 pr-2 text-note text-muted">
                  {t('diff.hunkReverted')}
                </span>
              ) : (
                hunk &&
                onRevertHunk && (
                  <button
                    type="button"
                    disabled={revertHunkDisabled}
                    onClick={() => onRevertHunk(hunk.index)}
                    className="absolute top-0 right-1 inline-flex h-full items-center gap-1 rounded-[6px] px-1.5 text-note text-muted opacity-0 transition-opacity group-hover/hunk:opacity-100 focus-visible:opacity-100 hover:bg-hover hover:text-danger disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
                  >
                    <Undo2 aria-hidden />
                    {t('diff.revertHunk')}
                  </button>
                )
              )}
            </div>
            {open && <Rows rows={rows} split={split} hl={hl} />}
          </div>
        )}
        {segment.kind === 'hunk' ? null : open ? (
          <Rows rows={rows} split={split} hl={hl} />
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((s) => new Set(s).add(index))}
            className="flex w-full items-center gap-2 bg-hunk-bg/60 py-0.5 pl-3 text-left font-sans text-note text-hunk-fg hover:bg-hunk-bg"
          >
            <UnfoldVertical aria-hidden className="size-3.5" />
            {t('diff.expand', { count: segment.rows.length })}
          </button>
        )}
      </Fragment>
    )
  })
  return (
    <>
      {out}
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full py-1.5 text-center font-sans text-note text-accent hover:bg-hover"
        >
          {t('diff.showMore', { count: hidden })}
        </button>
      )}
    </>
  )
}

export function DiffCard({
  path,
  kind,
  language,
  content,
  added,
  removed,
  onRevert,
  revertDisabled = false,
  hunks = [],
  onRevertHunk,
  revertHunkDisabled = false,
  className,
}: DiffCardProps) {
  const { t } = useTranslation('session')
  const ref = useRef<HTMLElement>(null)
  const width = useWidth(ref)
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const canSplit = width === undefined || width >= SPLIT_MIN_WIDTH
  const split = canSplit && view === 'split'
  const ready = content.state === 'ready'
  const before = ready ? content.before.replace(/\r\n?/g, '\n') : ''
  const after = ready ? content.after.replace(/\r\n?/g, '\n') : ''
  const diff = useMemo(() => (ready ? fileDiff(before, after) : undefined), [ready, before, after])
  const hl: Highlights = {
    old: useHighlight(before, ready ? language : undefined),
    new: useHighlight(after, ready ? language : undefined),
  }
  const counts = diff ? { added: diff.added, removed: diff.removed } : { added, removed }
  const revertedHunks = hunks.filter((hunk) => hunk.status === 'reverted').length
  const { dir, name } = splitPath(path)

  const message = !diff
    ? t(`diff.${content.state}`)
    : diff.added + diff.removed > 0
      ? undefined
      : kind === 'create' && after === ''
        ? t('diff.emptyFile')
        : t('diff.empty')

  return (
    <figure
      ref={ref}
      aria-label={t('diff.label', { path })}
      className={cn('my-3 overflow-hidden rounded-card bg-code-bg shadow-hair2', className)}
    >
      <figcaption className="flex h-[38px] items-center gap-2 bg-code-head pr-1.5 pl-3 text-note">
        <FileTypeIcon name={path} />
        <span className="min-w-0 truncate font-mono text-[12px]" title={path}>
          <span className="text-muted">{dir}</span>
          <span className="font-semibold text-fg">{name}</span>
        </span>
        <KindBadge kind={kind} />
        {content.state !== 'binary' && content.state !== 'too_large' && (
          <>
            <ChangeCounts {...counts} />
            <RatioBlocks {...counts} />
          </>
        )}
        {revertedHunks > 0 && (
          <span className="text-muted">
            {t('diff.revertedCount', { reverted: revertedHunks, total: hunks.length })}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted">
          {canSplit && !message && (
            <span
              role="group"
              aria-label={t('diff.view')}
              className="flex rounded-[7px] bg-sunk2 p-0.5"
            >
              {(['unified', 'split'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'h-5 rounded-[5px] px-2 text-[11.5px] transition-colors',
                    view === v ? 'bg-raise text-fg shadow-1' : 'hover:text-fg',
                  )}
                >
                  {t(`diff.${v}`)}
                </button>
              ))}
            </span>
          )}
          {onRevert && (
            <button
              type="button"
              disabled={revertDisabled}
              onClick={onRevert}
              className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 transition-colors hover:bg-hover hover:text-danger disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
            >
              <Undo2 aria-hidden />
              {t('diff.revert')}
            </button>
          )}
        </span>
      </figcaption>
      {message ? (
        <div className="px-4 py-3 text-note text-muted">{message}</div>
      ) : (
        <div className="overflow-auto font-mono text-code" style={{ maxHeight: BODY_MAX_HEIGHT }}>
          <div className={split ? 'w-full' : 'w-max min-w-full'}>
            <DiffBody
              segments={diff!.segments}
              split={split}
              hl={hl}
              hunks={hunks}
              onRevertHunk={onRevertHunk}
              revertHunkDisabled={revertHunkDisabled}
            />
          </div>
        </div>
      )}
    </figure>
  )
}
