/**
 * 窗口缩放（桌面手感）：⌘+ / ⌘- / ⌘0（Windows/Linux 用 Ctrl）。
 *
 * 缩放走 `webContents` 的缩放级别，0 是实际大小，每档 0.5，范围 ±3（相当于 50%～约 320%）。
 * 纯逻辑，不依赖 Electron，便于测试；按键事件由窗口的 `before-input-event` 转进来。
 */

export type ZoomAction = 'in' | 'out' | 'reset'

export const MIN_ZOOM_LEVEL = -3
export const MAX_ZOOM_LEVEL = 3
export const ZOOM_STEP = 0.5

/** 保存的缩放级别可能来自旧版本或被改坏：夹到范围内并对齐半档。 */
export function clampZoomLevel(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 0
  const stepped = Math.round(level / ZOOM_STEP) * ZOOM_STEP
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, stepped))
}

/** 当前级别按动作变化后的级别。 */
export function nextZoomLevel(current: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  return clampZoomLevel(current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP))
}

/** `before-input-event` 里用得到的部分。 */
export interface ZoomInput {
  readonly type?: string
  readonly key: string
  readonly control: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

const isMacPlatform = (platform: string): boolean =>
  platform === 'darwin' || platform.toLowerCase().startsWith('mac')

/**
 * 按键对应的缩放动作；不是缩放键时返回 undefined。
 * 接受 `=` 与 `+`（Shift+= 在多数布局上给出 `+`），`-`，`0`。不处理 Alt 组合，避免和输入法冲突。
 */
export function zoomActionFor(input: ZoomInput, platform: string): ZoomAction | undefined {
  if (input.type !== undefined && input.type !== 'keyDown') return undefined
  const mod = isMacPlatform(platform) ? input.meta : input.control
  if (!mod || input.alt) return undefined
  if (input.key === '=' || input.key === '+') return 'in'
  if (input.key === '-') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}
