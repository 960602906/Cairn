/**
 * 会话要点（M3-04）：右侧会话信息栏的一个标签页。显示 Markdown，可以编辑。
 * 保存走 `session.brief.update`，不是一轮对话。
 */
import { NotebookText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from './Markdown.js'
import { isMacPlatform } from './layout/shortcuts.js'
import { useSessionStore } from './store-context.js'
import { Button, PanelEmpty } from './ui/index.js'

export function SessionBriefPanel({ sessionId }: { readonly sessionId: string }) {
  const { t } = useTranslation('session')
  const brief = useSessionStore((s) => s.views[sessionId]?.brief)
  const updateBrief = useSessionStore((s) => s.updateBrief)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(brief?.content ?? '')
  const [saving, setSaving] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)

  // 进入编辑时把光标放到末尾；保存或取消后把焦点还给「编辑」按钮，不落到页面上。
  useEffect(() => {
    if (editing) {
      const element = editor.current
      element?.focus()
      element?.setSelectionRange(element.value.length, element.value.length)
    } else if (wasEditing.current) {
      editButton.current?.focus()
    }
    wasEditing.current = editing
  }, [editing])

  const save = async () => {
    setSaving(true)
    const ok = await updateBrief(sessionId, draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  const cancel = () => setEditing(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3">
        {editing ? (
          <textarea
            ref={editor}
            aria-label={t('brief.edit')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
                return
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void save()
              }
            }}
            className="h-full min-h-40 w-full resize-none rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none"
          />
        ) : brief?.content ? (
          <Markdown text={brief.content} />
        ) : (
          <PanelEmpty icon={<NotebookText />} className="px-2">
            {t('brief.empty')}
          </PanelEmpty>
        )}
      </div>
      <footer className="flex justify-end gap-2 px-3 py-3">
        {editing ? (
          <>
            <span className="mr-auto self-center text-[11px] text-faint">
              {t('brief.shortcut', { save: isMacPlatform() ? '⌘Enter' : 'Ctrl+Enter' })}
            </span>
            <Button variant="ghost" onClick={cancel}>
              {t('brief.cancel')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {t('brief.save')}
            </Button>
          </>
        ) : (
          <Button
            ref={editButton}
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
    </div>
  )
}
