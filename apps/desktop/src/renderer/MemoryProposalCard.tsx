/**
 * 记忆提议卡片（M7-03，ADR-0019）：Agent 用 `remember` 提议一条记忆后，浮在输入框上方等用户确认。
 *
 * - 只显示还没处理的提议；确认后条目生效并注入之后的系统提示词，忽略则删除。
 * - 卡片不阻塞这一轮：用户可以继续输入，确认或忽略由事件投影移除卡片。
 * - 用户继续发下一条消息后，收成单行细条，不再占住输入框上方的大块空间；点开仍可确认或忽略。
 * - 范围标签说明这条记在哪儿（本会话 / 本项目 / 所有项目），正文原样显示。
 */
import { Brain, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryProposalView, MessageView } from '@cairn/core'
import { useSessionStore } from './store-context.js'
import { Button, cn, FloatCard, floatChipClass } from './ui/index.js'

const NONE: readonly MemoryProposalView[] = []
const NO_MESSAGES: readonly MessageView[] = []

/** 用户在提议之后又发了消息：卡片应收成细条，别一直挡输入框。 */
export function shouldTuckMemoryProposal(
  proposal: MemoryProposalView,
  messages: readonly MessageView[],
): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      (message.origin === undefined || message.origin === 'user') &&
      message.ts > proposal.createdAt,
  )
}

function MemoryProposalCard({
  proposal,
  tucked,
}: {
  readonly proposal: MemoryProposalView
  readonly tucked: boolean
}) {
  const { t } = useTranslation('session')
  const resolveMemory = useSessionStore((s) => s.resolveMemory)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const compact = tucked && !expanded

  const respond = async (action: 'accept' | 'reject') => {
    if (busy) return
    setBusy(true)
    await resolveMemory(proposal.memoryId, action)
    setBusy(false)
  }

  if (compact) {
    return (
      <FloatCard
        as="article"
        variant="bar"
        aria-label={t('memory.title')}
        className="flex h-9 items-center gap-2 px-3"
      >
        <Brain aria-hidden className="size-3.5 shrink-0 text-accent" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-label={t('memory.expand')}
        >
          <span className="shrink-0 text-ui leading-5 font-medium text-fg">{t('memory.title')}</span>
          <span className={floatChipClass}>{t(`memory.scope.${proposal.scope}`)}</span>
          <span className="min-w-0 flex-1 truncate text-note text-muted" title={proposal.content}>
            {proposal.content}
          </span>
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint" />
        </button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('reject')}>
          {t('memory.reject')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond('accept')}>
          {t('memory.accept')}
        </Button>
      </FloatCard>
    )
  }

  return (
    <FloatCard as="article" aria-label={t('memory.title')}>
      <header className="flex items-center gap-2">
        <Brain aria-hidden className="size-3.5 shrink-0 text-accent" />
        <h3 className="min-w-0 flex-1 truncate text-ui leading-5 font-medium text-fg">
          {t('memory.title')}
        </h3>
        <span className={floatChipClass}>{t(`memory.scope.${proposal.scope}`)}</span>
        {tucked && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            {t('memory.collapse')}
          </Button>
        )}
      </header>
      <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-ui text-fg">
        {proposal.content}
      </p>
      <p className="mt-1 text-note text-muted">{t('memory.hint')}</p>
      <div className={cn('mt-1.5 flex justify-end gap-1.5')}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond('reject')}>
          {t('memory.reject')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond('accept')}>
          {t('memory.accept')}
        </Button>
      </div>
    </FloatCard>
  )
}

/** 当前会话里所有待确认的记忆提议；没有时什么都不渲染。 */
export function MemoryProposalList() {
  const { t } = useTranslation('session')
  const proposals = useSessionStore((s) =>
    s.activeSessionId === undefined ? NONE : (s.views[s.activeSessionId]?.memoryProposals ?? NONE),
  )
  const messages = useSessionStore((s) =>
    s.activeSessionId === undefined
      ? NO_MESSAGES
      : (s.views[s.activeSessionId]?.messages ?? NO_MESSAGES),
  )
  if (proposals.length === 0) return null
  return (
    <section aria-label={t('memory.region')} className="flex flex-col gap-2">
      {proposals.map((proposal) => (
        <MemoryProposalCard
          key={proposal.memoryId}
          proposal={proposal}
          tucked={shouldTuckMemoryProposal(proposal, messages)}
        />
      ))}
    </section>
  )
}
