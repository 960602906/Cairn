/**
 * 文件改动的入口（M2-07）：
 *
 * - **本轮变更**（视觉规范 §7.4，`TurnChanges`）：每轮结束、有文件改动时出现在最后一条助手消息下面，标题
 *   “本轮变更”和总增删数，下面每个文件一行（语言图标、路径、新文件 / 已删除标记、增删数、比例方块），点击展开
 *   对应的 diff 卡片。
 * - **顶栏改动摘要**（`SessionChanges`）：“N 个文件 +a −b”，点击打开对话框列出本会话所有改动。
 * - **撤销此文件**：确认后整文件撤销这一项包含的所有改动（`changes.revert`）。只在会话空闲时可用；文件之后又被
 *   修改过时主进程整体拒绝，错误由错误横幅显示。
 */
import { ChevronRight, FileDiff as FileDiffIcon, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus } from '@cairn/core'
import type { FileContent, SessionStatus } from '@cairn/protocol'
import { LanguageIcon, splitPath } from './CodeCard.js'
import { ChangeCounts, DiffCard, KindBadge, RatioBlocks, type DiffContent } from './DiffCard.js'
import { fileEntries, totals, turnEntries, type FileEntry } from './file-changes.js'
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
  DialogTrigger,
} from './ui/index.js'

/** 可以撤销文件的会话状态：没有在运行或等待审批。 */
const REVERT_STATUSES: ReadonlySet<SessionStatus> = new Set(['idle', 'failed', 'interrupted'])

function useCanRevert(sessionId: string): boolean {
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
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const revert = async () => {
    setBusy(true)
    await revertChanges(sessionId, entry.changeIds)
    setBusy(false)
    setConfirming(false)
  }
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
        onRevert={() => setConfirming(true)}
        revertDisabled={!canRevert || busy}
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

/** 按文件列出改动，点击一行展开 diff。 */
export function FileChangeList({
  sessionId,
  entries,
}: {
  readonly sessionId: string
  readonly entries: readonly FileEntry[]
}) {
  const canRevert = useCanRevert(sessionId)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (!next.delete(path)) next.add(path)
      return next
    })
  return (
    <ul className="divide-y-[0.5px] divide-hair">
      {entries.map((entry) => {
        const expanded = open.has(entry.path)
        const { dir, name } = splitPath(entry.path)
        return (
          <li key={entry.path}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(entry.path)}
              className="group/file flex h-9 w-full items-center gap-2 px-3 text-left text-note hover:bg-hover"
            >
              <LanguageIcon language={languageForPath(entry.path)} />
              <span className="min-w-0 truncate font-mono text-[12px]" title={entry.path}>
                <span className="text-muted">{dir}</span>
                <span className="text-fg">{name}</span>
              </span>
              <KindBadge kind={entry.kind} />
              <span className="ml-auto flex shrink-0 items-center gap-2">
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
    </ul>
  )
}

/** 本轮变更：这一轮有文件改动时才显示。 */
export function TurnChanges({
  sessionId,
  turnId,
}: {
  readonly sessionId: string
  readonly turnId: string
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
      <header className="flex h-[38px] items-center gap-2 bg-code-head px-3 text-note">
        <h4 className="font-semibold text-fg">{t('changes.turn')}</h4>
        <span className="text-muted">{t('changes.files', { count: sum.files })}</span>
        <span className="ml-auto">
          <ChangeCounts added={sum.added} removed={sum.removed} />
        </span>
      </header>
      <FileChangeList sessionId={sessionId} entries={entries} />
    </section>
  )
}

/** 顶栏的本会话改动摘要；点击打开对话框列出所有改动。没有改动时不显示。 */
export function SessionChanges({ sessionId }: { readonly sessionId: string }) {
  const { t } = useTranslation('session')
  const changes = useSessionStore((s) => s.changes[sessionId])
  const entries = useMemo(() => (changes ? fileEntries(changes) : []), [changes])
  if (entries.length === 0) return null
  const sum = totals(entries)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t('changes.summary', {
            count: sum.files,
            added: sum.added,
            removed: sum.removed,
          })}
          className="no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-item px-2 text-note text-fg2 hover:bg-hover"
        >
          <FileDiffIcon aria-hidden className="size-3.5 text-muted" />
          {t('changes.files', { count: sum.files })}
          <ChangeCounts added={sum.added} removed={sum.removed} />
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100vh-64px)] w-[min(860px,calc(100vw-32px))] flex-col p-0">
        <div className="px-6 pt-5 pb-3">
          <DialogTitle>{t('changes.session')}</DialogTitle>
          <DialogDescription>{t('changes.sessionHint')}</DialogDescription>
        </div>
        <div className="min-h-0 overflow-y-auto border-t-[0.5px] border-hair pb-2">
          <FileChangeList sessionId={sessionId} entries={entries} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
