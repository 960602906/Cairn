/**
 * 可拖动宽度的侧栏：左栏和右侧会话信息栏共用。
 *
 * 宽度记在 localStorage 里（只是界面偏好，不进设置）。拖动分隔条、方向键微调、双击恢复默认。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { cn } from '../ui/index.js'

export interface ResizableOptions {
  readonly storageKey: string
  readonly initial: number
  readonly min: number
  readonly max: number
  /** 分隔条在栏的哪一侧：在右侧时向右拖变宽，在左侧时向左拖变宽。 */
  readonly edge: 'left' | 'right'
}

const KEY_STEP = 16

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)))

function readWidth({ storageKey, initial, min, max }: ResizableOptions): number {
  try {
    const stored = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : initial
  } catch {
    return initial
  }
}

export function useResizableWidth(options: ResizableOptions) {
  const { storageKey, initial, min, max, edge } = options
  const [width, setWidth] = useState(() => readWidth(options))
  const [dragging, setDragging] = useState(false)
  const stop = useRef<(() => void) | undefined>(undefined)

  const commit = useCallback(
    (next: number) => {
      const value = clamp(next, min, max)
      setWidth(value)
      try {
        window.localStorage.setItem(storageKey, String(value))
      } catch {
        // 存不进去只是下次启动不记得宽度。
      }
    },
    [max, min, storageKey],
  )

  // 拖到一半组件卸载时也要摘掉窗口上的监听。
  useEffect(() => () => stop.current?.(), [])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const start = width
    const move = (moved: globalThis.PointerEvent) => {
      const delta = moved.clientX - startX
      commit(start + (edge === 'right' ? delta : -delta))
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stop.current = undefined
      setDragging(false)
    }
    stop.current = end
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    setDragging(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const grow = (event.key === 'ArrowRight') === (edge === 'right')
    commit(width + (grow ? KEY_STEP : -KEY_STEP))
  }

  return {
    width,
    dragging,
    handleProps: {
      edge,
      dragging,
      value: width,
      min,
      max,
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => commit(initial),
    },
  }
}

/** 贴在栏边缘的分隔条：平时看不见，悬停或拖动时显示一条细线。 */
export function ResizeHandle({
  label,
  edge,
  dragging,
  value,
  min,
  max,
  onPointerDown,
  onKeyDown,
  onDoubleClick,
}: ReturnType<typeof useResizableWidth>['handleProps'] & { readonly label: string }) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'no-drag group/resize absolute inset-y-0 z-30 w-[7px] cursor-col-resize touch-none outline-none',
        edge === 'right' ? '-right-[3px]' : '-left-[3px]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-[3px] w-px transition-colors group-hover/resize:bg-hair2 group-focus-visible/resize:bg-accent',
          dragging ? 'bg-accent' : 'bg-transparent',
        )}
      />
    </div>
  )
}
