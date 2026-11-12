/**
 * 对话列与工作台首页共用的状态呈现（聊天区域状态显示优化方案 §3.2）。
 *
 * 状态不能只靠颜色区分：每个状态都有对应的图形和文字。这里只负责视觉语义，
 * 不引入新的运行状态条，也不改变事件归约与会话状态本身。
 */
import {
  Ban,
  Circle,
  CircleAlert,
  CirclePause,
  Clock3,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { ACTIVE_RUN_STATES, rootRun, type SessionView } from '@cairn/core'
import type { RunState, SessionStatus } from '@cairn/protocol'

export type StatusTone = 'neutral' | 'accent' | 'warn' | 'danger'

export interface StatusPresentation {
  readonly tone: StatusTone
  readonly Icon: LucideIcon
}

/** 会话状态 → 图形与色调；文字仍由 `status.<状态>` 提供，图形只做装饰。 */
export function statusPresentation(status: SessionStatus): StatusPresentation {
  switch (status) {
    case 'running':
      return { tone: 'accent', Icon: LoaderCircle }
    case 'waiting_approval':
      return { tone: 'warn', Icon: Clock3 }
    case 'failed':
      return { tone: 'danger', Icon: CircleAlert }
    case 'interrupted':
      return { tone: 'warn', Icon: CirclePause }
    case 'crashed':
      return { tone: 'danger', Icon: TriangleAlert }
    case 'archived':
      return { tone: 'neutral', Icon: Ban }
    default:
      return { tone: 'neutral', Icon: Circle }
  }
}

/** 运行指示覆盖的状态：core 的“运行中”再加上正在停止（也需要反馈）。 */
const INDICATOR_STATES: ReadonlySet<RunState> = new Set([...ACTIVE_RUN_STATES, 'aborting'])

/**
 * 消息列末尾的运行指示文案（聊天区状态显示优化方案 §3.2）：
 * 只在“已经发出、但界面上还没有可看的内容”时返回文案 —— 已有流式正文 / 思考，
 * 或已有正在执行的工具（工具时间线已体现活动）时不显示。返回 i18n key，文字仍由 `t(key)` 提供。
 */
export function runningActivityKey(view: SessionView, awaiting: boolean): string | undefined {
  const state = rootRun(view)?.state
  const active = awaiting || (state !== undefined && INDICATOR_STATES.has(state))
  if (!active) return undefined
  const rootRuns = new Set(
    view.runOrder.filter((runId) => view.runs[runId]?.parentRunId === undefined),
  )
  if (
    Object.values(view.live).some(
      (message) => rootRuns.has(message.runId) && (message.text !== '' || message.reasoning !== ''),
    )
  ) {
    return undefined
  }
  if (
    Object.values(view.tools).some(
      (tool) =>
        rootRuns.has(tool.runId) && (tool.status === 'requested' || tool.status === 'running'),
    )
  ) {
    return undefined
  }
  switch (state) {
    case 'thinking':
      return 'run.thinking'
    case 'tooling':
      return 'run.tooling'
    case 'aborting':
      return 'run.aborting'
    case 'awaiting_approval':
      return 'status.waiting_approval'
    default:
      return 'status.running'
  }
}

/** 轮次结局的严重程度：停止 / 中断中性，重试与限额警告，失败与崩溃危险。 */
export type TurnOutcomeTone = Extract<StatusTone, 'neutral' | 'warn' | 'danger'>

export function outcomePresentation(view: SessionView): {
  readonly tone: TurnOutcomeTone
  readonly Icon: LucideIcon
  readonly iconLabelKey: string
} {
  if (view.crash) {
    return { tone: 'danger', Icon: TriangleAlert, iconLabelKey: 'turn.outcome.icon.failed' }
  }
  const turn = rootRun(view)?.turn
  if (turn?.status === 'aborted') {
    return { tone: 'neutral', Icon: CirclePause, iconLabelKey: 'turn.outcome.icon.stopped' }
  }
  if (turn?.status === 'running' && turn.retry) {
    return { tone: 'warn', Icon: RefreshCw, iconLabelKey: 'turn.outcome.icon.retrying' }
  }
  if (turn?.status !== 'failed') {
    return { tone: 'neutral', Icon: CirclePause, iconLabelKey: 'turn.outcome.icon.stopped' }
  }
  if (turn.limitReached) {
    return { tone: 'warn', Icon: TriangleAlert, iconLabelKey: 'turn.outcome.icon.limit' }
  }
  return { tone: 'danger', Icon: CircleAlert, iconLabelKey: 'turn.outcome.icon.failed' }
}

/** Tailwind 静态类名集中在这里，避免动态拼接导致样式被清除。 */
export const TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  neutral: 'text-muted',
  accent: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
}

export const TONE_SOFT: Readonly<Record<TurnOutcomeTone, string>> = {
  neutral: 'bg-sunk text-fg2',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
}

/** 侧栏会话状态的小圆点；运行中仍使用转圈。 */
export const TONE_DOT: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-transparent',
  accent: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
}
