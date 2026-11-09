/**
 * 委派卡片（M4-05，多 Agent 协作 §13.1）：父运行对话里的并行子任务。
 *
 * 卡片显示 Agent、任务、状态与用量；展开时按需读取子运行的只读过程树。子运行的审批也显示在这里，
 * 不与父运行的审批重复。写入类子运行完成后提供改动入口。
 */
import { ChevronRight, FileDiff, GitBranch } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationView, SessionView } from '@cairn/core'
import type { FileChangeSummary, PendingApproval } from '@cairn/protocol'
import { agentName } from './agents/model.js'
import { ApprovalCard } from './ApprovalCard.js'
import { formatCompactTokens as compactTokens } from './format.js'
import { RunTimeline } from './Inspector.js'
import { inspectionKey } from './session-store.js'
import { useSessionStore } from './store-context.js'
import { cn } from './ui/index.js'

const EMPTY_APPROVALS: readonly PendingApproval[] = []
const EMPTY_CHANGES: readonly FileChangeSummary[] = []

export function DelegationCard({
  sessionId,
  view,
  delegation,
  onOpenChanges,
}: {
  readonly sessionId: string
  readonly view: SessionView
  readonly delegation: DelegationView
  readonly onOpenChanges: ((changeSetId?: string) => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const [expanded, setExpanded] = useState(false)
  const inspectRun = useSessionStore((state) => state.inspectRun)
  const entry = useSessionStore(
    (state) => state.inspections[inspectionKey(sessionId, delegation.childRunId)],
  )
  const approvals = useSessionStore((state) => state.approvals[sessionId] ?? EMPTY_APPROVALS)
  const changes = useSessionStore((state) => state.changes[sessionId] ?? EMPTY_CHANGES)
  const changeSetId = delegation.completed?.changeSetId
  const changeSetSummary = useSessionStore((state) =>
    changeSetId === undefined
      ? undefined
      : state.changeSets?.[sessionId]?.find((item) => item.changeSetId === changeSetId),
  )
  const agents = useSessionStore((state) => state.agents) ?? []
  const agent = agents.find((item) => item.agentId === delegation.agent.id)
  const name = agent
    ? agentName(agent, i18n.language)
    : delegation.agent.id === 'builtin.coder'
      ? t('composer.agent.default')
      : delegation.agent.id
  const childApprovals = approvals.filter((approval) => approval.runId === delegation.childRunId)
  const firstApproval = approvals[0]?.approvalId
  const childRun = view.runs[delegation.childRunId]
  const status = delegation.completed?.status ?? 'running'
  const usage = delegation.completed?.usage ?? childRun?.usage
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0
  const turns = new Set(
    (entry?.result?.tree.runs.find((run) => run.runId === delegation.childRunId)?.turns ?? [])
      .map((turn) => turn.turnId)
      .concat(childRun?.turn ? [childRun.turn.turnId] : []),
  )
  const changed = changes.filter(
    (change) =>
      change.status !== 'reverted' && change.turnId !== undefined && turns.has(change.turnId),
  )
  const added = changeSetSummary?.added ?? changed.reduce((sum, change) => sum + change.added, 0)
  const removed =
    changeSetSummary?.removed ?? changed.reduce((sum, change) => sum + change.removed, 0)
  const changesAvailable = changeSetId !== undefined || changed.length > 0
  const hasCounts = changeSetSummary !== undefined || changed.length > 0

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next) void inspectRun(sessionId, delegation.childRunId)
  }

  return (
    <article
      aria-label={t('delegation.card', { task: delegation.task })}
      className="rounded-card bg-raise p-3 shadow-1"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex w-full items-start gap-2 rounded-item text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-3.5 shrink-0 text-faint', expanded && 'rotate-90')}
        />
        <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg2">{name}</span>
            <span className="text-note text-muted">
              {t('inspector.versionShort', { version: delegation.agent.version })}
            </span>
            <span
              className={cn(
                'rounded-[5px] px-1.5 py-0.5 text-[11px]',
                status === 'failed' || status === 'aborted'
                  ? 'bg-danger-soft text-danger'
                  : status === 'completed'
                    ? 'bg-ok-soft text-ok'
                    : status === 'needs_input' || status === 'limit_reached'
                      ? 'bg-warn-soft text-warn'
                      : 'bg-sunk2 text-muted',
              )}
            >
              {t(`delegation.status.${status}`)}
            </span>
            {tokens > 0 && (
              <span className="tabular text-note text-muted">
                {t('delegation.tokens', { count: compactTokens(tokens) })}
              </span>
            )}
          </span>
          <span className="mt-1 block line-clamp-2 text-ui text-fg2">{delegation.task}</span>
        </span>
      </button>
      {delegation.completed?.summary && (
        <p className="mt-2 rounded-item bg-sunk px-2.5 py-2 text-note whitespace-pre-wrap text-fg2">
          {delegation.completed.summary}
        </p>
      )}
      {delegation.completed?.issues && delegation.completed.issues.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-note text-warn">
          {delegation.completed.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {changesAvailable && (
        <button
          type="button"
          onClick={() => onOpenChanges?.(changeSetId)}
          disabled={onOpenChanges === undefined}
          className="mt-2 flex h-7 items-center gap-1.5 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
        >
          <FileDiff aria-hidden className="size-3.5" />
          {hasCounts ? t('delegation.changes', { added, removed }) : t('delegation.changesPlain')}
        </button>
      )}
      {expanded && (
        <div className="mt-2 border-t-[0.5px] border-hair pt-2">
          {entry?.error ? (
            <p role="alert" className="text-note text-danger">
              {t('delegation.loadFailed')}
            </p>
          ) : entry === undefined || entry.loading ? (
            <p role="status" className="text-note text-muted">
              {t('inspector.loading')}
            </p>
          ) : entry.result ? (
            <RunTimeline tree={entry.result.tree} />
          ) : (
            <p className="text-note text-faint">{t('inspector.empty')}</p>
          )}
        </div>
      )}
      {childApprovals.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {childApprovals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              active={firstApproval === approval.approvalId}
            />
          ))}
        </div>
      )}
    </article>
  )
}
