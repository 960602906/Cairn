/**
 * 无边框窗口（M2-02，视觉规范 §2）：窗口自己画标题区，侧栏铺在窗口底色上。
 *
 * - macOS：`hiddenInset`，红绿灯放在侧栏左上角；
 * - Windows / Linux：`hidden` + `titleBarOverlay`，系统按钮叠在窗口右上角，颜色随主题（`--chrome` 与 `--fg2`）。
 *   界面用 CSS `env(titlebar-area-*)` 给按钮让出位置。
 *
 * 纯函数，不依赖 Electron，便于测试。
 */

/** 标题区高度：侧栏顶部的拖拽区与系统按钮的高度。 */
export const TITLE_BAR_HEIGHT = 40

/** 与 tokens.css 中的 `--chrome`、`--fg2` 一致。 */
const CHROME = { light: '#eeeff2', dark: '#141416' } as const
const SYMBOL = { light: '#45474f', dark: '#bfc0c6' } as const

export interface TitleBarOverlay {
  readonly color: string
  readonly symbolColor: string
  readonly height: number
}

export function titleBarOverlay(dark: boolean): TitleBarOverlay {
  return {
    color: dark ? CHROME.dark : CHROME.light,
    symbolColor: dark ? SYMBOL.dark : SYMBOL.light,
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
  dark: boolean,
  headless = false,
): WindowChromeOptions {
  const base = {
    backgroundColor: dark ? CHROME.dark : CHROME.light,
    minWidth: 640,
    minHeight: 480,
  }
  if (platform === 'darwin') {
    return { ...base, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
  }
  if (headless) return { ...base, titleBarStyle: 'hidden' }
  return { ...base, titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) }
}

/** 主题变化后是否需要更新系统按钮的颜色（只有使用 titleBarOverlay 的平台需要）。 */
export const usesTitleBarOverlay = (platform: string, headless = false): boolean =>
  platform !== 'darwin' && !headless
