/**
 * 对话列贴底滚动（M2-05）：内容变高时（新消息、流式输出、审批卡片出现），如果之前停在底部附近，就跟着滚到
 * 最底下，让最新的内容（例如审批卡片）完整地停在输入框上方；用户往上翻看时不打扰。切换会话时回到底部。
 */
import { useEffect, useRef, type RefObject } from 'react'

/** 离底部不超过这个距离（px）算“停在底部”。 */
const THRESHOLD = 48

export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  key: string,
): void {
  const pinned = useRef(true)

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    pinned.current = true
    const toBottom = () => {
      el.scrollTop = el.scrollHeight
    }
    toBottom()
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver === 'undefined')
      return () => el.removeEventListener('scroll', onScroll)
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom()
    })
    observer.observe(inner)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [scroller, content, key])
}
