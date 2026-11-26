/**
 * 窗口状态（桌面手感）：记住窗口大小、位置、是否最大化和缩放级别，下次启动原样恢复。
 *
 * 保存在 `<userData>/window-state.json`，与 `settings.json` 分开：它是每台机器 / 每个窗口的
 * 状态，不是用户偏好，也不需要走 `settings.get` 的协议。文件不存在、不是 JSON 或字段无效时
 * 按默认值处理，不阻止启动；非法位置（保存的屏幕已经拔掉）只保留大小，位置交回系统。
 *
 * 写入先写临时文件再改名，退出中途不会留下半个文件；窗口拖动 / 缩放期间做短暂合并，
 * 关闭窗口前 `flush()` 立即落盘。不依赖 Electron，显示器信息由调用方传入。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { clampZoomLevel } from '../window-zoom.js'

/** 窗口默认大小（与原先的固定值一致）。 */
export const DEFAULT_WINDOW_WIDTH = 1200
export const DEFAULT_WINDOW_HEIGHT = 800
/** 与 window-chrome.ts 的最小尺寸保持一致。 */
export const MIN_WINDOW_WIDTH = 640
export const MIN_WINDOW_HEIGHT = 480
/** 窗口至少要有这么多像素落在某块屏幕里，才认为保存的位置仍然可用。 */
export const MIN_VISIBLE_PIXELS = 80

export interface WindowArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowState {
  readonly width: number
  readonly height: number
  /** 省略时交给系统放置（首次启动或保存的位置已不可见）。 */
  readonly x?: number
  readonly y?: number
  readonly maximized: boolean
  readonly zoomLevel: number
}

export interface WindowStateService {
  get(): WindowState
  update(state: WindowState): void
  /** 立即写入（关闭窗口前调用）。 */
  flush(): void
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** 读取磁盘上的原始状态；无效字段被忽略。 */
export function parseWindowState(value: unknown): WindowState {
  const record = isRecord(value) ? value : {}
  const width = finite(record['width'])
  const height = finite(record['height'])
  const x = finite(record['x'])
  const y = finite(record['y'])
  return {
    width: width === undefined ? DEFAULT_WINDOW_WIDTH : Math.round(width),
    height: height === undefined ? DEFAULT_WINDOW_HEIGHT : Math.round(height),
    ...(x === undefined || y === undefined ? {} : { x: Math.round(x), y: Math.round(y) }),
    maximized: record['maximized'] === true,
    zoomLevel: clampZoomLevel(finite(record['zoomLevel'])),
  }
}

/** 保存的位置是否还能看见：与至少一块屏幕的工作区有足够的重叠。 */
function intersects(area: WindowArea, state: WindowState): boolean {
  const x = state.x ?? 0
  const y = state.y ?? 0
  const overlapX = Math.min(x + state.width, area.x + area.width) - Math.max(x, area.x)
  const overlapY = Math.min(y + state.height, area.y + area.height) - Math.max(y, area.y)
  return overlapX >= MIN_VISIBLE_PIXELS && overlapY >= MIN_VISIBLE_PIXELS
}

/**
 * 把保存的状态整理成可以交给 BrowserWindow 的值：大小夹在最小尺寸与最大屏幕之间，
 * 位置不可见时去掉 x / y，缩放级别夹到合法范围。
 */
export function restoreWindowState(
  state: WindowState,
  displays: readonly WindowArea[],
): WindowState {
  let maxWidth = 0
  let maxHeight = 0
  for (const display of displays) {
    maxWidth = Math.max(maxWidth, display.width)
    maxHeight = Math.max(maxHeight, display.height)
  }
  if (maxWidth === 0) maxWidth = DEFAULT_WINDOW_WIDTH
  if (maxHeight === 0) maxHeight = DEFAULT_WINDOW_HEIGHT
  const width = clamp(
    Math.round(state.width),
    MIN_WINDOW_WIDTH,
    Math.max(MIN_WINDOW_WIDTH, maxWidth),
  )
  const height = clamp(
    Math.round(state.height),
    MIN_WINDOW_HEIGHT,
    Math.max(MIN_WINDOW_HEIGHT, maxHeight),
  )
  const candidate: WindowState = { ...state, width, height }
  const visible =
    state.x !== undefined && state.y !== undefined
      ? displays.some((display) => intersects(display, candidate))
      : false
  return {
    width,
    height,
    ...(visible && state.x !== undefined && state.y !== undefined
      ? { x: state.x, y: state.y }
      : {}),
    maximized: state.maximized,
    zoomLevel: clampZoomLevel(state.zoomLevel),
  }
}

export interface CreateWindowStateServiceOptions {
  readonly file: string
  /** 合并写入的等待时间；测试可以调小。 */
  readonly delayMs?: number
  readonly onError?: (error: unknown) => void
}

export function createWindowStateService(
  options: CreateWindowStateServiceOptions,
): WindowStateService {
  const { file, delayMs = 400 } = options
  let state = readState(file, options.onError)
  let serialized = JSON.stringify(state)
  let timer: ReturnType<typeof setTimeout> | undefined

  function write(): void {
    timer = undefined
    const next = JSON.stringify(state)
    if (next === serialized) return
    const temp = `${file}.tmp`
    try {
      writeFileSync(temp, next)
      renameSync(temp, file)
      serialized = next
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    get: () => state,
    update(next) {
      state = next
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (JSON.stringify(next) === serialized) return
      timer = setTimeout(write, delayMs)
      timer.unref?.()
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      write()
    },
  }
}

function readState(file: string, onError: ((error: unknown) => void) | undefined): WindowState {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error)
    return parseWindowState(undefined)
  }
  try {
    return parseWindowState(JSON.parse(text))
  } catch (error) {
    onError?.(error)
    return parseWindowState(undefined)
  }
}
