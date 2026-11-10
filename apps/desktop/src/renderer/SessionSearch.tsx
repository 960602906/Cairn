/**
 * 搜索对话（M2-12，视觉规范 §2 侧栏“搜索 ⌘K”）：对话框顶部是输入框，下面是匹配的会话（标题与项目名，
 * 按最近更新排列）。输入的每个词都要出现在标题或项目名中，不区分大小写；没有输入时列出最近的会话。
 * ↑↓ 选择，Enter 打开，Esc 关闭。
 */
import type { ProjectSummary, SessionSummary } from '@cairn/protocol'
import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { lastSegment } from './paths.js'
import { projectDisplayName } from './project-name.js'
import { useSessionStore } from './store-context.js'
import { cn, Dialog, DialogContent, DialogTitle } from './ui/index.js'

/** 最多列出的会话数。 */
export const SEARCH_LIMIT = 50

export interface SearchResult {
  readonly session: SessionSummary
  readonly project: string
}

/** 按输入筛选会话：每个词都要出现在标题或项目名中（不区分大小写），保持原有顺序，最多 `limit` 个。 */
export function searchSessions(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
  query: string,
  limit = SEARCH_LIMIT,
  defaultProjectName?: string,
): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const results: SearchResult[] = []
  for (const session of sessions) {
    const match = projects.find((p) => p.path === session.projectPath)
    const project = projectDisplayName(match, defaultProjectName, lastSegment(session.projectPath))
    const text = `${session.title} ${project}`.toLowerCase()
    if (terms.every((term) => text.includes(term))) results.push({ session, project })
    if (results.length >= limit) break
  }
  return results
}

export function SessionSearch({
  open,
  onOpenChange,
  onSelect,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** 选中会话之后（已经切换到这个会话）。 */
  readonly onSelect: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const projects = useSessionStore((s) => s.projects)
  const selectSession = useSessionStore((s) => s.selectSession)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const defaultProjectName = tc('project.defaultName')
  const results = useMemo(
    () => searchSessions(sessions, projects, query, SEARCH_LIMIT, defaultProjectName),
    [sessions, projects, query, defaultProjectName],
  )

  // 每次打开都从空白开始
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  const choose = (result: SearchResult | undefined) => {
    if (!result) return
    void selectSession(result.session.sessionId)
    onOpenChange(false)
    onSelect()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step !== 0 && results.length > 0) {
      event.preventDefault()
      setActive((i) => (i + step + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(results[active])
    }
  }

  const optionId = (index: number) => `${listId}-${index}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
        <div className="flex h-12 items-center gap-2.5 px-4 shadow-[0_0.5px_0_var(--hair)] [&_svg]:size-4 [&_svg]:text-muted">
          <Search />
          <input
            autoFocus
            role="combobox"
            aria-label={t('search.title')}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? optionId(active) : undefined}
            className="h-full flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {results.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui text-muted">
            {sessions.length === 0 ? t('list.empty') : t('search.empty')}
          </p>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('search.results')}
            className="max-h-[min(420px,50vh)] overflow-y-auto p-1.5"
          >
            {results.map((result, index) => (
              <li
                key={result.session.sessionId}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(result)}
                className={cn(
                  'flex h-9 cursor-pointer items-center gap-3 rounded-item px-2.5 text-ui',
                  index === active ? 'bg-hover text-fg' : 'text-fg2',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {result.session.title === '' ? t('title.untitled') : result.session.title}
                </span>
                <span className="max-w-[40%] shrink-0 truncate text-note text-muted">
                  {result.project}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 py-2 text-[11.5px] text-faint shadow-[0_-0.5px_0_var(--hair)]">
          {t('search.hint')}
        </p>
      </DialogContent>
    </Dialog>
  )
}
