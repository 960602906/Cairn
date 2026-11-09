/**
 * 更新界面的纯派生逻辑（M5-07）：提示何时出现、是否允许重启安装、进度与字节格式化。
 * 不依赖 React 与 DOM，组件与测试共用。
 */
import type { UpdateStatus } from '@cairn/protocol'

/** 非模态提示的形态；`downloaded` 时还要看 `installBlocked` 决定是否提示延迟。 */
export type UpdateNoticeKind = 'available' | 'downloading' | 'downloaded'

/** 会话列表里是否有运行中或等待审批的会话。 */
export function hasRunningSessions(sessions: readonly { readonly status: string }[]): boolean {
  return sessions.some(
    (session) => session.status === 'running' || session.status === 'waiting_approval',
  )
}

/** 提示在同一阶段的同一版本内保持稳定；“稍后”据此只在当前阶段生效。 */
export function noticeKey(status: UpdateStatus): string {
  return `${status.phase}:${status.availableVersion ?? status.currentVersion}`
}

/**
 * 当前应显示哪种非模态提示。`disabled`、`checking`、`up_to_date`、`skipped`、`error` 与
 * `installing` 不打扰用户（错误在更新设置里重试）；用户“稍后”后 available 提示隐藏。
 */
export function noticeKind(
  status: UpdateStatus | undefined,
  dismissed: string | undefined,
): UpdateNoticeKind | undefined {
  if (!status) return undefined
  switch (status.phase) {
    case 'available':
      return dismissed === noticeKey(status) ? undefined : 'available'
    case 'downloading':
      return 'downloading'
    case 'downloaded':
      return 'downloaded'
    default:
      return undefined
  }
}

/** 已下载但当前不能安装：主进程判定有任务运行，或界面已知有运行中的会话。 */
export function installBlocked(status: UpdateStatus, runningSessions: boolean): boolean {
  return status.blockedReason === 'update.busy' || runningSessions
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 字节数；未知或非正数为 `0 B`。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let index = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  let value = bytes / 1024 ** index
  const round = (input: number) =>
    index === 0 || input >= 10 ? Math.round(input) : Number(input.toFixed(1))
  let rounded = round(value)
  // 四舍五入后可能进位到下一单位（例如 1023.6 KB → 1 MB）
  if (rounded >= 1024 && index < UNITS.length - 1) {
    index += 1
    value /= 1024
    rounded = round(value)
  }
  return `${rounded} ${UNITS[index]}`
}

/** 下载速度；没有速度信息时不显示。 */
export function formatSpeed(bytesPerSecond: number | undefined): string | undefined {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return undefined
  }
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 进度百分比取整并夹在 0–100。 */
export function progressPercent(status: UpdateStatus): number {
  const percent = status.progress?.percent ?? 0
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0
}
