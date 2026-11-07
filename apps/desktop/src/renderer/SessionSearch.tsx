/**
 * 搜索会话（M2-12，视觉规范 §2 的 ⌃K）：对话框列出最近的会话，按标题或项目过滤。
 * 方向键移动，Enter 或点击打开，Esc 关闭。侧栏收起时快捷键仍然可用。
 */
import { Search } from 'lucide-react'
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { searchSessions } from './session-search.js'
import { useSessionStore } from './store-context.js'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/index.js'

export function SessionSearch({
  open,
  onOpenChange,
  onSelect,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: () => void
}) {
  const { t } = useTranslation('session')
  const sessions = useSessionStore((s) => s.sessions)
  const projects = useSessionStore((s) => s.projects)
  const refreshSessions = useSessionStore((s) => s.refreshSessions)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const selectSession = useSessionStore((s) => s.selectSession)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const untitled = t('title.untitled')
  const hits = searchSessions(sessions, projects, query, untitled)
  const current = hits[active]

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    void refreshSessions()
    void refreshProjects()
  }, [open, refreshProjects, refreshSessions])

  const choose = (sessionId: string) => {
    void selectSession(sessionId)
    onSelect()
    onOpenChange(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (hits.length === 0 ? 0 : (index + 1) % hits.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (hits.length === 0 ? 0 : (index - 1 + hits.length) % hits.length))
    } else if (event.key === 'Enter' && current) {
      event.preventDefault()
      choose(current.session.sessionId)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
      }}
    >
      <DialogContent data-session-search="" className="w-[min(480px,calc(100vw-32px))] p-3">
        <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('search.placeholder')}</DialogDescription>
        <div className="flex items-center gap-2 px-2">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.session.sessionId}` : undefined}
            aria-autocomplete="list"
            autoFocus
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            className="h-9 w-full bg-transparent text-ui text-fg outline-none placeholder:text-faint"
          />
        </div>
        {hits.length === 0 ? (
          <p className="px-2 py-6 text-center text-ui text-muted">{t('search.empty')}</p>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('search.title')}
            className="mt-1 max-h-80 overflow-y-auto"
          >
            {hits.map((hit, index) => (
              <li key={hit.session.sessionId} role="presentation">
                <button
                  id={`${listId}-${hit.session.sessionId}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(hit.session.sessionId)}
                  className={`flex w-full flex-col rounded-item px-2.5 py-1.5 text-left ${index === active ? 'bg-hover' : ''}`}
                >
                  <span className="truncate text-ui text-fg">{hit.title}</span>
                  <span className="truncate text-note text-muted">{hit.projectName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
