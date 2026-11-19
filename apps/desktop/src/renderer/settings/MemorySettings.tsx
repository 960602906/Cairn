/**
 * 设置页“记忆”（M7-04，ADR-0019）：列出全部记忆，按范围分组，支持搜索、编辑与删除。
 *
 * - 数据来自 `memory.list`，改动后重新读取；Agent 读取记忆走内部查询，与这里无关。
 * - 已生效的条目会注入之后的对话；待确认的条目由会话里的提议卡片处理，这里可以直接删除。
 * - 空状态与“没有匹配”分开显示，避免搜索无结果时误以为还没有记忆。
 */
import { Brain, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryScope } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { MemoryEntryCard } from '../MemoryEntryCard.js'
import { Button, cn, Spinner } from '../ui/index.js'
import { inputClass } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'
import { useSettingsData } from './settings-data-cache.js'

const SCOPE_ORDER: readonly MemoryScope[] = ['session', 'project', 'global']

export function MemorySettings() {
  const { t } = useTranslation('settings')
  const { t: ts } = useTranslation('session')
  const listMemories = useSessionStore((s) => s.listMemories)
  const { value: entries, failed, reload: load } = useSettingsData('settings:memory', listMemories)
  const [query, setQuery] = useState('')

  const normalized = query.trim().toLocaleLowerCase()
  const visible =
    normalized === ''
      ? (entries ?? [])
      : (entries ?? []).filter((entry) =>
          `${entry.content} ${entry.sourceAgentId ?? ''}`.toLocaleLowerCase().includes(normalized),
        )

  return (
    <>
      <SettingsHeader
        icon={<Brain />}
        title={t('section.memory.title')}
        description={t('section.memory.description')}
      />
      <p className="text-note text-muted">{t('section.memory.hint')}</p>
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{ts('memory.manage.search')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={ts('memory.manage.search')}
            aria-label={ts('memory.manage.search')}
            className={cn(inputClass, 'pl-8')}
          />
        </label>
      </div>

      {failed && (
        <div role="alert" className="flex items-center gap-3 rounded-card bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 text-ui text-fg">{ts('memory.manage.loadFailed')}</p>
          <Button size="sm" onClick={() => void load()}>
            {ts('memory.manage.retry')}
          </Button>
        </div>
      )}

      {entries === undefined && !failed && (
        <div className="flex items-center justify-center py-10 text-muted">
          <Spinner className="size-4" />
        </div>
      )}

      {entries !== undefined && entries.length === 0 && (
        <div className="rounded-card border border-dashed border-hair2 px-6 py-10 text-center">
          <Brain aria-hidden className="mx-auto size-6 text-faint" />
          <p className="mt-2 text-ui text-fg2">{ts('memory.manage.empty')}</p>
          <p className="mt-1 text-note text-muted">{ts('memory.manage.emptyHint')}</p>
        </div>
      )}

      {entries !== undefined && entries.length > 0 && visible.length === 0 && (
        <p className="px-1 text-ui text-muted">{ts('memory.manage.noResults')}</p>
      )}

      {SCOPE_ORDER.map((scope) => {
        const group = visible.filter((entry) => entry.scope === scope)
        if (group.length === 0) return null
        return (
          <section
            key={scope}
            aria-label={ts(`memory.scope.${scope}`)}
            className="flex flex-col gap-2"
          >
            <h3 className="flex items-center gap-2 text-ui font-medium text-fg2">
              {ts(`memory.scope.${scope}`)}
              <span className="text-note font-normal text-muted">{group.length}</span>
            </h3>
            {group.map((entry) => (
              <MemoryEntryCard
                key={entry.memoryId}
                entry={entry}
                editable
                onChanged={() => void load()}
              />
            ))}
          </section>
        )
      })}
    </>
  )
}
