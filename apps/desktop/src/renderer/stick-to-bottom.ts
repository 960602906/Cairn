/**
 * 对话列贴底滚动（M2-05）：内容变高时（新消息、流式输出、审批卡片出现），如果之前停在底部附近，就跟着滚到
 * 最底下，让最新的内容（例如审批卡片）完整地停在输入框上方；用户往上翻看时不打扰。切换会话时回到底部。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** 离底部不超过这个距离（px）算“停在底部”。 */
const THRESHOLD = 48

export interface StickToBottomResult {
  readonly isPinned: boolean
  readonly scrollToBottom: (smooth?: boolean) => void
}

export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  key: string,
): StickToBottomResult {
  const pinned = useRef(true)
  const [isPinned, setIsPinned] = useState(true)

  const updatePinned = useCallback((next: boolean) => {
    pinned.current = next
    setIsPinned(next)
  }, [])

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = scroller.current
      if (!el) return
      updatePinned(true)
      if (smooth && typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      } else {
        el.scrollTop = el.scrollHeight
      }
    },
    [scroller, updatePinned],
  )

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    updatePinned(true)
    const toBottom = () => {
      el.scrollTop = el.scrollHeight
    }
    toBottom()

    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD
      if (pinned.current !== atBottom) {
        updatePinned(atBottom)
      }
    }

    const onWheel = (event: WheelEvent) => {
      // 向上滚动时立即解除贴底，防止流式输出频繁重绘与用户抢滚轮
      if (event.deltaY < 0 && pinned.current) {
        updatePinned(false)
      }
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        el.removeEventListener('scroll', onScroll)
        el.removeEventListener('wheel', onWheel)
      }
    }

    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom()
    })
    observer.observe(inner)
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [scroller, content, key, updatePinned])

  return { isPinned, scrollToBottom }
}
