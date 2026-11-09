/**
 * 界面主题（视觉规范 §3）。把设置中的主题解析成一套具体配色，写到 `<html data-theme>`。
 *
 * 默认配色是「板岩」；「跟随系统」时深色用板岩、浅色用纸面。
 * 旧版本保存的 `light` / `dark` / `graphite` 继续可用，分别归到苔原 / 黑曜 / 黑曜。
 */
import type { Theme } from '@cairn/protocol'

/** 实际渲染的配色，同时也是 `<html data-theme>` 的取值。 */
export type ResolvedTheme = 'bluestone' | 'obsidian' | 'paper' | 'tundra' | 'slate'

/** 深色配色；`dark:` 变体与系统按钮颜色据此判断。 */
export const DARK_THEMES: ReadonlySet<ResolvedTheme> = new Set(['bluestone', 'obsidian', 'slate'])

export const isDarkTheme = (theme: ResolvedTheme): boolean => DARK_THEMES.has(theme)

/** 没有保存过主题时的配色：应用默认呈现 01 枢纽（板岩鸢尾）方案。 */
export const DEFAULT_THEME: ResolvedTheme = 'slate'

/** 设置页里可选的配色（不含“跟随系统”）。 */
export const THEME_CHOICES = [
  { value: 'bluestone', label: 'general.theme.bluestone', dark: true },
  { value: 'obsidian', label: 'general.theme.obsidian', dark: true },
  { value: 'paper', label: 'general.theme.paper', dark: false },
  { value: 'tundra', label: 'general.theme.tundra', dark: false },
  { value: 'slate', label: 'general.theme.slate', dark: true },
] as const satisfies readonly {
  readonly value: ResolvedTheme
  readonly label: string
  readonly dark: boolean
}[]

/** 设置页色板预览用的三个代表色（与 tokens.css 的四套主题保持一致）。 */
export const THEME_SWATCHES: Readonly<
  Record<
    ResolvedTheme,
    { readonly canvas: string; readonly paper: string; readonly accent: string }
  >
> = {
  bluestone: { canvas: '#0b0d0f', paper: '#101317', accent: '#2dd4bf' },
  obsidian: { canvas: '#08090a', paper: '#0e0f11', accent: '#ff6a3d' },
  paper: { canvas: '#e6dccb', paper: '#fbf7ee', accent: '#a63b25' },
  tundra: { canvas: '#e7ebe5', paper: '#ffffff', accent: '#2f6b4b' },
  slate: { canvas: '#0a0c10', paper: '#0f1217', accent: '#8b93ff' },
}

export interface ThemeEnvironment {
  readonly root: { setAttribute(name: string, value: string): void }
  readonly matchMedia?: (query: string) => MediaQueryList
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  switch (theme) {
    case 'system':
      return systemDark ? 'slate' : 'paper'
    case 'light':
      return 'tundra'
    case 'dark':
    case 'graphite':
      return 'obsidian'
    default:
      return theme
  }
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
