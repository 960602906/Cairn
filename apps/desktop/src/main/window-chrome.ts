/**
 * 无边框窗口（M2-02，视觉规范 §2）：窗口自己画标题区，侧栏铺在窗口底色上。
 *
 * - macOS：`hiddenInset`，红绿灯放在侧栏左上角；
 * - Windows / Linux：`hidden`，右上角按钮由界面自绘（见渲染进程 `WindowControls`），不再使用
 *   `titleBarOverlay`。原生覆盖层会浮在应用弹窗遮罩之上，无法跟主题和遮罩一起变化。
 *
 * 纯函数，不依赖 Electron，便于测试。
 */
import type { Theme } from '@cairn/protocol'

/** 实际渲染的配色，对应 tokens.css 中的五套主题。 */
export type ChromeTheme = 'bluestone' | 'obsidian' | 'paper' | 'tundra' | 'slate'

interface ChromePalette {
  /** 窗口底色（`--chrome`），也是启动时的 backgroundColor。 */
  readonly chrome: string
}

/** 与 tokens.css 中每套主题的 `--chrome` 保持一致。 */
const CHROME_PALETTES: Record<ChromeTheme, ChromePalette> = {
  bluestone: { chrome: '#0b0d0f' },
  obsidian: { chrome: '#08090a' },
  paper: { chrome: '#e6dccb' },
  tundra: { chrome: '#e7ebe5' },
  slate: { chrome: '#0a0c10' },
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

export interface WindowChromeOptions {
  readonly titleBarStyle: 'hidden' | 'hiddenInset'
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
  readonly backgroundColor: string
  readonly minWidth: number
  readonly minHeight: number
}

/** 创建窗口时的外观选项；`dark` 为当前是否使用深色（避免启动时闪一下浅色底）。 */
export function windowChromeOptions(platform: string, theme: ChromeTheme): WindowChromeOptions {
  const palette = CHROME_PALETTES[theme]
  const base = {
    backgroundColor: palette.chrome,
    minWidth: 640,
    minHeight: 480,
  }
  if (platform === 'darwin') {
    return { ...base, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
  }
  return { ...base, titleBarStyle: 'hidden' }
}

/** Windows / Linux 使用自绘窗口按钮；macOS 使用系统红绿灯。 */
export const usesCustomWindowControls = (platform: string): boolean => platform !== 'darwin'
