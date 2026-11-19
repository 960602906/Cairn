/**
 * 文件改动的入口（M2-07）：
 *
 * - **本轮变更**（视觉规范 §7.4，`TurnChanges`）：每轮结束、有文件改动时出现在最后一条助手消息下面，标题
 *   “本轮变更”和总增删数，下面每个文件一行（文件类型图标、路径、新文件 / 已删除标记、增删数、比例方块），点击展开
 *   对应的 diff 卡片。
 * - **右侧改动栏**（`SessionChangesPanel`）：列出本会话所有改动，可展开 diff 并撤销。
 * - **撤销此文件**：确认后整文件撤销这一项包含的所有改动（`changes.revert`）。只在会话空闲时可用；文件之后又被
 *   修改过时主进程整体拒绝，错误由错误横幅显示。
 * - **撤销此块**（M3-06）：一项只有一条改动时，diff 里每个对得上的块可以单独撤销。部分撤销时显示“已撤销 1/3 块”。
 */
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus } from '@cairn/core'
import type { FileContent, SessionStatus } from '@cairn/protocol'
import { splitPath } from './CodeCard.js'
import { ChangeCounts, DiffCard, KindBadge, RatioBlocks, type DiffContent } from './DiffCard.js'
import { fileEntries, totals, turnEntries, type FileEntry } from './file-changes.js'
import { FileTypeIcon } from './file-icons.js'
import { fileDragProps } from './file-drag.js'
import { languageForPath } from './languages.js'
import { useSessionStore } from './store-context.js'
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  PanelEmpty,
} from './ui/index.js'

/** 可以撤销文件的会话状态：没有在运行或等待审批。 */
const REVERT_STATUSES: ReadonlySet<SessionStatus> = new Set(['idle', 'failed', 'interrupted'])

export function useCanRevert(sessionId: string): boolean {
  return useSessionStore((s) => {
    const view = s.views[sessionId]
    if (!view || s.awaitingTurn[sessionId]) return false
    return REVERT_STATUSES.has(sessionStatus(view))
  })
}

/** 最早一次改动之前与最后一次改动之后的内容合成 diff 卡片的内容。 */
export function combineContent(
  before: FileContent | undefined,
  after: FileContent | undefined,
): DiffContent {
  const sides = [before, after]
  if (sides.some((s) => s?.kind === 'binary')) return { state: 'binary' }
  if (sides.some((s) => s?.kind === 'too_large')) return { state: 'too_large' }
  const text = (side: FileContent | undefined) => (side?.kind === 'text' ? side.text : '')
  return { state: 'ready', before: text(before), after: text(after) }
}

function useEntryContent(sessionId: string, entry: FileEntry): DiffContent {
  const changeContent = useSessionStore((s) => s.changeContent)
  const first = entry.changeIds[0]!
  const last = entry.changeIds.at(-1)!
  const key = `${first}:${last}`
  const [loaded, setLoaded] = useState<{ key: string; content: DiffContent }>()
  useEffect(() => {
    let alive = true
    void Promise.all([
      changeContent(sessionId, first),
      first === last ? undefined : changeContent(sessionId, last),
    ]).then(([start, end = start]) => {
      if (!alive) return
      setLoaded({
        key: `${first}:${last}`,
        content: start && end ? combineContent(start.before, end.after) : { state: 'error' },
      })
    })
    return () => {
      alive = false
    }
  }, [changeContent, sessionId, first, last])
  return loaded?.key === key ? loaded.content : { state: 'loading' }
}

/** 一个文件的 diff 卡片，带“撤销此文件”及其确认框。 */
export function FileDiff({
  sessionId,
  entry,
  canRevert,
}: {
  readonly sessionId: string
  readonly entry: FileEntry
  readonly canRevert: boolean
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const content = useEntryContent(sessionId, entry)
  const revertChanges = useSessionStore((s) => s.revertChanges)
  const revertHunk = useSessionStore((s) => s.revertHunk)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const revert = async () => {
    setBusy(true)
    await revertChanges(sessionId, entry.changeIds)
    setBusy(false)
    setConfirming(false)
  }
  const changeId = entry.changeIds.length === 1 ? entry.changeIds[0] : undefined
  return (
    <>
      <DiffCard
        className="my-0"
        path={entry.path}
        kind={entry.kind}
        language={languageForPath(entry.path)}
        content={content}
        added={entry.added}
        removed={entry.removed}
        hunks={entry.hunks ?? []}
        onRevert={() => setConfirming(true)}
        revertDisabled={!canRevert || busy}
        onRevertHunk={
          changeId
            ? (hunkIndex) => {
                setBusy(true)
                void revertHunk(sessionId, changeId, hunkIndex).finally(() => setBusy(false))
              }
            : undefined
        }
        revertHunkDisabled={!canRevert || busy}
      />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('diff.confirm.title')}</DialogTitle>
          <DialogDescription>{t(`diff.confirm.${entry.kind}`)}</DialogDescription>
          <code className="mt-3 block truncate rounded-item bg-sunk px-2.5 py-1.5 font-mono text-[12.5px] text-fg2">
            {entry.path}
          </code>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{tc('action.cancel')}</Button>
            </DialogClose>
            <Button variant="danger" disabled={busy || !canRevert} onClick={() => void revert()}>
              {t('diff.revert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * 按文件列出改动。给了 `onOpenFile` 时点击一行直接在右侧打开这个文件（改动视图）；
 * 省略时退回行内展开 diff（独立预览与旧调用）。
 */
/** 折叠时最多显示的文件行数；超出部分点“展开”再看。 */
const COLLAPSED_ROWS = 8

export function FileChangeList({
  sessionId,
  entries,
  onOpenFile,
  collapsible = false,
}: {
  readonly sessionId: string
  readonly entries: readonly FileEntry[]
  /** 点击文件：在右侧工作台打开它。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** 条目多时先列前 8 个，底部给出展开 / 收起。 */
  readonly collapsible?: boolean | undefined
}) {
  const { t } = useTranslation('session')
  const canRevert = useCanRevert(sessionId)
  const [showAll, setShowAll] = useState(false)
  const visible = collapsible && !showAll ? entries.slice(0, COLLAPSED_ROWS) : entries
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (!next.delete(path)) next.add(path)
      return next
    })
  /** 有打开回调时整行是“去右侧看”，不再在行内展开。 */
  const inline = onOpenFile === undefined
  return (
    <ul className="divide-y-[0.5px] divide-hair">
      {visible.map((entry) => {
        const expanded = inline && open.has(entry.path)
        const { dir, name } = splitPath(entry.path)
        return (
          <li key={entry.path}>
            <button
              type="button"
              {...fileDragProps(entry.path, 'file')}
              {...(inline
                ? { 'aria-expanded': expanded }
                : { title: t('tool.openFile', { path: entry.path }) })}
              onClick={() => {
                if (onOpenFile === undefined) toggle(entry.path)
                else onOpenFile(entry.path)
              }}
              className="group/file flex h-9 w-full items-center gap-2 px-3 text-left text-note hover:bg-hover"
            >
              <FileTypeIcon name={entry.path} />
              <span className="min-w-0 truncate font-mono text-[12px]" title={entry.path}>
                <span className="text-muted">{dir}</span>
                <span className="text-fg">{name}</span>
              </span>
              <KindBadge kind={entry.kind} />
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {entry.revertedHunks > 0 && (
                  <span className="text-muted">
                    {t('diff.revertedCount', {
                      reverted: entry.revertedHunks,
                      total: entry.hunkCount,
                    })}
                  </span>
                )}
                <ChangeCounts added={entry.added} removed={entry.removed} />
                <RatioBlocks added={entry.added} removed={entry.removed} />
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3.5 text-faint transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
              </span>
            </button>
            {expanded && (
              <div className="px-3 pb-3">
                <FileDiff sessionId={sessionId} entry={entry} canRevert={canRevert} />
              </div>
            )}
          </li>
        )
      })}
      {collapsible && entries.length > COLLAPSED_ROWS && (
        <li>
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
            className="flex h-9 w-full items-center justify-center gap-1.5 text-note text-muted hover:bg-hover"
          >
            {showAll
              ? t('changes.showLess')
              : t('changes.showMore', { count: entries.length - COLLAPSED_ROWS })}
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 text-faint transition-transform', showAll && 'rotate-180')}
            />
          </button>
        </li>
      )}
    </ul>
  )
}

/** 本轮变更：这一轮有文件改动时才显示。 */
export function TurnChanges({
  sessionId,
  turnId,
  onOpen,
  onOpenFile,
}: {
  readonly sessionId: string
  readonly turnId: string
  /** 打开右侧工作台的改动页面；省略时标题不可点。 */
  readonly onOpen?: (() => void) | undefined
  /** 点击文件：在右侧工作台打开这个文件（有改动时直接是 diff）。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const changes = useSessionStore((s) => s.changes[sessionId])
  const entries = useMemo(() => (changes ? turnEntries(changes, turnId) : []), [changes, turnId])
  if (entries.length === 0) return null
  const sum = totals(entries)
  return (
    <section
      aria-label={t('changes.turn')}
      className="mt-3 overflow-hidden rounded-card bg-paper shadow-hair2"
    >
      <header className="flex h-[38px] items-center bg-code-head text-note">
        {onOpen === undefined ? (
          <div className="flex h-full w-full items-center gap-2 px-3">
            <h4 className="font-semibold text-fg">{t('changes.turn')}</h4>
            <span className="text-muted">{t('changes.files', { count: sum.files })}</span>
            <span className="ml-auto">
              <ChangeCounts added={sum.added} removed={sum.removed} />
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-label={t('changes.openPanel')}
            className="group/turn flex h-full w-full items-center gap-2 px-3 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
          >
            <span className="font-semibold text-fg">{t('changes.turn')}</span>
            <span className="text-muted">{t('changes.files', { count: sum.files })}</span>
            <span className="ml-auto">
              <ChangeCounts added={sum.added} removed={sum.removed} />
            </span>
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 text-faint transition-transform group-hover/turn:translate-x-0.5"
            />
          </button>
        )}
      </header>
      <FileChangeList
        sessionId={sessionId}
        entries={entries}
        collapsible
        {...(onOpenFile === undefined ? {} : { onOpenFile })}
      />
    </section>
  )
}

/** 右侧会话信息栏中的全部改动。 */
export function SessionChangesPanel({
  sessionId,
  onOpenFile,
}: {
  readonly sessionId: string
  /** 点击文件：在右侧工作台打开它（切换到这个文件标签）。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const changes = useSessionStore((s) => s.changes[sessionId])
  const entries = useMemo(() => (changes ? fileEntries(changes) : []), [changes])
  if (entries.length === 0) {
    return <PanelEmpty icon={<FileDiffIcon />}>{t('changes.empty')}</PanelEmpty>
  }
  const sum = totals(entries)
  return (
    <section aria-label={t('changes.session')} className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-2 px-4 text-note">
        <h3 className="font-normal text-muted">{t('changes.session')}</h3>
        <span className="ml-auto shrink-0">
          <ChangeCounts added={sum.added} removed={sum.removed} />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t-[0.5px] border-hair pb-2">
        <FileChangeList
          sessionId={sessionId}
          entries={entries}
          {...(onOpenFile === undefined ? {} : { onOpenFile })}
        />
      </div>
    </section>
  )
}
