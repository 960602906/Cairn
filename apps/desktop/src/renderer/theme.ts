/**
 * 界面主题（视觉规范 §3）。把设置中的主题解析成浅色或深色，写到 `<html data-theme>`。
 *
 * 只有三个选项：跟随系统、浅色、深色。旧版本保存的五套彩色配色继续可读，按明暗归到这两套。
 */
import type { Theme } from '@cairn/protocol'

/** 实际渲染的配色，同时也是 `<html data-theme>` 的取值。 */
export type ResolvedTheme = 'light' | 'dark'

export const isDarkTheme = (theme: ResolvedTheme): boolean => theme === 'dark'

/** 没有保存过主题时跟随系统。 */
export const DEFAULT_THEME: Theme = 'system'

/** 设置页里可选的主题。 */
export const THEME_CHOICES = [
  { value: 'system', label: 'general.theme.system' },
  { value: 'light', label: 'general.theme.light' },
  { value: 'dark', label: 'general.theme.dark' },
] as const satisfies readonly { readonly value: Theme; readonly label: string }[]

/** 把设置值（含旧版本的配色名）归到三个选项之一。 */
export function themeChoice(theme: Theme): 'system' | ResolvedTheme {
  switch (theme) {
    case 'system':
      return 'system'
    case 'light':
    case 'paper':
    case 'tundra':
      return 'light'
    default:
      return 'dark'
  }
}

export interface ThemeEnvironment {
  readonly root: { setAttribute(name: string, value: string): void }
  readonly matchMedia?: (query: string) => MediaQueryList
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  const choice = themeChoice(theme)
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
}

/**
 * 应用主题；返回取消监听的函数。没有 `matchMedia`（如测试环境）时“跟随系统”按浅色处理。
 * @param onResolved 每次解析出的配色与明暗（例如同步 Windows 标题栏按钮颜色）
 */
export function applyTheme(
  theme: Theme,
  env: ThemeEnvironment = {
    root: document.documentElement,
    matchMedia: window.matchMedia?.bind(window),
  },
  onResolved?: (resolved: ResolvedTheme, dark: boolean) => void,
): () => void {
  const media = theme === 'system' ? env.matchMedia?.(DARK_QUERY) : undefined
  const apply = () => {
    const resolved = resolveTheme(theme, media?.matches ?? false)
    env.root.setAttribute('data-theme', resolved)
    onResolved?.(resolved, isDarkTheme(resolved))
  }
  apply()
  if (!media) return () => {}
  media.addEventListener('change', apply)
  return () => media.removeEventListener('change', apply)
}
