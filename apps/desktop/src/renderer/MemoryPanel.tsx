/**
 * 会话信息面板里的“记忆”标签（M7-04）：展示当前会话、当前项目与全局的记忆，支持就地删除。
 *
 * 数据来自 `memory.list`，删除后重新读取。Agent 下一轮才读取记忆，所以改动在之后的对话里生效；
 * 会话范围的删除会记进本会话事件，聊天里对应的提议卡片一起消失。
 */
import { Brain } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { MemoryEntry, MemoryScope } from '@cairn/protocol'
import { MemoryEntryCard } from './MemoryEntryCard.js'
import { useSessionStore } from './store-context.js'
import { Button, PanelEmpty } from './ui/index.js'

const SCOPE_ORDER: readonly MemoryScope[] = ['session', 'project', 'global']

export function MemoryPanel({
  sessionId,
  view,
}: {
  readonly sessionId: string
  readonly view: SessionView | undefined
}) {
  const { t } = useTranslation('session')
  const listMemories = useSessionStore((s) => s.listMemories)
  const projectId = view?.info?.projectId
  const [entries, setEntries] = useState<readonly MemoryEntry[]>()
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    const result = await listMemories()
    if (result === undefined) {
      setFailed(true)
      return
    }
    setFailed(false)
    setEntries(
      result.filter(
        (entry) =>
          entry.scope === 'global' ||
          (entry.scope === 'session' && entry.sessionId === sessionId) ||
          (entry.scope === 'project' && entry.projectId === projectId),
      ),
    )
  }, [listMemories, projectId, sessionId])

  useEffect(() => {
    setEntries(undefined)
    setFailed(false)
    void load()
  }, [load])

  if (failed) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-4 py-6">
        <p className="text-ui text-fg">{t('memory.manage.loadFailed')}</p>
        <Button size="sm" onClick={() => void load()}>
          {t('memory.manage.retry')}
        </Button>
      </div>
    )
  }

  if (entries !== undefined && entries.length === 0) {
    return (
      <PanelEmpty icon={<Brain />} hint={t('memory.manage.emptyHint')}>
        {t('memory.manage.empty')}
      </PanelEmpty>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {SCOPE_ORDER.map((scope) => {
        const group = (entries ?? []).filter((entry) => entry.scope === scope)
        if (group.length === 0) return null
        return (
          <section
            key={scope}
            aria-label={t(`memory.scope.${scope}`)}
            className="flex flex-col gap-2"
          >
            <h3 className="flex items-center gap-2 text-ui font-medium text-fg2">
              {t(`memory.scope.${scope}`)}
              <span className="text-note font-normal text-muted">{group.length}</span>
            </h3>
            {group.map((entry) => (
              <MemoryEntryCard
                key={entry.memoryId}
                entry={entry}
                sessionId={sessionId}
                onChanged={() => void load()}
              />
            ))}
          </section>
        )
      })}
      {entries === undefined && (
        <p role="status" className="px-1 text-ui text-muted">
          {t('memory.manage.loading')}
        </p>
      )}
    </div>
  )
}
