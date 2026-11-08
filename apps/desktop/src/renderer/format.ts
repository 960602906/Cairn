/** 耗时：1 秒以内用毫秒，否则保留一位小数的秒。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 状态条与检查器的紧凑 token 数：小于 1000 原样，之后用 K。 */
export function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const value = tokens / 1000
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}K`
}
