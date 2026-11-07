/**
 * 输入框里的 Agent 选择器（M3-12，管理界面 §7.1）：最近使用的在前、可搜索、Ctrl+. 打开。
 * 只列出已发布且未归档的 Agent；草稿只能在 Agents 页里试运行（M3 暂未提供试运行）。
 */
import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDefinitionRef, AgentSummary } from '@cairn/protocol'
import { agentPickerShortcut, isAgentPickerKey } from '../layout/shortcuts.js'
import { useSessionStore } from '../store-context.js'
import { agentName } from './AgentsPage.js'
import { AgentAvatar } from './AgentAvatar.js'
import { Kbd, cn } from '../ui/index.js'

export function pickerAgents(
  agents: readonly AgentSummary[],
  recent: readonly string[],
  query: string,
): AgentSummary[] {
  const text = query.trim().toLowerCase()
  const available = agents.filter(
    (agent) => !agent.archived && agent.status === 'published' && agent.version > 0,
  )
  const rank = (agent: AgentSummary) => {
    const index = recent.indexOf(agent.agentId)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return available
    .filter((agent) => {
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
    .sort((a, b) => rank(a) - rank(b))
}

export function AgentPicker({
  sessionId,
  agent,
  disabled,
}: {
  readonly sessionId: string
  readonly agent: AgentDefinitionRef | undefined
  readonly disabled: boolean
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useSessionStore((s) => s.agents) ?? []
  const recent = useSessionStore((s) => s.recentAgents) ?? []
  const setSessionAgent = useSessionStore((s) => s.setSessionAgent)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const current = agents.find((item) => item.agentId === agent?.id)
  const label = current ? agentName(current, i18n.language) : t('composer.agent.default')
  const options = pickerAgents(agents, recent, query)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (disabled) return
      if (!isAgentPickerKey(event)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled])

  const select = (next: AgentSummary) => {
    setOpen(false)
    setQuery('')
    if (next.agentId === agent?.id) return
    void setSessionAgent(sessionId, { id: next.agentId, version: next.version })
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('composer.agent.label', { name: label })}
        title={disabled ? t('composer.agent.busy') : t('composer.agent.title')}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 max-w-[190px] items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover disabled:opacity-60 [&_svg]:size-3.5"
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
        <div
          role="listbox"
          aria-label={t('composer.agent.title')}
          className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-card bg-raise p-1.5 text-ui shadow-2"
        >
          <label className="mb-1 flex h-8 items-center gap-2 rounded-item bg-sunk px-2">
            <Search className="size-3.5 text-faint" />
            <span className="sr-only">{t('composer.agent.search')}</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('composer.agent.search')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
            <Kbd aria-hidden>{agentPickerShortcut()}</Kbd>
          </label>
          {options.length === 0 ? (
            <p className="px-2 py-2 text-note text-muted">{t('composer.agent.empty')}</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {options.map((option) => {
                const selected = option.agentId === agent?.id
                return (
                  <li key={option.agentId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => select(option)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-ui text-fg2 hover:bg-hover',
                        selected && 'text-fg',
                      )}
                    >
                      <AgentAvatar icon={option.icon} color={option.color} size={20} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">
                          {agentName(option, i18n.language)}
                        </span>
                        <span className="tabular block text-[11px] text-faint">
                          {t('composer.agent.version', { version: option.version })}
                        </span>
                      </span>
                      {selected && <Check className="size-3.5 text-fg" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
