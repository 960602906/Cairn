/** 订阅 CSS 媒体查询（M2-02，窄窗收起侧栏）；没有 matchMedia 时为 false。 */
import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia?.(query)
      if (!media) return () => {}
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => window.matchMedia?.(query).matches ?? false,
  )
}
