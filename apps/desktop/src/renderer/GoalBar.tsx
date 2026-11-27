/**
 * 目标条（ADR-0047）：输入框上方悬浮列里最靠近输入框的一项，只在有未结束目标时出现。
 *
 * 显示条件、当前阶段与活动时长；点击条件或右侧按钮打开目标面板。暂停 / 继续直接调用
 * store 的目标动作：暂停不中止正在跑的一轮，恢复要求会话空闲，因此运行中禁用「继续」。
 * 计时每秒刷新一次，但只影响显示；读屏的 live region 只播报阶段变化，不播报秒数。
 */
import { Pause, Play, Target } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isAwaitingGoalEvaluation, openGoal, type GoalView, type SessionView } from '@cairn/core'
import type { SessionStatus } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button, cn, FloatCard, IconButton } from './ui/index.js'

/** 恢复目标要求会话空闲：运行、等待审批或等待回答时按钮禁用。 */
export function goalSessionBusy(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'waiting_input'
}

export type GoalBarPhase =
  'running' | 'judging' | 'continuing' | 'active' | 'paused' | 'pausedRunning'

/** 目标条 / 面板显示的状态；`view` 用来判断是否在等待判定。 */
export function goalBarPhase(
  view: SessionView,
  goal: GoalView,
  busy: boolean,
): GoalBarPhase | undefined {
  if (goal.status === 'paused') return busy ? 'pausedRunning' : 'paused'
  if (goal.status !== 'active') return undefined
  if (busy) return 'running'
  if (isAwaitingGoalEvaluation(view)) return 'judging'
  if (goal.evaluations.at(-1)?.verdict === 'not_met') return 'continuing'
  return 'active'
}

/** 小于 1 小时显示 `m:ss`，更久显示 `h:mm`；负值按 0 处理。 */
export function formatGoalDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 目标的活动时长：暂停或结束时固定在 `activeMs`，活动时按当前时间重算。
 * 窗口隐藏时停表，重新可见时立即按新的 `now` 计算，不累加。
 */
export function useGoalElapsed(goal: GoalView | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const active = goal?.status === 'active' && goal.activeSince !== undefined
  useEffect(() => {
    if (!active) return
    let timer: number | undefined
    const tick = () => setNow(Date.now())
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      tick()
    }
    const start = () => {
      tick()
      if (timer === undefined) timer = window.setInterval(tick, 1_000)
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    if (document.hidden) stop()
    else start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, goal?.activeSince])
  if (goal === undefined) return 0
  const elapsed = active && goal.activeSince !== undefined ? Math.max(0, now - goal.activeSince) : 0
  return goal.activeMs + elapsed
}

export function GoalBar({
  view,
  status,
  onOpen,
  returnFocus,
}: {
  readonly view: SessionView
  /** 会话的显示状态；运行中禁用「继续」。 */
  readonly status: SessionStatus
  readonly onOpen: () => void
  /** 暂停 / 继续结束后把焦点还给这里（通常是输入框）。 */
  readonly returnFocus?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const pauseGoal = useSessionStore((s) => s.pauseGoal)
  const resumeGoal = useSessionStore((s) => s.resumeGoal)
  const [pending, setPending] = useState(false)
  const goal = openGoal(view)
  const elapsed = useGoalElapsed(goal)
  const busy = goalSessionBusy(status)
  if (goal === undefined) return null
  const phase = goalBarPhase(view, goal, busy)
  if (phase === undefined) return null
  const paused = goal.status === 'paused'
  const reason = t(`goal.pause.${goal.pauseReason ?? 'user'}`)
  const statusText =
    phase === 'running'
      ? t('goal.bar.running', {
          turn: Math.max(1, goal.turnIds.length),
          max: goal.limits.maxTurns,
        })
      : phase === 'judging'
        ? t('goal.bar.judging')
        : phase === 'continuing'
          ? t('goal.bar.continuing')
          : phase === 'paused'
            ? t('goal.bar.paused', { reason })
            : phase === 'pausedRunning'
              ? t('goal.bar.pausedRunning', { reason })
              : t('goal.bar.active')
  const act = async (action: () => Promise<unknown>) => {
    if (pending) return
    setPending(true)
    await action()
    setPending(false)
    // 暂停 / 继续成功后按钮会换成另一个，原按钮消失，焦点交给输入框。
    returnFocus?.()
  }
  return (
    <FloatCard aria-label={t('goal.bar.label')} data-goal={goal.goalId}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full',
            paused ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
          )}
        >
          {paused ? (
            <Pause className="size-3" />
          ) : (
            <Target className={cn('size-3', phase === 'running' && 'motion-safe:animate-pulse')} />
          )}
        </span>
        <button
          type="button"
          title={goal.condition}
          onClick={onOpen}
          className="min-w-0 flex-1 truncate rounded-[5px] text-left text-note font-medium text-fg outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
        >
          {goal.condition}
        </button>
        {paused ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || pending}
            title={busy ? t('goal.panel.resumeBlocked') : undefined}
            onClick={() => void act(() => resumeGoal(view.sessionId))}
          >
            <Play aria-hidden className="size-3" />
            {t('goal.bar.resume')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void act(() => pauseGoal(view.sessionId))}
          >
            <Pause aria-hidden className="size-3" />
            {t('goal.bar.pause')}
          </Button>
        )}
        <IconButton label={t('goal.bar.open')} size="icon-sm" onClick={onOpen}>
          <Target />
        </IconButton>
      </div>
      <p className="mt-0.5 flex min-w-0 items-center gap-1 pl-7 text-[11.5px] text-muted">
        <span className="truncate">{statusText}</span>
        {!paused && (
          <span className="tabular shrink-0" aria-hidden>
            · {formatGoalDuration(elapsed)}
          </span>
        )}
      </p>
      {/* 只播报阶段；计时在视觉上每秒变化，但这里的文字不变。 */}
      <span role="status" aria-live="polite" className="sr-only">
        {statusText}
      </span>
    </FloatCard>
  )
}
