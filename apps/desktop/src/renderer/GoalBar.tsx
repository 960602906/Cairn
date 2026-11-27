/**
 * 目标条（ADR-0047）：输入框上方的单行细卡，只在有未结束目标时出现。
 *
 * 布局与待办进度条（TaskProgress）一致：`h-9` 细条、`rounded-card bg-raise shadow-2`，浮在
 * Composer 正上方。显示条件与短状态；暂停 / 继续、改条件、删除直接调用 store。暂停不中止
 * 正在跑的一轮；恢复要求会话空闲，因此运行中禁用「继续」。失败时在条内显示提示。轮次与活动
 * 时长只在目标面板展示。改条件时 Enter 保存、Esc 取消，输入法组字中的 Enter 不保存；失焦
 * 保存但不再抢回焦点（焦点是用户自己移走的）。
 */
import { Pause, Pencil, Play, Target, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isAwaitingGoalEvaluation, openGoal, type GoalView, type SessionView } from '@cairn/core'
import { GOAL_CONDITION_MAX, type SessionStatus } from '@cairn/protocol'
import { goalErrorNoticeKey } from './composer-commands.js'
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
  IconButton,
} from './ui/index.js'

export { formatGoalDuration } from './goal-display.js'

/** 恢复目标要求会话空闲：运行、等待审批或等待回答时按钮禁用。 */
export function goalSessionBusy(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'waiting_input'
}

export type GoalBarPhase =
  | 'running'
  | 'waitingApproval'
  | 'waitingInput'
  | 'judging'
  | 'continuing'
  | 'active'
  | 'paused'
  | 'pausedRunning'

/** 目标条 / 面板显示的状态；区分真正在跑与卡在审批 / 提问上。 */
export function goalBarPhase(
  view: SessionView,
  goal: GoalView,
  status: SessionStatus,
): GoalBarPhase | undefined {
  const busy = goalSessionBusy(status)
  if (goal.status === 'paused') return busy ? 'pausedRunning' : 'paused'
  if (goal.status !== 'active') return undefined
  if (status === 'waiting_approval') return 'waitingApproval'
  if (status === 'waiting_input') return 'waitingInput'
  if (status === 'running') return 'running'
  if (isAwaitingGoalEvaluation(view)) return 'judging'
  if (goal.evaluations.at(-1)?.verdict === 'not_met') return 'continuing'
  return 'active'
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
  const { t: tc } = useTranslation()
  const pauseGoal = useSessionStore((s) => s.pauseGoal)
  const resumeGoal = useSessionStore((s) => s.resumeGoal)
  const clearGoal = useSessionStore((s) => s.clearGoal)
  const updateGoalCondition = useSessionStore((s) => s.updateGoalCondition)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const goal = openGoal(view)
  if (goal === undefined) return null
  const phase = goalBarPhase(view, goal, status)
  if (phase === undefined) return null
  const busy = goalSessionBusy(status)
  const paused = goal.status === 'paused'
  const reason = t(`goal.pause.${goal.pauseReason ?? 'user'}`)
  const statusText =
    phase === 'running'
      ? t('goal.bar.running')
      : phase === 'waitingApproval'
        ? t('goal.bar.waitingApproval')
        : phase === 'waitingInput'
          ? t('goal.bar.waitingInput')
          : phase === 'judging'
            ? t('goal.bar.judging')
            : phase === 'continuing'
              ? t('goal.bar.continuing')
              : phase === 'paused'
                ? t('goal.bar.paused')
                : phase === 'pausedRunning'
                  ? t('goal.bar.pausedRunning')
                  : t('goal.bar.active')
  const statusTitle = paused || phase === 'pausedRunning' ? reason : goal.condition

  const act = async (action: () => Promise<{ ok: boolean; code?: string }>) => {
    if (pending) return
    setPending(true)
    setError(undefined)
    const outcome = await action()
    setPending(false)
    if (!outcome.ok) {
      setError(goalErrorNoticeKey(outcome.code ?? 'unknown'))
      return
    }
    returnFocus?.()
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
    setError(undefined)
  }

  /** `refocus` 为假时（失焦保存）不把焦点抢回输入框：是用户自己点到别处的。 */
  const saveEdit = async (refocus = true) => {
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
      if (refocus) returnFocus?.()
      return
    }
    setPending(true)
    setError(undefined)
    const outcome = await updateGoalCondition(view.sessionId, next)
    setPending(false)
    if (!outcome.ok) {
      setError(goalErrorNoticeKey(outcome.code ?? 'unknown'))
      return
    }
    setEditing(false)
    setDraft('')
    if (refocus) returnFocus?.()
  }

  return (
    <section
      aria-label={t('goal.bar.label')}
      data-goal={goal.goalId}
      className="mb-2 overflow-hidden rounded-card bg-raise shadow-2"
    >
      <div className="flex h-9 items-center gap-2 pr-1.5 pl-3">
        {paused ? (
          <Pause aria-hidden className="size-3.5 shrink-0 text-warn" />
        ) : (
          <Target
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-accent',
              phase === 'running' && 'motion-safe:animate-pulse',
            )}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label={t('goal.bar.conditionInput')}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // 输入法组字中的 Enter 用于选词，不保存。
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelEdit()
                returnFocus?.()
              }
            }}
            onBlur={() => {
              if (pending) return
              if (draft.trim() === goal.condition || draft.trim() === '') {
                cancelEdit()
                return
              }
              void saveEdit(false)
            }}
            className="min-w-0 flex-1 rounded-[5px] border border-hair bg-sunk px-1.5 py-0.5 text-note text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        ) : (
          <button
            type="button"
            title={goal.condition}
            onClick={onOpen}
            className="min-w-0 flex-1 truncate rounded-[5px] text-left text-note font-medium text-fg outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
          >
            {goal.condition}
          </button>
        )}
        {!editing && (
          <span className="shrink-0 text-note text-muted" title={statusTitle}>
            {statusText}
          </span>
        )}
        {paused ? (
          <IconButton
            label={t('goal.bar.resume')}
            size="icon-sm"
            disabled={busy || pending || editing}
            title={busy ? t('goal.panel.resumeBlocked') : t('goal.bar.resume')}
            onClick={() => void act(() => resumeGoal(view.sessionId))}
          >
            <Play />
          </IconButton>
        ) : (
          <IconButton
            label={t('goal.bar.pause')}
            size="icon-sm"
            disabled={pending || editing}
            onClick={() => void act(() => pauseGoal(view.sessionId))}
          >
            <Pause />
          </IconButton>
        )}
        <IconButton
          label={t('goal.bar.edit')}
          size="icon-sm"
          disabled={pending || editing}
          onClick={startEdit}
        >
          <Pencil />
        </IconButton>
        <IconButton
          label={t('goal.bar.delete')}
          size="icon-sm"
          disabled={pending || editing}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 />
        </IconButton>
      </div>
      {error !== undefined && (
        <p role="status" className="border-t-[0.5px] border-hair px-3 py-1.5 text-note text-muted">
          {t(error)}
        </p>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {statusText}
      </span>
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
                void act(() => clearGoal(view.sessionId))
              }}
            >
              {t('goal.panel.clearConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
