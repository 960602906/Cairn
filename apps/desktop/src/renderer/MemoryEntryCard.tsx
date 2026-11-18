/**
 * 一条记忆（M7-04）：设置页与会话信息面板共用。
 *
 * - 正文较长时默认折叠，可展开；编辑只在设置页开放。
 * - 删除要二次确认；会话面板里传入 `sessionId`，删除后该会话里的提议卡片会一起消失。
 * - 来源显示写入它的 Agent 与时间；没有来源（早期条目或手工写入）时显示时间。
 */
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryEntry } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  cn,
} from './ui/index.js'

const COLLAPSED_LENGTH = 180
const COLLAPSED_LINES = 4

export function MemoryEntryCard({
  entry,
  editable = false,
  sessionId,
  onChanged,
}: {
  readonly entry: MemoryEntry
  /** 允许编辑正文；会话信息面板里只允许删除。 */
  readonly editable?: boolean
  /** 删除时附带会话 id，让该会话里的提议卡片一起消失。 */
  readonly sessionId?: string
  readonly onChanged?: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const updateMemory = useSessionStore((s) => s.updateMemory)
  const deleteMemory = useSessionStore((s) => s.deleteMemory)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string>()
  const collapsible =
    entry.content.length > COLLAPSED_LENGTH || entry.content.split('\n').length > COLLAPSED_LINES
  const hidden = collapsible && !expanded
  const time = new Date(entry.updatedAt).toLocaleString(i18n.language)
  const source =
    entry.sourceAgentId === undefined
      ? t('memory.manage.sourceUnknown', { time })
      : t('memory.manage.source', { agent: entry.sourceAgentId, time })

  const save = async () => {
    const content = draft.trim()
    if (busy || content === '' || content === entry.content) {
      setEditing(false)
      return
    }
    setBusy(true)
    const saved = await updateMemory(entry.memoryId, content)
    setBusy(false)
    if (saved) {
      setEditing(false)
      setMessage(t('memory.manage.saved'))
      onChanged?.()
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    const removed = await deleteMemory(entry.memoryId, sessionId)
    setBusy(false)
    if (removed) {
      setConfirming(false)
      setMessage(t('memory.manage.deleted'))
      onChanged?.()
    }
  }

  return (
    <article aria-label={entry.content} className="rounded-card bg-raise p-3.5 shadow-1">
      <header className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-item px-1.5 py-0.5 text-note font-medium',
            entry.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn',
          )}
        >
          {entry.status === 'active' ? t('memory.manage.active') : t('memory.manage.proposed')}
        </span>
        <span className="min-w-0 flex-1 truncate text-note text-muted" title={source}>
          {source}
        </span>
        {editable && !editing && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('memory.manage.edit')}
            title={t('memory.manage.edit')}
            disabled={busy}
            onClick={() => {
              setDraft(entry.content)
              setEditing(true)
              setMessage(undefined)
            }}
          >
            <Pencil />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('memory.manage.delete')}
          title={t('memory.manage.delete')}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      </header>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            aria-label={t('memory.manage.edit')}
            className="min-h-24 w-full resize-y rounded-input bg-sunk px-3 py-2 text-ui leading-relaxed text-fg outline-none placeholder:text-faint"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => setEditing(false)}>
              {t('memory.manage.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || draft.trim() === ''}
              onClick={() => void save()}
            >
              {t('memory.manage.save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={cn(
              'mt-2 whitespace-pre-wrap text-ui leading-relaxed text-fg',
              hidden && 'line-clamp-4',
            )}
          >
            {entry.content}
          </p>
          {collapsible && (
            <button
              type="button"
              aria-expanded={expanded}
              className="mt-1 text-note text-accent hover:underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('memory.manage.collapse') : t('memory.manage.expand')}
            </button>
          )}
        </>
      )}

      {message !== undefined && (
        <p role="status" className="mt-1.5 text-note text-muted">
          {message}
        </p>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent tone="danger" icon={<Trash2 />}>
          <DialogTitle>{t('memory.manage.deleteTitle')}</DialogTitle>
          <DialogDescription>{t('memory.manage.deleteDescription')}</DialogDescription>
          <p className="mt-3 line-clamp-3 rounded-item bg-sunk px-2.5 py-1.5 text-note text-fg2">
            {entry.content}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t('memory.manage.cancel')}</Button>
            </DialogClose>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('memory.manage.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}
