/**
 * 搜索对话（M2-12，视觉规范 §2 侧栏“搜索 ⌘K”）：对话框顶部是输入框，下面是匹配的会话（标题与项目名，
 * 按最近更新排列）。输入的每个词都要出现在标题或项目名中，不区分大小写；没有输入时列出最近的会话。
 * 非空输入还会在消息正文里搜索（全文模式），命中的会话在标题下方显示片段。
 * ↑↓ 选择，Enter 打开，Esc 关闭。
 */
import type { ProjectSummary, SessionSummary } from '@cairn/protocol'
import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { lastSegment } from './paths.js'
import { projectDisplayName } from './project-name.js'
import { useSessionStore } from './store-context.js'
import { cn, Dialog, DialogContent, DialogTitle } from './ui/index.js'

/** 最多列出的会话数。 */
export const SEARCH_LIMIT = 50

/** 与 `session.searchText` 协议一致的最长查询。 */
export const SEARCH_QUERY_MAX = 200

/** 输入停顿多久之后去搜消息正文。 */
export const SEARCH_DEBOUNCE_MS = 150

const NO_SNIPPETS: ReadonlyMap<string, string> = new Map()

export interface SearchResult {
  readonly session: SessionSummary
  readonly project: string
  /** 消息正文里命中处的片段。 */
  readonly snippet?: string
}

/**
 * 按输入筛选会话：每个词都要出现在标题或项目名中（不区分大小写），或者会话出现在 `snippets`
 * （消息正文命中）里；保持原有顺序，最多 `limit` 个。
 */
export function searchSessions(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
  query: string,
  limit = SEARCH_LIMIT,
  defaultProjectName?: string,
  snippets: ReadonlyMap<string, string> = NO_SNIPPETS,
): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const results: SearchResult[] = []
  for (const session of sessions) {
    const match = projects.find((p) => p.path === session.projectPath)
    const project = projectDisplayName(match, defaultProjectName, lastSegment(session.projectPath))
    const text = `${session.title} ${project}`.toLowerCase()
    const snippet = snippets.get(session.sessionId)
    if (terms.every((term) => text.includes(term))) {
      results.push(snippet === undefined ? { session, project } : { session, project, snippet })
    } else if (snippet !== undefined) {
      results.push({ session, project, snippet })
    }
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
  const searchMessages = useSessionStore((s) => s.searchMessages)
  const showArchived = useSessionStore((s) => s.showArchivedSessions)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [messageHits, setMessageHits] = useState<{
    readonly query: string
    readonly snippets: ReadonlyMap<string, string>
  }>({ query: '', snippets: NO_SNIPPETS })
  const listId = useId()
  const defaultProjectName = tc('project.defaultName')
  const trimmed = query.trim()
  // 只有当前输入的结果才拿来用，避免输入变化时短暂显示上一次的片段
  const snippets = messageHits.query === trimmed ? messageHits.snippets : NO_SNIPPETS
  const searching = trimmed !== '' && messageHits.query !== trimmed
  const results = useMemo(
    () => searchSessions(sessions, projects, query, SEARCH_LIMIT, defaultProjectName, snippets),
    [sessions, projects, query, defaultProjectName, snippets],
  )

  // 每次打开都从空白开始
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setMessageHits({ query: '', snippets: NO_SNIPPETS })
    }
  }, [open])

  // 输入停顿之后再搜消息正文；响应回来时如果输入已经变了就丢掉
  useEffect(() => {
    if (!open || trimmed === '') return
    let stale = false
    const timer = setTimeout(() => {
      void searchMessages(trimmed, showArchived).then((hits) => {
        if (stale) return
        // 请求失败时也结束“正在搜索”，错误已经由 store 提示
        setMessageHits({
          query: trimmed,
          snippets: new Map((hits ?? []).map((hit) => [hit.sessionId, hit.snippet])),
        })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [open, trimmed, showArchived, searchMessages])

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

  const listRef = useRef<HTMLUListElement>(null)
  // 键盘上下选择时让当前结果保持在可视范围内；测试环境没有 scrollIntoView 时跳过。
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active, results])

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
            maxLength={SEARCH_QUERY_MAX}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {results.length === 0 ? (
          <p role="status" className="px-4 py-6 text-center text-ui text-muted">
            {sessions.length === 0
              ? t('list.empty')
              : searching
                ? t('search.searching')
                : t('search.empty')}
          </p>
        ) : (
          <ul
            ref={listRef}
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
                  'flex min-h-9 cursor-pointer flex-col justify-center gap-0.5 rounded-item px-2.5 py-1 text-ui',
                  index === active ? 'bg-hover text-fg' : 'text-fg2',
                )}
              >
                <span className="flex items-center gap-3">
                  <span
                    title={result.session.title === '' ? t('title.untitled') : result.session.title}
                    className="min-w-0 flex-1 truncate"
                  >
                    {result.session.title === '' ? t('title.untitled') : result.session.title}
                  </span>
                  <span
                    title={result.project}
                    className="max-w-[40%] shrink-0 truncate text-note text-muted"
                  >
                    {result.project}
                  </span>
                </span>
                {result.snippet !== undefined && (
                  <span title={result.snippet} className="truncate text-note text-muted">
                    {result.snippet}
                  </span>
                )}
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
