/**
 * 输入框里的 Agent / 团队选择器（M6-08、M7-09，管理界面 §7.1/§7.2）。
 *
 * 只列出已发布且未归档的 Agent 与团队模板：草稿需先发布才能在会话里选用。内置的
 * Agent 排在前面，自定义的随后；同一组里最近选过的靠前，其余保持 `agent.list` 的顺序。
 * 团队模板排在最前，选中后以模板的主控 Agent 为根运行，并纳入后续每一轮的协作说明。
 * 名称、描述（两种语言）与 id 都可以搜。⌘. / Ctrl+. 打开；运行中不能切换——与主进程
 * `session.setAgent` / `session.setTeam` 的 Busy 校验一致。
 * 会话页的切换会在同一会话里开始一个新运行，对话中出现“已切换到 …”的分隔提示（由事件驱动）；
 * 新对话页通过 `onSelect` / `onSelectTeam` 只记录选择，等创建会话时再应用。
 */
import { Check, ChevronDown, Search, Settings2, UsersRound } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_CODER_ID } from '@cairn/core'
import type {
  AgentDefinitionRef,
  AgentSummary,
  AgentTeamSummary,
  LocalizedText,
} from '@cairn/protocol'
import { agentPickerShortcut, isAgentPickerKey } from '../layout/shortcuts.js'
import { useSessionStore } from '../store-context.js'
import { Kbd, cn } from '../ui/index.js'
import { AgentAvatar } from './AgentAvatar.js'
import { agentName, localized } from './model.js'

/** 可选的 Agent：已发布、未归档且有可运行的版本。 */
export function availableAgents(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter(
    (agent) => !agent.archived && agent.status === 'published' && agent.version > 0,
  )
}

/** 可选的团队模板：已发布、未归档且有已发布版本。 */
export function availableTeams(teams: readonly AgentTeamSummary[]): AgentTeamSummary[] {
  return teams.filter((team) => !team.archived && team.status === 'published' && team.version > 0)
}

/**
 * 候选：内置的排在前面，自定义的随后；同一组里先按“最近使用”的先后，再保持列表顺序。
 * `query` 同时匹配两种语言的名称与描述和 id。
 */
export function pickerAgents(
  agents: readonly AgentSummary[],
  recent: readonly string[],
  query: string,
): AgentSummary[] {
  const text = query.trim().toLowerCase()
  const rank = (agent: AgentSummary) => {
    const index = recent.indexOf(agent.agentId)
    return index === -1 ? recent.length : index
  }
  return availableAgents(agents)
    .filter((agent) => {
      if (text === '') return true
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
    .map((agent, index) => ({
      agent,
      index,
      group: agent.source === 'builtin' ? 0 : 1,
      rank: rank(agent),
    }))
    .sort((a, b) => a.group - b.group || a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.agent)
}

/** 团队模板按列表顺序；`query` 匹配两种语言的名称、描述和 id。 */
export function pickerTeams(teams: readonly AgentTeamSummary[], query: string): AgentTeamSummary[] {
  const text = query.trim().toLowerCase()
  return availableTeams(teams).filter((team) => {
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

type PickerEntry =
  | { readonly kind: 'team'; readonly key: string; readonly team: AgentTeamSummary }
  | { readonly kind: 'agent'; readonly key: string; readonly agent: AgentSummary }

/** 当前绑定的团队；展示名称即可，不必等团队列表读回来。 */
export interface CurrentTeam {
  readonly teamId: string
  readonly name: LocalizedText
}

export function AgentPicker({
  sessionId,
  agent,
  team,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  onSelect,
  onSelectTeam,
  onManage,
  onManageTeams,
  returnFocus,
}: {
  /** 已有会话：选中后直接切换这个会话的 Agent / 团队；新对话页省略。 */
  readonly sessionId?: string | undefined
  /** 当前的 Agent；还没有运行时用默认 Agent。 */
  readonly agent: AgentDefinitionRef | undefined
  /** 当前绑定的团队模板；没有绑定时为 undefined。 */
  readonly team?: CurrentTeam | undefined
  /** 运行中（含等待审批）：不能切换，与主进程一致。 */
  readonly disabled?: boolean | undefined
  /** 由 `/agent` 打开；省略时选择器自己管理开关。 */
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** 新对话页：只把选择交给调用方，等创建会话时再应用。 */
  readonly onSelect?: ((agent: AgentSummary) => void) | undefined
  /** 新对话页选用团队；省略时切换当前会话的团队。 */
  readonly onSelectTeam?: ((team: AgentTeamSummary) => void) | undefined
  /** 菜单底部的“管理 Agents”；省略时不显示。 */
  readonly onManage?: (() => void) | undefined
  /** 菜单底部的“管理团队”；省略时不显示。 */
  readonly onManageTeams?: (() => void) | undefined
  /** 选中或 Esc 关闭时把焦点还给这里（通常是输入框）；省略时回到触发按钮。 */
  readonly returnFocus?: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const { t: tt } = useTranslation('teams')
  const agents = useSessionStore((s) => s.agents) ?? []
  const teams = useSessionStore((s) => s.teams) ?? []
  const teamsLoaded = useSessionStore((s) => s.teams !== undefined)
  const recent = useSessionStore((s) => s.recentAgents) ?? []
  const setSessionAgent = useSessionStore((s) => s.setSessionAgent)
  const setSessionTeam = useSessionStore((s) => s.setSessionTeam)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  // 绑定了团队时显示团队名称；否则按主进程的默认 Agent（内置编程助手）显示，避免“没有选中项”。
  const currentId = agent?.id ?? BUILTIN_CODER_ID
  const current = agents.find((item) => item.agentId === currentId)
  const usableTeams = useMemo(() => availableTeams(teams), [teams])
  const boundTeam =
    team === undefined ? undefined : usableTeams.find((item) => item.teamId === team.teamId)
  // 找不到定义时如实显示 id，不冒充默认 Agent；归档的仍能显示名称。
  // 模板改名后以列表里的最新名称为准；已不可用时退回绑定时的名称。
  const teamLabel =
    team === undefined ? undefined : localized((boundTeam ?? team).name, i18n.language, team.teamId)
  const label = teamLabel ?? (current ? agentName(current, i18n.language) : currentId)
  /** 当前 Agent 已归档：菜单里保留一行，标出来但不能再选。 */
  const archivedCurrent = team === undefined && current?.archived === true
  /** 绑定的团队已归档或不再可用：列表里保留一行提示，选择单个 Agent 即可离开。 */
  const unavailableTeam = team !== undefined && teamsLoaded && boundTeam === undefined
  const teamOptions = useMemo(() => pickerTeams(teams, query), [teams, query])
  const agentOptions = useMemo(() => pickerAgents(agents, recent, query), [agents, recent, query])
  const entries = useMemo<PickerEntry[]>(
    () => [
      ...teamOptions.map((item) => ({
        kind: 'team' as const,
        key: `team-${item.teamId}`,
        team: item,
      })),
      ...agentOptions.map((item) => ({ kind: 'agent' as const, key: item.agentId, agent: item })),
    ],
    [teamOptions, agentOptions],
  )
  const selected = entries[Math.min(active, entries.length - 1)]
  const hasTeams = team !== undefined || usableTeams.length > 0

  useEffect(() => {
    if (!open) return
    // 打开时高亮当前使用的 Agent / 团队：直接按 Enter 不会换成列表第一项。
    const currentIndex = entries.findIndex((entry) =>
      entry.kind === 'team'
        ? entry.team.teamId === team?.teamId
        : team === undefined && entry.agent.agentId === currentId,
    )
    setActive(currentIndex === -1 ? 0 : currentIndex)
    search.current?.focus()
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) === true) return
      setOpen(false)
      // 下次打开回到完整列表，不沿用这次的搜索词。
      setQuery('')
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  // 换了搜索词就回到第一项，避免高亮停在用户已经看不到的位置。
  useEffect(() => setActive(0), [query])

  // 键盘上下选择时让高亮项保持在可视范围内；测试环境没有 scrollIntoView 时跳过。
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, entries.length])

  // 运行开始后立刻收起：切换请求会被主进程拒绝，留着面板只会让用户困惑。
  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setQuery('')
  }, [disabled])

  // ⌘. / Ctrl+. 打开；对话框、菜单或候选列表打开时交给它们。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (disabled || !isAgentPickerKey(event) || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled])

  const close = (focusTrigger: boolean) => {
    setOpen(false)
    setQuery('')
    if (!focusTrigger) return
    if (returnFocus !== undefined) returnFocus()
    else trigger.current?.focus()
  }

  const choose = (next: AgentSummary | undefined) => {
    if (next === undefined) return
    close(true)
    // 绑定团队时当前根 Agent 就是主控：再次选它也是明确要离开团队。
    if (next.agentId === currentId && team === undefined) return
    if (onSelect !== undefined) {
      onSelect(next)
      return
    }
    if (sessionId !== undefined) {
      void setSessionAgent(sessionId, { id: next.agentId, version: next.version })
    }
  }

  const chooseTeam = (next: AgentTeamSummary | undefined) => {
    if (next === undefined) return
    close(true)
    if (onSelectTeam !== undefined) {
      onSelectTeam(next)
      return
    }
    if (sessionId !== undefined) void setSessionTeam(sessionId, next.teamId)
  }

  const chooseEntry = (entry: PickerEntry | undefined) => {
    if (entry === undefined) return
    if (entry.kind === 'team') chooseTeam(entry.team)
    else choose(entry.agent)
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (entries.length === 0) return
      setActive((index) => {
        const base = Math.min(index, entries.length - 1)
        const step = event.key === 'ArrowDown' ? 1 : -1
        return (base + step + entries.length) % entries.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      chooseEntry(selected)
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          teamLabel === undefined
            ? t('composer.agent.label', { name: label })
            : t('composer.team.label', { name: label })
        }
        title={disabled ? t('composer.agent.busy') : label}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="flex h-7 max-w-[190px] items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-45 [&_svg]:size-3.5"
      >
        {team !== undefined ? (
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent">
            <UsersRound aria-hidden className="size-3" />
          </span>
        ) : (
          <AgentAvatar
            icon={current?.icon}
            color={current?.color}
            size={18}
            className="rounded-[6px]"
          />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown className="shrink-0 text-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-card border border-hair bg-raise p-1.5 text-ui shadow-2">
          <label className="mb-1 flex h-8 items-center gap-2 rounded-item bg-sunk px-2">
            <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={hasTeams ? t('composer.picker.search') : t('composer.agent.search')}
              role="combobox"
              aria-label={hasTeams ? t('composer.picker.search') : t('composer.agent.search')}
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listId}
              aria-activedescendant={
                selected === undefined ? undefined : `${listId}-${selected.key}`
              }
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
            <Kbd aria-hidden>{agentPickerShortcut()}</Kbd>
          </label>
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={hasTeams ? t('composer.picker.title') : t('composer.agent.title')}
            className="max-h-64 overflow-y-auto"
          >
            {archivedCurrent && current !== undefined && (
              <li
                role="option"
                aria-selected={true}
                aria-disabled={true}
                className="flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5 opacity-60"
              >
                <AgentAvatar icon={current.icon} color={current.color} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{label}</span>
                  <span className="block text-[11px] text-faint">
                    {t('composer.agent.archived')}
                  </span>
                </span>
                <Check aria-hidden className="size-3.5 shrink-0 text-fg" />
              </li>
            )}
            {unavailableTeam && (
              <li
                role="option"
                aria-selected={true}
                aria-disabled={true}
                className="flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5 opacity-60"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent">
                  <UsersRound aria-hidden className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{label}</span>
                  <span className="block text-[11px] text-faint">
                    {t('composer.team.unavailable')}
                  </span>
                </span>
                <Check aria-hidden className="size-3.5 shrink-0 text-fg" />
              </li>
            )}
            {teamOptions.length > 0 && (
              <li
                role="presentation"
                className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-faint"
              >
                {t('composer.team.section')}
              </li>
            )}
            {entries.map((entry, index) => {
              const isActive = selected?.key === entry.key
              const activeRow = isActive && 'bg-hover'
              if (entry.kind === 'team') {
                const option = entry.team
                const isCurrent = option.teamId === team?.teamId
                const coordinator = agents.find((item) => item.agentId === option.coordinator)
                return (
                  <li
                    key={entry.key}
                    id={`${listId}-${entry.key}`}
                    role="option"
                    data-kind="team"
                    aria-selected={isCurrent}
                    data-active={isActive}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      chooseTeam(option)
                    }}
                    className={cn(
                      'flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5',
                      activeRow,
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent">
                      <UsersRound aria-hidden className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">
                        {localized(option.name, i18n.language, option.teamId)}
                      </span>
                      <span className="block truncate text-[11px] text-faint">
                        {t('composer.team.meta', {
                          pattern: tt(`pattern.${option.pattern}`),
                          count: option.memberCount,
                          coordinator: coordinator
                            ? agentName(coordinator, i18n.language)
                            : option.coordinator,
                        })}
                      </span>
                    </span>
                    {isCurrent && <Check aria-hidden className="size-3.5 shrink-0 text-fg" />}
                  </li>
                )
              }
              const option = entry.agent
              const isCurrent = team === undefined && option.agentId === currentId
              const description = localized(option.description, i18n.language, '')
              return (
                <Fragment key={entry.key}>
                  {index === teamOptions.length && teamOptions.length > 0 && (
                    <li
                      role="presentation"
                      className="mt-1 border-t border-hair px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-faint"
                    >
                      {t('composer.agent.section')}
                    </li>
                  )}
                  <li
                    id={`${listId}-${entry.key}`}
                    role="option"
                    data-kind="agent"
                    aria-selected={isCurrent}
                    data-active={isActive}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      choose(option)
                    }}
                    className={cn(
                      'flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5',
                      activeRow,
                    )}
                  >
                    <AgentAvatar icon={option.icon} color={option.color} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">
                        {agentName(option, i18n.language)}
                      </span>
                      <span className="block truncate text-[11px] text-faint">
                        {description === ''
                          ? t('composer.agent.version', { version: option.version })
                          : description}
                      </span>
                    </span>
                    {isCurrent && <Check aria-hidden className="size-3.5 shrink-0 text-fg" />}
                  </li>
                </Fragment>
              )
            })}
          </ul>
          {entries.length === 0 && (
            <p className="px-2 py-2 text-note text-muted">
              {hasTeams ? t('composer.picker.empty') : t('composer.agent.empty')}
            </p>
          )}
          {(onManage !== undefined || onManageTeams !== undefined) && (
            <div className="mt-1 flex gap-1 border-t border-hair pt-1">
              {onManage !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    close(false)
                    onManage()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    close(true)
                  }}
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg2 outline-none hover:bg-hover focus-visible:bg-hover"
                >
                  <Settings2 aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="truncate">{t('composer.agent.manage')}</span>
                </button>
              )}
              {onManageTeams !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    close(false)
                    onManageTeams()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    close(true)
                  }}
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg2 outline-none hover:bg-hover focus-visible:bg-hover"
                >
                  <UsersRound aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="truncate">{t('composer.team.manage')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
