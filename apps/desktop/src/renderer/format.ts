/** 耗时：1 秒以内用毫秒，否则保留一位小数的秒。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
