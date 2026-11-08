/**
 * Agents 页面（M3-12，管理界面 §3）：列表、筛选与搜索、空状态，点开进入编辑器。
 *
 * - 列表行显示图标、名称、描述、来源、版本与状态（已发布 / 有未发布修改 / 草稿 / 已归档）。
 * - 内置 Agent 不能编辑，只能复制；复制后直接进入新草稿的编辑器。
 * - 还没有自定义 Agent 时显示“基于编程助手创建”的引导。
 */
import { Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSource, AgentSummary } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { Button, cn, SegmentedControl } from '../ui/index.js'
import { AgentAvatar } from './AgentAvatar.js'
import { localized } from './model.js'

type Filter = 'all' | AgentSource | 'draft' | 'archived'

const FILTERS: readonly Filter[] = ['all', 'builtin', 'user', 'draft', 'archived']

export function agentName(agent: AgentSummary, language: string): string {
  return localized(agent.name, language, agent.agentId)
}

/** 状态文字：归档优先，其次草稿 / 有未发布修改 / 已发布。 */
export function agentStatus(agent: AgentSummary): 'archived' | 'draft' | 'dirty' | 'published' {
  if (agent.archived) return 'archived'
  if (agent.status === 'draft') return 'draft'
  return agent.hasDraft ? 'dirty' : 'published'
}

export function filterAgents(
  agents: readonly AgentSummary[],
  filter: Filter,
  query: string,
): AgentSummary[] {
  const text = query.trim().toLowerCase()
  return agents.filter((agent) => {
    if (filter === 'archived' ? !agent.archived : agent.archived) return false
    if (filter === 'builtin' && agent.source !== 'builtin') return false
    if (filter === 'user' && agent.source === 'builtin') return false
    if (filter === 'draft' && agent.status !== 'draft') return false
    if (!text) return true
    return [
      agent.name['zh-CN'],
      agent.name['en-US'],
      agent.description['zh-CN'],
      agent.description['en-US'],
      agent.agentId,
    ]
      .filter((value): value is string => value !== undefined)
      .join('\n')
      .toLowerCase()
      .includes(text)
  })
}

function AgentRow({
  agent,
  onOpen,
}: {
  readonly agent: AgentSummary
  readonly onOpen: (agent: AgentSummary) => void
}) {
  const { t, i18n } = useTranslation('agents')
  const status = agentStatus(agent)
  const name = agentName(agent, i18n.language)
  const description = localized(agent.description, i18n.language, t('list.open', { name }))
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(agent)}
        className="flex w-full items-start gap-3 rounded-card bg-raise px-4 py-3.5 text-left shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)] transition-colors hover:bg-sunk"
      >
        <AgentAvatar icon={agent.icon} color={agent.color} size={34} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14.5px] font-medium text-fg">{name}</span>
            {agent.version > 0 && (
              <span className="tabular rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
                {t('version', { version: agent.version })}
              </span>
            )}
            <span className="rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
              {t(`source.${agent.source}`)}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11.5px]',
                status === 'published' && 'bg-ok-soft text-ok',
                status === 'draft' && 'bg-warn-soft text-warn',
                status === 'dirty' && 'bg-accent-soft text-accent',
                status === 'archived' && 'bg-sunk text-muted',
              )}
            >
              {t(`status.${status}`)}
            </span>
          </span>
          <span className="mt-1 block line-clamp-2 text-[13px] leading-relaxed text-muted">
            {description}
          </span>
          <span className="mt-1 block text-note text-faint">
            {agent.modelMode === 'fixed' && agent.model
              ? `${agent.model.providerId} · ${agent.model.modelId}`
              : t('model.follow')}
          </span>
        </span>
      </button>
    </li>
  )
}

export function AgentsPage({
  onOpen,
  onCreate,
}: {
  /** 打开编辑器。`agentId` 为空时创建新草稿。 */
  readonly onOpen: (agentId: string) => void
  /** 从空白开始或复制编程助手。 */
  readonly onCreate: (mode: 'blank' | 'copy') => void
}) {
  const { t } = useTranslation('agents')
  const agents = useSessionStore((s) => s.agents)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshAgents({ includeArchived: true })
  }, [refreshAgents])

  const open = useCallback((agent: AgentSummary) => onOpen(agent.agentId), [onOpen])
  const visible = filterAgents(agents, filter, query)
  const custom = agents.filter((agent) => agent.source !== 'builtin' && !agent.archived)

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-8 pt-6 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-page tracking-[-0.01em] text-fg">{t('page.title')}</h2>
          <p className="mt-1 text-ui leading-relaxed text-muted">{t('page.description')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onCreate('copy')}>
            {t('new.copy')}
          </Button>
          <Button variant="primary" onClick={() => onCreate('blank')}>
            <Plus />
            {t('action.new')}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-item bg-raise px-2.5 text-ui shadow-hair2 focus-within:shadow-[0_0_0_1.5px_var(--accent)]">
          <Search className="size-3.5 shrink-0 text-faint" />
          <span className="sr-only">{t('search.placeholder')}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </label>
        <SegmentedControl
          label={t('filter.label')}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((value) => ({ value, label: t(`filter.${value}`) }))}
        />
      </div>

      {custom.length === 0 && filter !== 'archived' && query.trim() === '' ? (
        <section className="flex flex-col items-start gap-3 rounded-card bg-sunk px-5 py-6">
          <AgentAvatar icon="code" color="agent-blue" size={40} />
          <p className="text-ui text-fg2">{t('list.empty')}</p>
          <Button variant="primary" onClick={() => onCreate('copy')}>
            {t('list.emptyAction')}
          </Button>
        </section>
      ) : null}

      {visible.length === 0 ? (
        agents.length > 0 && <p className="text-ui text-muted">{t('list.noMatch')}</p>
      ) : (
        <ul aria-label={t('page.title')} className="flex flex-col gap-2.5">
          {visible.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} onOpen={open} />
          ))}
        </ul>
      )}
      {/* 列表为空时也提示当前没有匹配项，避免筛选后看起来像加载失败 */}
      {visible.length === 0 && agents.length === 0 && (
        <p className="sr-only">{t('list.noMatch')}</p>
      )}
    </div>
  )
}
