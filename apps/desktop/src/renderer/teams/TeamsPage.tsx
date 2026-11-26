/**
 * 团队模板列表（M7-09）：名称、协作模式、主控与成员数、版本与状态。
 *
 * 列表只读，创建入口统一放在设置页头部；点开一行进入编辑器。
 */
import { Search, UsersRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTeamSummary } from '@cairn/protocol'
import { agentName, localized } from '../agents/model.js'
import { useSessionStore } from '../store-context.js'
import { cn, SegmentedControl } from '../ui/index.js'
import { teamStatus, type TeamStatus } from './model.js'

type Filter = 'all' | 'published' | 'draft' | 'archived'

const FILTERS: readonly Filter[] = ['all', 'published', 'draft', 'archived']

export function filterTeams(
  teams: readonly AgentTeamSummary[],
  filter: Filter,
  query: string,
): AgentTeamSummary[] {
  const text = query.trim().toLowerCase()
  return teams.filter((team) => {
    const status = teamStatus(team)
    if (filter === 'archived' ? !team.archived : team.archived) return false
    if (filter === 'published' && status === 'draft') return false
    if (filter === 'draft' && status !== 'draft') return false
    if (text === '') return true
    return [
      team.name['zh-CN'],
      team.name['en-US'],
      team.description['zh-CN'],
      team.description['en-US'],
      team.teamId,
    ]
      .filter((value): value is string => value !== undefined)
      .join('\n')
      .toLowerCase()
      .includes(text)
  })
}

function TeamRow({
  team,
  coordinator,
  onOpen,
}: {
  readonly team: AgentTeamSummary
  readonly coordinator: string
  readonly onOpen: (team: AgentTeamSummary) => void
}) {
  const { t, i18n } = useTranslation('teams')
  const status = teamStatus(team)
  const name = localized(team.name, i18n.language, team.teamId)
  const description = localized(team.description, i18n.language, t('list.open', { name }))
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(team)}
        className="flex w-full items-start gap-3 rounded-card bg-raise px-4 py-3.5 text-left shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)] transition-colors hover:bg-sunk"
      >
        <span
          aria-hidden
          className="mt-0.5 grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent shadow-hair [&_svg]:size-4"
        >
          <UsersRound />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14.5px] font-medium text-fg">{name}</span>
            {team.version > 0 && (
              <span className="tabular rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
                {t('version', { version: team.version })}
              </span>
            )}
            <span className="rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
              {t(`pattern.${team.pattern}`)}
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
            {t('list.meta', { coordinator, count: team.memberCount })}
          </span>
        </span>
      </button>
    </li>
  )
}

export function TeamsPage({
  onOpen,
}: {
  /** 打开编辑器；`teamId` 为空时创建新草稿。 */
  readonly onOpen: (teamId: string) => void
}) {
  const { t, i18n } = useTranslation('teams')
  const listTeams = useSessionStore((s) => s.listTeams)
  const agents = useSessionStore((s) => s.agents)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const [teams, setTeams] = useState<readonly AgentTeamSummary[] | undefined>(undefined)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshAgents({ includeArchived: true })
  }, [refreshAgents])

  useEffect(() => {
    let cancelled = false
    void listTeams(true).then((list) => {
      if (!cancelled) setTeams(list ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [listTeams])

  const open = useCallback((team: AgentTeamSummary) => onOpen(team.teamId), [onOpen])
  const loaded = teams ?? []
  const visible = filterTeams(loaded, filter, query)
  // 默认视图下全部模板都已归档时，引导用户切到「已归档」，而不是说“没有匹配”。
  const onlyArchived =
    filter !== 'archived' &&
    query.trim() === '' &&
    loaded.length > 0 &&
    loaded.every((team) => team.archived)
  const coordinatorName = (team: AgentTeamSummary): string => {
    const agent = agents.find((candidate) => candidate.agentId === team.coordinator)
    return agent ? agentName(agent, i18n.language) : team.coordinator
  }

  return (
    <div className="flex w-full flex-col gap-5">
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

      {teams !== undefined && loaded.length === 0 && query.trim() === '' ? (
        <p className="text-ui leading-relaxed text-muted">{t('list.empty')}</p>
      ) : null}

      {teams !== undefined && visible.length === 0 && loaded.length > 0 ? (
        <p className="text-ui text-muted">
          {t(onlyArchived ? 'list.onlyArchived' : 'list.noMatch')}
        </p>
      ) : (
        <ul aria-label={t('page.title')} className="flex flex-col gap-2.5">
          {visible.map((team) => (
            <TeamRow
              key={team.teamId}
              team={team}
              coordinator={coordinatorName(team)}
              onOpen={open}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** 供测试与列表行使用：状态限定在三种展示值。 */
export type { TeamStatus }
