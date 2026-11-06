/**
 * 界面主题（M2-01，视觉规范 §3）。把设置中的主题解析为浅色或深色，写到 `<html data-theme>`；
 * “跟随系统”时监听系统的 `prefers-color-scheme`，系统切换后即时生效。
 */
import type { Theme } from '@cairn/protocol'

export type ResolvedTheme = 'light' | 'dark'

export interface ThemeEnvironment {
  readonly root: { setAttribute(name: string, value: string): void }
  readonly matchMedia?: (query: string) => MediaQueryList
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return theme
}

/**
 * 应用主题；返回取消监听的函数。没有 `matchMedia`（如测试环境）时“跟随系统”按浅色处理。
 * @param onResolved 每次解析出的主题（例如同步 Windows 标题栏按钮颜色）
 */
export function applyTheme(
  theme: Theme,
  env: ThemeEnvironment = {
    root: document.documentElement,
    matchMedia: window.matchMedia?.bind(window),
  },
  onResolved?: (resolved: ResolvedTheme) => void,
): () => void {
  const media = theme === 'system' ? env.matchMedia?.(DARK_QUERY) : undefined
  const apply = () => {
    const resolved = resolveTheme(theme, media?.matches ?? false)
    env.root.setAttribute('data-theme', resolved)
    onResolved?.(resolved)
  }
  apply()
  if (!media) return () => {}
  media.addEventListener('change', apply)
  return () => media.removeEventListener('change', apply)
}
