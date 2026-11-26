/**
 * 输入框里的 Agent 选择器（M6-08，管理界面 §7.1/§7.2）。
 *
 * 只列出已发布且未归档的 Agent：草稿在没有发布前只能在 Agents 页里试运行。内置的排在前面，
 * 自定义的随后；同一组里最近选过的靠前，其余保持 `agent.list` 的顺序。名称、描述（两种语言）
 * 与 id 都可以搜。⌘. / Ctrl+. 打开；运行中不能切换——与主进程 `session.setAgent` 的 Busy 校验一致。
 * 会话页的切换会在同一会话里开始一个新运行，对话中出现“已切换到 …”的分隔提示（由事件驱动）；
 * 新对话页通过 `onSelect` 只记录选择，等创建会话时再应用。
 */
import { Check, ChevronDown, Search, Settings2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_CODER_ID } from '@cairn/core'
import type { AgentDefinitionRef, AgentSummary } from '@cairn/protocol'
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

export function AgentPicker({
  sessionId,
  agent,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  onSelect,
  onManage,
}: {
  /** 已有会话：选中后直接切换这个会话的 Agent；新对话页省略。 */
  readonly sessionId?: string | undefined
  /** 当前的 Agent；还没有运行时用默认 Agent。 */
  readonly agent: AgentDefinitionRef | undefined
  /** 运行中（含等待审批）：不能切换，与主进程一致。 */
  readonly disabled?: boolean | undefined
  /** 由 `/agent` 打开；省略时选择器自己管理开关。 */
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** 新对话页：只把选择交给调用方，等创建会话时再应用。 */
  readonly onSelect?: ((agent: AgentSummary) => void) | undefined
  /** 菜单底部的“管理 Agents”；省略时不显示。 */
  readonly onManage?: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useSessionStore((s) => s.agents) ?? []
  const recent = useSessionStore((s) => s.recentAgents) ?? []
  const setSessionAgent = useSessionStore((s) => s.setSessionAgent)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()

  // 还没有运行时按主进程的默认 Agent（内置编程助手）显示，避免“没有选中项”。
  const currentId = agent?.id ?? BUILTIN_CODER_ID
  const current = agents.find((item) => item.agentId === currentId)
  // 找不到定义时如实显示 id，不冒充默认 Agent；归档的仍能显示名称。
  const label = current ? agentName(current, i18n.language) : currentId
  /** 当前 Agent 已归档：菜单里保留一行，标出来但不能再选。 */
  const archivedCurrent = current?.archived === true
  const options = useMemo(() => pickerAgents(agents, recent, query), [agents, recent, query])
  const selected = options[Math.min(active, options.length - 1)]

  useEffect(() => {
    if (!open) return
    setActive(0)
    search.current?.focus()
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  // 换了搜索词就回到第一项，避免高亮停在用户已经看不到的位置。
  useEffect(() => setActive(0), [query])

  // 运行开始后立刻收起：切换请求会被主进程拒绝，留着面板只会让用户困惑。
  useEffect(() => {
    if (disabled) setOpen(false)
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
    if (focusTrigger) trigger.current?.focus()
  }

  const choose = (next: AgentSummary | undefined) => {
    if (next === undefined) return
    close(true)
    if (next.agentId === currentId) return
    if (onSelect !== undefined) {
      onSelect(next)
      return
    }
    if (sessionId !== undefined) {
      void setSessionAgent(sessionId, { id: next.agentId, version: next.version })
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (options.length === 0) return
      setActive((index) => {
        const base = Math.min(index, options.length - 1)
        const step = event.key === 'ArrowDown' ? 1 : -1
        return (base + step + options.length) % options.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(selected)
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
        aria-label={t('composer.agent.label', { name: label })}
        title={disabled ? t('composer.agent.busy') : label}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="flex h-7 max-w-[190px] items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-45 [&_svg]:size-3.5"
      >
        <AgentAvatar
          icon={current?.icon}
          color={current?.color}
          size={18}
          className="rounded-[6px]"
        />
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
              placeholder={t('composer.agent.search')}
              role="combobox"
              aria-label={t('composer.agent.search')}
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listId}
              aria-activedescendant={
                selected === undefined ? undefined : `${listId}-${selected.agentId}`
              }
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
            <Kbd aria-hidden>{agentPickerShortcut()}</Kbd>
          </label>
          <ul
            id={listId}
            role="listbox"
            aria-label={t('composer.agent.title')}
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
            {options.map((option, index) => {
              const isCurrent = option.agentId === currentId
              const isActive = selected?.agentId === option.agentId
              const description = localized(option.description, i18n.language, '')
              return (
                <li
                  key={option.agentId}
                  id={`${listId}-${option.agentId}`}
                  role="option"
                  aria-selected={isCurrent}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(option)
                  }}
                  className={cn(
                    'flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5',
                    isActive && 'bg-hover',
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
              )
            })}
          </ul>
          {options.length === 0 && (
            <p className="px-2 py-2 text-note text-muted">{t('composer.agent.empty')}</p>
          )}
          {onManage !== undefined && (
            <div className="mt-1 border-t border-hair pt-1">
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
                className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg2 outline-none hover:bg-hover focus-visible:bg-hover"
              >
                <Settings2 aria-hidden className="size-4 shrink-0 text-muted" />
                {t('composer.agent.manage')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
