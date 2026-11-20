/**
 * 对话列贴底滚动（M2-05）：内容变高时（新消息、流式输出、审批卡片出现），如果之前停在底部附近，就跟着滚到
 * 最底下，让最新的内容（例如审批卡片）完整地停在输入框上方；用户往上翻看时不打扰。切换会话时回到底部。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** 离底部不超过这个距离（px）算“停在底部”。 */
const THRESHOLD = 48

/** 一帧内长高超过这个像素就缓动过去（大约两行）：更小的增长是流式输出，直接贴底。 */
const SMOOTH_GROWTH = 40

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
    let lastTop = el.scrollTop
    const toBottom = () => {
      el.scrollTop = el.scrollHeight
      lastTop = el.scrollTop
    }
    toBottom()

    // 整块内容（失败提示、审批卡片）一次出现时内容会连着长几次，直接跳到底会让人眼前一花：
    // 用自适应缓动逐帧追到底部。滚动仍由我们自己驱动，不受浏览器平滑滚动被重排打断的影响。
    let following = false
    let frame = 0
    let lastHeight = el.scrollHeight
    const step = () => {
      // 能滚到的最远处是内容高度减去可视高度；直接拿 scrollHeight 算差值会一步冲过头
      const target = el.scrollHeight - el.clientHeight
      const gap = target - el.scrollTop
      if (gap <= 1) {
        following = false
        frame = 0
        toBottom()
        return
      }
      // 每帧收掉一部分距离，还差得多就多走一点，收尾时不至于一顿一顿
      el.scrollTop += Math.max(gap * 0.4, 4)
      lastTop = el.scrollTop
      frame = requestAnimationFrame(step)
    }
    const stopFollowing = () => {
      following = false
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
    }
    const followBottom = () => {
      following = true
      if (frame === 0) frame = requestAnimationFrame(step)
    }

    const onScroll = () => {
      const top = el.scrollTop
      // 缓动期间的中间位置离底部很远，那不是用户在往上翻；但位置往回退就是（拖滚动条也算）。
      if (following && top < lastTop) stopFollowing()
      lastTop = top
      if (following) return
      const atBottom = el.scrollHeight - top - el.clientHeight <= THRESHOLD
      if (pinned.current !== atBottom) {
        updatePinned(atBottom)
      }
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || !pinned.current) return
      // 内容不足一屏时滚轮并不会真的滚动，不应因此解除贴底（否则会冒出一个无处可去的“回到底部”按钮）。
      if (el.scrollHeight - el.clientHeight <= THRESHOLD) return
      // 向上滚动时立即解除贴底，防止流式输出频繁重绘与用户抢滚轮
      stopFollowing()
      updatePinned(false)
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
      const growth = el.scrollHeight - lastHeight
      lastHeight = el.scrollHeight
      if (pinned.current) {
        // 一次长了一大块，或者正在缓动（这一串增长还没追完）：缓动过去；
        // 流式输出每帧只涨几个像素，仍然即时贴底。
        if (following || growth >= SMOOTH_GROWTH) followBottom()
        else toBottom()
      } else if (el.scrollHeight - el.clientHeight <= THRESHOLD) {
        // 内容缩到不足一屏（例如切换/删除消息）时已经没有可滚的余地，重新贴底。
        updatePinned(true)
      }
    })
    observer.observe(inner)
    observer.observe(el)

    return () => {
      stopFollowing()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [scroller, content, key, updatePinned])

  return { isPinned, scrollToBottom }
}
