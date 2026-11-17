/**
 * 记忆提议卡片（M7-03，ADR-0019）：Agent 用 `remember` 提议一条记忆后，浮在输入框上方等用户确认。
 *
 * - 只显示还没处理的提议；确认后条目生效并注入之后的系统提示词，忽略则删除。
 * - 卡片不阻塞这一轮：用户可以继续输入，确认或忽略由事件投影移除卡片。
 * - 范围标签说明这条记在哪儿（本会话 / 本项目 / 所有项目），正文原样显示。
 */
import { Brain } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryProposalView } from '@cairn/core'
import { useSessionStore } from './store-context.js'
import { Button } from './ui/index.js'

const NONE: readonly MemoryProposalView[] = []

function MemoryProposalCard({ proposal }: { readonly proposal: MemoryProposalView }) {
  const { t } = useTranslation('session')
  const resolveMemory = useSessionStore((s) => s.resolveMemory)
  const [busy, setBusy] = useState(false)

  const respond = async (action: 'accept' | 'reject') => {
    if (busy) return
    setBusy(true)
    await resolveMemory(proposal.memoryId, action)
    setBusy(false)
  }

  return (
    <article aria-label={t('memory.title')} className="rounded-approval bg-raise p-4 shadow-2">
      <header className="flex items-center gap-2">
        <Brain aria-hidden className="size-4 shrink-0 text-accent" />
        <h3 className="min-w-0 flex-1 truncate text-heading text-fg">{t('memory.title')}</h3>
        <span className="shrink-0 rounded-item bg-sunk px-2 py-0.5 text-note text-fg2">
          {t(`memory.scope.${proposal.scope}`)}
        </span>
      </header>
      <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-ui text-fg">
        {proposal.content}
      </p>
      <p className="mt-1.5 text-note text-muted">{t('memory.hint')}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('reject')}>
          {t('memory.reject')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond('accept')}>
          {t('memory.accept')}
        </Button>
      </div>
    </article>
  )
}

/** 当前会话里所有待确认的记忆提议；没有时什么都不渲染。 */
export function MemoryProposalList() {
  const { t } = useTranslation('session')
  const proposals = useSessionStore((s) =>
    s.activeSessionId === undefined ? NONE : (s.views[s.activeSessionId]?.memoryProposals ?? NONE),
  )
  if (proposals.length === 0) return null
  return (
    <section aria-label={t('memory.region')} className="flex flex-col gap-2.5">
      {proposals.map((proposal) => (
        <MemoryProposalCard key={proposal.memoryId} proposal={proposal} />
      ))}
    </section>
  )
}
