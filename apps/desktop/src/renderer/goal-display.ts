/**
 * 目标模式界面共用的展示辅助：活动时长格式、机器 detail 码本地化。
 *
 * 时长在 1 小时内用 `m:ss`，超过后用 `Nh MMm`，避免 1 分钟与 1 小时都显示成 `1:00`。
 * `pauseDetail` / `endDetail` 里常见的是机器码（`turns`、`host_crashed` 等），只翻译已知码；
 * 未知码不展示，避免把内部错误串直接露给用户。
 */
export const GOAL_DETAIL_KEYS = [
  'turns',
  'duration',
  'stopped',
  'model_unavailable',
  'timeout',
  'invalid_output',
  'no_verifiable_progress',
  'host_crashed',
  'judge_failed',
  'checkpoint',
  'file_revert',
  'edit',
  'regenerate',
] as const

export type GoalDetailKey = (typeof GOAL_DETAIL_KEYS)[number]

/** 小于 1 小时显示 `m:ss`，更久显示 `Nh MMm`；负值按 0 处理。 */
export function formatGoalDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (hours === 0) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

/** 把已知的目标 detail 码翻成文案；未知码返回 undefined，调用方不渲染。 */
export function goalDetailText(
  detail: string | undefined,
  t: (key: string) => string,
): string | undefined {
  if (detail === undefined || detail === '') return undefined
  if ((GOAL_DETAIL_KEYS as readonly string[]).includes(detail)) {
    return t(`goal.detail.${detail}`)
  }
  return undefined
}
