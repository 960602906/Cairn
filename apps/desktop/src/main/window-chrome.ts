/**
 * 无边框窗口（M2-02，视觉规范 §2）：窗口自己画标题区，侧栏铺在窗口底色上。
 *
 * - macOS：`hiddenInset`，红绿灯放在侧栏左上角；
 * - Windows / Linux：`hidden` + `titleBarOverlay`，系统按钮叠在窗口右上角，颜色随主题（`--paper` 与 `--fg2`）。
 *   界面用 CSS `env(titlebar-area-*)` 给按钮让出位置。
 *
 * 纯函数，不依赖 Electron，便于测试。
 */
import type { Theme } from '@cairn/protocol'

/** 标题区高度：纸面顶栏与系统按钮使用同一高度，避免出现错位的第二条横线。 */
export const TITLE_BAR_HEIGHT = 48

/** 实际渲染的配色，对应 tokens.css 中的五套主题。 */
export type ChromeTheme = 'bluestone' | 'obsidian' | 'paper' | 'tundra' | 'slate'

interface ChromePalette {
  /** 窗口底色（`--chrome`），也是启动时的 backgroundColor。 */
  readonly chrome: string
  /** 纸面（`--paper`），系统按钮覆盖层要与右上角纸面无缝衔接。 */
  readonly paper: string
  /** 系统按钮图形颜色（`--fg2`）。 */
  readonly symbol: string
}

/** 与 tokens.css 中每套主题的 `--chrome`、`--paper`、`--fg2` 保持一致。 */
const CHROME_PALETTES: Record<ChromeTheme, ChromePalette> = {
  bluestone: { chrome: '#0b0d0f', paper: '#101317', symbol: '#c3ccd5' },
  obsidian: { chrome: '#08090a', paper: '#0e0f11', symbol: '#c2bfb8' },
  paper: { chrome: '#e6dccb', paper: '#fbf7ee', symbol: '#3c362a' },
  tundra: { chrome: '#e7ebe5', paper: '#ffffff', symbol: '#414a41' },
  slate: { chrome: '#0a0c10', paper: '#0f1217', symbol: '#c5cbd7' },
}

/** 把设置中的主题（含 `system` 与旧值）解析成实际配色。 */
export function resolveChromeTheme(theme: Theme | undefined, dark: boolean): ChromeTheme {
  switch (theme) {
    case 'bluestone':
    case 'obsidian':
    case 'paper':
    case 'tundra':
    case 'slate':
      return theme
    case 'light':
      return 'tundra'
    case 'dark':
    case 'graphite':
      return 'obsidian'
    default:
      return dark ? 'slate' : 'paper'
  }
}

export interface TitleBarOverlay {
  readonly color: string
  readonly symbolColor: string
  readonly height: number
}

export function titleBarOverlay(theme: ChromeTheme): TitleBarOverlay {
  const palette = CHROME_PALETTES[theme]
  return {
    color: palette.paper,
    symbolColor: palette.symbol,
    height: TITLE_BAR_HEIGHT,
  }
}

export interface WindowChromeOptions {
  readonly titleBarStyle: 'hidden' | 'hiddenInset'
  readonly titleBarOverlay?: TitleBarOverlay
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
  readonly backgroundColor: string
  readonly minWidth: number
  readonly minHeight: number
}

/**
 * 创建窗口时的外观选项；`dark` 为当前是否使用深色（避免启动时闪一下浅色底）。
 * `headless`：Chromium 以 `--ozone-platform=headless` 运行（冒烟测试），此时不能用 titleBarOverlay（Electron 会崩溃）。
 */
export function windowChromeOptions(
  platform: string,
  theme: ChromeTheme,
  headless = false,
): WindowChromeOptions {
  const palette = CHROME_PALETTES[theme]
  const base = {
    backgroundColor: palette.chrome,
    minWidth: 640,
    minHeight: 480,
  }
  if (platform === 'darwin') {
    return { ...base, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
  }
  if (headless) return { ...base, titleBarStyle: 'hidden' }
  return { ...base, titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(theme) }
}

/** 主题变化后是否需要更新系统按钮的颜色（只有使用 titleBarOverlay 的平台需要）。 */
export const usesTitleBarOverlay = (platform: string, headless = false): boolean =>
  platform !== 'darwin' && !headless
