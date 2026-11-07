/**
 * 会话要点（M3-04）：顶栏“更多”里打开右侧抽屉。显示 Markdown，可以编辑。
 * 保存走 `session.brief.update`，不是一轮对话。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, X } from 'lucide-react'
import { Markdown } from './Markdown.js'
import { useSessionStore } from './store-context.js'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from './ui/index.js'

export function SessionBriefMenu({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useTranslation('session')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('chat.more')} size="icon-sm" className="no-drag">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>{t('brief.open')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SessionBriefDrawer({
  sessionId,
  onClose,
}: {
  readonly sessionId: string
  readonly onClose: () => void
}) {
  const { t } = useTranslation('session')
  const brief = useSessionStore((s) => s.views[sessionId]?.brief)
  const updateBrief = useSessionStore((s) => s.updateBrief)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(brief?.content ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const ok = await updateBrief(sessionId, draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  return (
    <aside
      role="dialog"
      aria-label={t('brief.title')}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(360px,100%)] flex-col border-l-[0.5px] border-hair bg-paper shadow-2"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-hair px-3">
        <h3 className="text-ui font-medium text-fg">{t('brief.title')}</h3>
        <IconButton label={t('brief.close')} size="icon-sm" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {editing ? (
          <textarea
            aria-label={t('brief.edit')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-full min-h-40 w-full resize-none rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none"
          />
        ) : brief?.content ? (
          <Markdown text={brief.content} />
        ) : (
          <p className="text-ui text-muted">{t('brief.empty')}</p>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t-[0.5px] border-hair px-3 py-3">
        {editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t('brief.cancel')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {t('brief.save')}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(brief?.content ?? '')
              setEditing(true)
            }}
          >
            {t('brief.edit')}
          </Button>
        )}
      </footer>
    </aside>
  )
}
