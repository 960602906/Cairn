/**
 * 目标面板（ADR-0047）：条件、状态与原因、预算、判定时间线与操作。
 *
 * 面板读取当前会话的目标投影；回退移除目标、清除或换成新目标时随投影一起更新，
 * 不保留旧引用。已结束的目标留在历史里，未结束的目标同时显示在输入框上方的目标条里。
 */
import { CirclePause, Pencil, Play, Target, Trash2, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openGoal, type GoalView } from '@cairn/core'
import { GOAL_CONDITION_MAX, type GoalVerdict } from '@cairn/protocol'
import { goalErrorNoticeKey } from './composer-commands.js'
import { formatGoalDuration, goalDetailText } from './goal-display.js'
import { goalSessionBusy, useGoalElapsed } from './GoalBar.js'
import { modelLabel } from './model-labels.js'
import type { SessionPanelContext } from './SessionPanels.js'
import { useSessionStore } from './store-context.js'
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  PanelEmpty,
} from './ui/index.js'

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

/** 最近一次已结束目标的只读摘要：条件、结局与判定时间线，供结果卡「查看目标」跳进面板后阅读。 */
function EndedGoalSummary({ goal }: { readonly goal: GoalView }) {
  const { t } = useTranslation('session')
  const ended = goal.lifecycle.find((item) => item.kind === 'ended')
  const detail = goalDetailText(goal.endDetail, t)
  const reason = reasonText(goal, t)
  return (
    <div>
      <section aria-label={t('goal.panel.label')} className="p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
          <span className="text-muted">{t('goal.panel.condition')}</span>
          <span className={cn('rounded-[5px] px-1.5 py-0.5', STATUS_CLASS.ended)}>
            {t('goal.status.ended')}
          </span>
          {reason !== undefined && <span className="text-muted">{reason}</span>}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-ui text-fg">{goal.condition}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
          <span>
            {t('goal.panel.endedSummary', {
              turns: ended?.turns ?? goal.turnIds.length,
              duration: formatGoalDuration(ended?.durationMs ?? goal.activeMs),
            })}
          </span>
          <span>
            {t('goal.panel.budget')} ·{' '}
            {t('goal.panel.turns', { used: goal.turnIds.length, max: goal.limits.maxTurns })}
          </span>
        </div>
        {detail !== undefined && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-note text-muted">{detail}</p>
        )}
        <p className="mt-2 text-[11.5px] text-faint">{t('goal.panel.evidenceDisclaimer')}</p>
        <p className="mt-1 text-[11.5px] text-faint">{t('goal.panel.newHint')}</p>
      </section>
      <GoalEvaluations goal={goal} />
    </div>
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
  const { t: tc } = useTranslation()
  const pauseGoal = useSessionStore((s) => s.pauseGoal)
  const resumeGoal = useSessionStore((s) => s.resumeGoal)
  const clearGoal = useSessionStore((s) => s.clearGoal)
  const updateGoalCondition = useSessionStore((s) => s.updateGoalCondition)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [confirmClear, setConfirmClear] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const elapsed = useGoalElapsed(goal)
  const busy = goalSessionBusy(status)
  const paused = goal.status === 'paused'
  const reason = reasonText(goal, t)
  const detail = goalDetailText(paused ? goal.pauseDetail : goal.endDetail, t)
  const run = async (action: () => Promise<{ ok: boolean; code?: string }>) => {
    if (pending) return
    setPending(true)
    setError(undefined)
    const outcome = await action()
    setPending(false)
    if (!outcome.ok) setError(goalErrorNoticeKey(outcome.code ?? 'unknown'))
  }
  const startEdit = () => {
    setDraft(goal.condition)
    setError(undefined)
    setEditing(true)
    queueMicrotask(() => inputRef.current?.select())
  }
  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }
  const saveEdit = async () => {
    const next = draft.trim()
    if (next.length === 0) {
      setError('goal.bar.conditionEmpty')
      return
    }
    if (next.length > GOAL_CONDITION_MAX) {
      setError('goal.bar.conditionTooLong')
      return
    }
    if (next === goal.condition) {
      cancelEdit()
      return
    }
    if (pending) return
    setPending(true)
    setError(undefined)
    const outcome = await updateGoalCondition(sessionId, next)
    setPending(false)
    if (!outcome.ok) {
      setError(goalErrorNoticeKey(outcome.code ?? 'unknown'))
      return
    }
    setEditing(false)
    setDraft('')
  }
  return (
    <div>
      <section aria-label={t('goal.panel.label')} className="p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
          <span className="text-muted">{t('goal.panel.condition')}</span>
          <span className={cn('rounded-[5px] px-1.5 py-0.5', STATUS_CLASS[goal.status])}>
            {t(`goal.status.${goal.status}`)}
          </span>
          {reason !== undefined && <span className="text-muted">{reason}</span>}
        </div>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label={t('goal.bar.conditionInput')}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelEdit()
              }
            }}
            className="mt-1.5 w-full rounded-[5px] border border-hair bg-sunk px-2 py-1.5 text-ui text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        ) : (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-ui text-fg">{goal.condition}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
          <span>
            {t('goal.panel.budget')} ·{' '}
            {t('goal.panel.turns', { used: goal.turnIds.length, max: goal.limits.maxTurns })}
          </span>
          <span>
            {t('goal.panel.duration')} {formatGoalDuration(elapsed)} /{' '}
            {formatGoalDuration(goal.limits.maxDurationMs)}
          </span>
        </div>
        {detail !== undefined && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-note text-muted">{detail}</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {paused ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || pending || editing}
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
              disabled={pending || editing}
              onClick={() => void run(() => pauseGoal(sessionId))}
            >
              <CirclePause aria-hidden className="size-3.5" />
              {t('goal.panel.pause')}
            </Button>
          )}
          {editing ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => void saveEdit()}>
              {t('goal.panel.saveCondition')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={startEdit}>
              <Pencil aria-hidden className="size-3.5" />
              {t('goal.panel.editCondition')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || editing}
            className="text-danger hover:bg-danger-soft hover:text-danger"
            onClick={() => setConfirmClear(true)}
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
        <p className="mt-2 text-[11.5px] text-faint">{t('goal.panel.evidenceDisclaimer')}</p>
        <p className="mt-1 text-[11.5px] text-faint">{t('goal.panel.clearHint')}</p>
      </section>
      <GoalEvaluations goal={goal} />
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('goal.panel.clearConfirmTitle')}</DialogTitle>
          <DialogDescription>{t('goal.panel.clearConfirmDescription')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                setConfirmClear(false)
                void run(() => clearGoal(sessionId))
              }}
            >
              {t('goal.panel.clearConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  if (goal !== undefined) {
    return (
      <div className="h-full overflow-y-auto">
        <OpenGoal sessionId={sessionId} status={status} goal={goal} />
        {history.length > 0 && <GoalHistory goals={history} />}
      </div>
    )
  }
  if (history.length === 0) {
    return (
      <PanelEmpty icon={<Target />} hint={t('goal.panel.newHint')}>
        {t('goal.panel.empty')}
      </PanelEmpty>
    )
  }
  // history.length > 0：第一条是最近结束的目标，其余进历史列表。
  const latestEnded = history[0] as GoalView
  const olderHistory = history.slice(1)
  return (
    <div className="h-full overflow-y-auto">
      <EndedGoalSummary goal={latestEnded} />
      {olderHistory.length > 0 && <GoalHistory goals={olderHistory} />}
    </div>
  )
}
