/**
 * 活动中心（M4-07，管理界面 §9；ADR-0032）。
 *
 * 数据只来自主进程的 `activity.list` 快照，并随 `activity.changed` 重新读取；界面不维护第二份
 * 审批或运行状态。待审批可以就地决定，需要看 diff 的审批通过“查看”回到对应会话。
 */
import { CheckCircle2, Clock3, FileDiff, Play, RefreshCw, ShieldAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ActivityApproval,
  ActivityCompleted,
  ActivityRunning,
  AgentDefinitionRef,
  AgentSummary,
} from '@cairn/protocol'
import { translateError, type TFunction } from '@cairn/i18n'
import { agentName } from './agents/AgentsPage.js'
import { useSessionStore } from './store-context.js'
import { cn, IconButton } from './ui/index.js'

function displayAgent(
  agent: AgentDefinitionRef,
  agents: readonly AgentSummary[],
  t: TFunction,
  language: string,
): string {
  const summary = agents.find((item) => item.agentId === agent.id)
  if (summary) return agentName(summary, language)
  return agent.id === 'builtin.coder' ? t('composer.agent.default') : agent.id
}

function timeText(timestamp: number, language: string): string {
  return new Date(timestamp).toLocaleString(language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Section({
  title,
  count,
  label,
  children,
}: {
  readonly title: string
  readonly count: number
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-note font-medium text-fg2">
        {title}
        <span className="tabular text-muted">{count}</span>
      </h3>
      {children}
    </section>
  )
}

function ApprovalRow({
  approval,
  agents,
  busy,
  onDecide,
  onOpen,
}: {
  readonly approval: ActivityApproval
  readonly agents: readonly AgentSummary[]
  readonly busy: boolean
  readonly onDecide: (
    decision: 'allow_once' | 'allow_session' | 'deny',
    approval: ActivityApproval,
  ) => void
  readonly onOpen: (sessionId: string) => void
}) {
  const { t, i18n } = useTranslation('session')
  return (
    <article
      aria-label={t('activity.approvalItem', {
        session: approval.sessionTitle,
        tool: approval.toolName,
      })}
      className="flex flex-col gap-2 rounded-card bg-raise p-3 shadow-1"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="min-w-0 truncate text-ui font-medium text-fg">
              {approval.sessionTitle}
            </h4>
            <span className="text-note text-muted">
              {displayAgent(approval.agent, agents, t, i18n.language)}
            </span>
            <span className="text-note text-muted">·</span>
            <span className="font-mono text-note text-muted">{approval.toolName}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-note text-fg2">{approval.summary}</p>
          <time
            dateTime={new Date(approval.requestedAt).toISOString()}
            className="mt-1 block text-note text-faint"
          >
            {t('activity.requestedAt', {
              time: timeText(approval.requestedAt, i18n.language),
            })}
          </time>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(approval.sessionId)}
          className="flex h-7 items-center rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('activity.view')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide('allow_once', approval)}
          className="flex h-7 items-center rounded-item bg-ink px-2 text-note font-medium text-ink-fg outline-none hover:opacity-85 focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-45"
        >
          {t('activity.allowOnce')}
        </button>
        {approval.kind !== 'no_checkpoint' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide('allow_session', approval)}
            className="flex h-7 items-center rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-45"
          >
            {t('activity.allowSession')}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide('deny', approval)}
          className="flex h-7 items-center rounded-item px-2 text-note text-danger outline-none hover:bg-danger-soft focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-45"
        >
          {t('activity.deny')}
        </button>
      </div>
    </article>
  )
}

function RunningRow({
  running,
  agents,
  onOpen,
}: {
  readonly running: ActivityRunning
  readonly agents: readonly AgentSummary[]
  readonly onOpen: (sessionId: string) => void
}) {
  const { t, i18n } = useTranslation('session')
  return (
    <article
      aria-label={t('activity.runningItem', { session: running.sessionTitle })}
      className="flex items-start gap-2 rounded-card bg-raise p-3 shadow-1"
    >
      <Play aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="min-w-0 truncate text-ui font-medium text-fg">{running.sessionTitle}</h4>
          <span className="text-note text-muted">
            {displayAgent(running.agent, agents, t, i18n.language)}
          </span>
          <span className="rounded-[5px] bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
            {t(`inspector.state.${running.state}`)}
          </span>
        </div>
        {running.summary !== '' && (
          <p className="mt-1 line-clamp-2 text-note text-fg2">{running.summary}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-note text-faint">
          {running.step !== undefined && <span>{running.step}</span>}
          <time dateTime={new Date(running.updatedAt).toISOString()}>
            {t('activity.updatedAt', { time: timeText(running.updatedAt, i18n.language) })}
          </time>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpen(running.sessionId)}
        className="flex h-7 shrink-0 items-center rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
      >
        {t('activity.view')}
      </button>
    </article>
  )
}

function CompletedRow({
  completed,
  agents,
  onOpen,
}: {
  readonly completed: ActivityCompleted
  readonly agents: readonly AgentSummary[]
  readonly onOpen: (sessionId: string, changeSetId?: string) => void
}) {
  const { t, i18n } = useTranslation('session')
  return (
    <article
      aria-label={t('activity.completedItem', { session: completed.sessionTitle })}
      className="flex items-start gap-2 rounded-card bg-raise p-3 shadow-1"
    >
      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="min-w-0 truncate text-ui font-medium text-fg">{completed.sessionTitle}</h4>
          <span className="text-note text-muted">
            {displayAgent(completed.agent, agents, t, i18n.language)}
          </span>
          <span
            className={cn(
              'rounded-[5px] px-1.5 py-0.5 text-[11px]',
              completed.status === 'completed'
                ? 'bg-ok-soft text-ok'
                : completed.status === 'failed' || completed.status === 'aborted'
                  ? 'bg-danger-soft text-danger'
                  : 'bg-warn-soft text-warn',
            )}
          >
            {t(`inspector.turn.${completed.status}`)}
          </span>
        </div>
        {completed.summary !== '' && (
          <p className="mt-1 line-clamp-2 text-note text-fg2">{completed.summary}</p>
        )}
        <time
          dateTime={new Date(completed.completedAt).toISOString()}
          className="mt-1 block text-note text-faint"
        >
          {t('activity.completedAt', {
            time: timeText(completed.completedAt, i18n.language),
          })}
        </time>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {completed.changeSetId !== undefined && (
          <button
            type="button"
            onClick={() => onOpen(completed.sessionId, completed.changeSetId)}
            className="flex h-7 shrink-0 items-center gap-1 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
          >
            <FileDiff aria-hidden className="size-3.5" />
            {t('activity.viewChanges')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen(completed.sessionId)}
          className="flex h-7 shrink-0 items-center rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('activity.view')}
        </button>
      </div>
    </article>
  )
}

export function ActivityView({
  leading,
  onOpenSession,
}: {
  readonly leading?: ReactNode
  readonly onOpenSession: (sessionId: string, changeSetId?: string) => void
}) {
  const { t, i18n } = useTranslation('session')
  const activity = useSessionStore((state) => state.activity)
  const loading = useSessionStore((state) => state.activityLoading)
  const error = useSessionStore((state) => state.activityError)
  const refreshActivity = useSessionStore((state) => state.refreshActivity)
  const resolveActivity = useSessionStore((state) => state.resolveActivity)
  const agents = useSessionStore((state) => state.agents) ?? []
  const [busy, setBusy] = useState<string | undefined>()

  useEffect(() => {
    void refreshActivity()
  }, [refreshActivity])

  const decide = async (
    decision: 'allow_once' | 'allow_session' | 'deny',
    approval: ActivityApproval,
  ) => {
    if (busy !== undefined) return
    setBusy(approval.approvalId)
    await resolveActivity(approval.approvalId, decision)
    setBusy(undefined)
  }

  const approvals = activity?.approvals ?? []
  const running = activity?.running ?? []
  const completed = activity?.completed ?? []
  const empty = activity !== undefined && approvals.length + running.length + completed.length === 0
  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-1.5 pl-3">{leading}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-7 py-6">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-page font-semibold text-fg">{t('activity.title')}</h2>
              <p className="mt-1 text-note text-muted">
                {t('activity.summary', {
                  approvals: activity?.counts.approvals ?? 0,
                  running: activity?.counts.running ?? 0,
                  completed: completed.length,
                })}
              </p>
            </div>
            <IconButton
              label={t('activity.refresh')}
              size="icon-sm"
              disabled={loading}
              onClick={() => void refreshActivity()}
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </IconButton>
          </header>
          <p className="sr-only" aria-live="polite">
            {activity === undefined
              ? ''
              : t('activity.announce', {
                  approvals: activity.counts.approvals,
                  running: activity.counts.running,
                })}
          </p>

          {error ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-card bg-raise p-4 text-ui shadow-1"
            >
              <p className="text-danger">{translateError(i18n, error)}</p>
              <button
                type="button"
                onClick={() => void refreshActivity()}
                className="flex h-7 items-center gap-1.5 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
              >
                <RefreshCw aria-hidden className="size-3.5" />
                {t('activity.retry')}
              </button>
            </div>
          ) : activity === undefined || loading ? (
            <p role="status" className="text-ui text-muted">
              {t('activity.loading')}
            </p>
          ) : empty ? (
            <div className="flex flex-col items-center gap-2 rounded-card bg-raise p-8 text-center shadow-1">
              <Clock3 aria-hidden className="size-6 text-faint" />
              <p className="text-ui font-medium text-fg2">{t('activity.empty')}</p>
              <p className="text-note text-muted">{t('activity.emptyHint')}</p>
            </div>
          ) : (
            <>
              <Section
                title={t('activity.approvals')}
                label={t('activity.approvals')}
                count={approvals.length}
              >
                {approvals.length === 0 ? (
                  <p className="text-note text-faint">{t('activity.noneApprovals')}</p>
                ) : (
                  approvals.map((approval) => (
                    <ApprovalRow
                      key={approval.approvalId}
                      approval={approval}
                      agents={agents}
                      busy={busy === approval.approvalId}
                      onDecide={(decision, item) => void decide(decision, item)}
                      onOpen={onOpenSession}
                    />
                  ))
                )}
              </Section>

              <Section
                title={t('activity.runningSection')}
                label={t('activity.runningSection')}
                count={running.length}
              >
                {running.length === 0 ? (
                  <p className="text-note text-faint">{t('activity.noneRunning')}</p>
                ) : (
                  running.map((item) => (
                    <RunningRow
                      key={`${item.sessionId}:${item.runId}`}
                      running={item}
                      agents={agents}
                      onOpen={onOpenSession}
                    />
                  ))
                )}
              </Section>

              <Section
                title={t('activity.completedSection')}
                label={t('activity.completedSection')}
                count={completed.length}
              >
                {completed.length === 0 ? (
                  <p className="text-note text-faint">{t('activity.noneCompleted')}</p>
                ) : (
                  completed.map((item) => (
                    <CompletedRow
                      key={`${item.sessionId}:${item.runId}:${item.turnId ?? ''}:${item.completedAt}`}
                      completed={item}
                      agents={agents}
                      onOpen={onOpenSession}
                    />
                  ))
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  )
}
