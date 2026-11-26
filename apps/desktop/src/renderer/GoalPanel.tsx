/**
 * 目标面板（ADR-0047）：条件、状态与原因、预算、判定时间线与操作。
 *
 * 面板读取当前会话的目标投影；回退移除目标、清除或换成新目标时随投影一起更新，
 * 不保留旧引用。已结束的目标留在历史里，未结束的目标同时显示在输入框上方的目标条里。
 */
import { CirclePause, CircleX, Play, Target, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openGoal, type GoalView } from '@cairn/core'
import type { GoalVerdict } from '@cairn/protocol'
import { goalErrorNoticeKey } from './composer-commands.js'
import { formatGoalDuration, goalSessionBusy, useGoalElapsed } from './GoalBar.js'
import { modelLabel } from './model-labels.js'
import type { SessionPanelContext } from './SessionPanels.js'
import { useSessionStore } from './store-context.js'
import { Button, cn, PanelEmpty } from './ui/index.js'

const VERDICT_CLASS: Readonly<Record<GoalVerdict, string>> = {
  met: 'bg-ok-soft text-ok',
  not_met: 'bg-warn-soft text-warn',
  impossible: 'bg-danger-soft text-danger',
}

const STATUS_CLASS = {
  active: 'bg-accent-soft text-accent',
  paused: 'bg-warn-soft text-warn',
  ended: 'bg-sunk text-muted',
} as const

export function reasonText(goal: GoalView, t: (key: string) => string): string | undefined {
  if (goal.status === 'paused' && goal.pauseReason !== undefined) {
    return t(`goal.pause.${goal.pauseReason}`)
  }
  if (goal.status === 'ended' && goal.endReason !== undefined) {
    return t(`goal.end.${goal.endReason}`)
  }
  return undefined
}

function GoalEvaluations({ goal }: { readonly goal: GoalView }) {
  const { t } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
  return (
    <section aria-label={t('goal.panel.evaluations')} className="border-t-[0.5px] border-hair p-3">
      <h3 className="text-note font-medium text-fg2">{t('goal.panel.evaluations')}</h3>
      {goal.evaluations.length === 0 ? (
        <p className="mt-2 text-note text-muted">{t('goal.panel.noEvaluations')}</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {goal.evaluations.map((evaluation, index) => (
            <li
              key={`${evaluation.seq}-${index}`}
              className="rounded-item bg-sunk px-3 py-2 text-note"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'rounded-[5px] px-1.5 py-0.5 text-[11px]',
                    VERDICT_CLASS[evaluation.verdict],
                  )}
                >
                  {t(`goal.verdict.${evaluation.verdict}`)}
                </span>
                <span className="text-[11px] text-muted">
                  {t('goal.panel.model')}：{modelLabel(evaluation.model, providers)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-fg2">{evaluation.reason}</p>
              {evaluation.evidence.length > 0 && (
                <div className="mt-1.5">
                  <span className="text-[11px] text-muted">{t('goal.panel.evidence')}：</span>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {evaluation.evidence.map((item, evidenceIndex) => (
                      <li
                        key={`${item.kind}-${item.ref}-${evidenceIndex}`}
                        title={item.note}
                        className="max-w-full truncate rounded-[5px] bg-raise px-1.5 py-0.5 font-mono text-[11px] text-fg2"
                      >
                        {t(`goal.evidence.kind.${item.kind}`)} · {item.ref}
                        {item.note !== undefined && (
                          <span className="ml-1 font-sans text-muted">{item.note}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function GoalHistory({ goals }: { readonly goals: readonly GoalView[] }) {
  const { t } = useTranslation('session')
  return (
    <section aria-label={t('goal.panel.history')} className="border-t-[0.5px] border-hair p-3">
      <h3 className="text-note font-medium text-fg2">{t('goal.panel.history')}</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {goals.map((goal) => {
          const ended = goal.lifecycle.find((item) => item.kind === 'ended')
          return (
            <li key={goal.goalId} className="rounded-item bg-sunk px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-note text-fg2" title={goal.condition}>
                  {goal.condition}
                </span>
                <span className="shrink-0 rounded-[5px] bg-raise px-1.5 py-0.5 text-[11px] text-muted">
                  {t(`goal.end.${goal.endReason ?? 'user'}`)}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                {t('goal.panel.endedSummary', {
                  turns: ended?.turns ?? goal.turnIds.length,
                  duration: formatGoalDuration(ended?.durationMs ?? goal.activeMs),
                })}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function OpenGoal({
  sessionId,
  status,
  goal,
}: {
  readonly sessionId: string
  readonly status: SessionPanelContext['status']
  readonly goal: GoalView
}) {
  const { t } = useTranslation('session')
  const pauseGoal = useSessionStore((s) => s.pauseGoal)
  const resumeGoal = useSessionStore((s) => s.resumeGoal)
  const clearGoal = useSessionStore((s) => s.clearGoal)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const elapsed = useGoalElapsed(goal)
  const busy = goalSessionBusy(status)
  const paused = goal.status === 'paused'
  const reason = reasonText(goal, t)
  const detail = paused ? goal.pauseDetail : goal.endDetail
  const run = async (action: () => Promise<{ ok: boolean; code?: string }>) => {
    if (pending) return
    setPending(true)
    setError(undefined)
    const outcome = await action()
    setPending(false)
    if (!outcome.ok) setError(goalErrorNoticeKey(outcome.code ?? 'unknown'))
  }
  return (
    <div>
      <section aria-label={t('goal.panel.label')} className="p-3">
        <p className="whitespace-pre-wrap break-words text-ui text-fg">{goal.condition}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
          <span className={cn('rounded-[5px] px-1.5 py-0.5', STATUS_CLASS[goal.status])}>
            {t(`goal.status.${goal.status}`)}
          </span>
          {reason !== undefined && <span className="text-muted">{reason}</span>}
          <span className="text-muted">
            {t('goal.panel.turns', { used: goal.turnIds.length, max: goal.limits.maxTurns })}
          </span>
          <span className="text-muted">
            {t('goal.panel.duration')} {formatGoalDuration(elapsed)} /{' '}
            {formatGoalDuration(goal.limits.maxDurationMs)}
          </span>
        </div>
        {detail !== undefined && detail !== '' && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-note text-muted">{detail}</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {paused ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || pending}
              title={busy ? t('goal.panel.resumeBlocked') : undefined}
              onClick={() => void run(() => resumeGoal(sessionId))}
            >
              <Play aria-hidden className="size-3.5" />
              {t('goal.panel.resume')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => void run(() => pauseGoal(sessionId))}
            >
              <CirclePause aria-hidden className="size-3.5" />
              {t('goal.panel.pause')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            className="text-danger hover:bg-danger-soft hover:text-danger"
            onClick={() => void run(() => clearGoal(sessionId))}
          >
            <Trash2 aria-hidden className="size-3.5" />
            {t('goal.panel.clear')}
          </Button>
        </div>
        {error !== undefined && (
          <p role="status" className="mt-2 text-note text-muted">
            {t(error)}
          </p>
        )}
        <p className="mt-2 text-[11.5px] text-faint">{t('goal.panel.newHint')}</p>
      </section>
      <GoalEvaluations goal={goal} />
    </div>
  )
}

export function GoalPanel({ sessionId, view, status }: SessionPanelContext) {
  const { t } = useTranslation('session')
  const goal = view === undefined ? undefined : openGoal(view)
  const history =
    view === undefined
      ? []
      : view.goalOrder.flatMap((goalId) => {
          const item = view.goals[goalId]
          return item !== undefined && item.status === 'ended' ? [item] : []
        })
  history.reverse()
  if (goal === undefined && history.length === 0) {
    return (
      <PanelEmpty icon={<Target />} hint={t('goal.panel.newHint')}>
        {t('goal.panel.empty')}
      </PanelEmpty>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      {goal !== undefined ? (
        <OpenGoal sessionId={sessionId} status={status} goal={goal} />
      ) : (
        <PanelEmpty icon={<CircleX />} hint={t('goal.panel.newHint')}>
          {t('goal.panel.empty')}
        </PanelEmpty>
      )}
      {history.length > 0 && <GoalHistory goals={history} />}
    </div>
  )
}
