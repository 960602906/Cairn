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
import { rootRun, type SessionView } from '@cairn/core'
import type { SessionStatus } from '@cairn/protocol'

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
