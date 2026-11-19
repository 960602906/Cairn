// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from './stick-to-bottom.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Harness({ id }: { readonly id: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useStickToBottom(scroller, content, id)
  return (
    <div data-testid="scroller" ref={scroller}>
      <div ref={content} />
    </div>
  )
}

/** jsdom 没有布局：用可写的尺寸模拟滚动容器。 */
function layout(el: HTMLElement, size: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => size.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => size.clientHeight })
}

describe('useStickToBottom', () => {
  it('follows growing content while at the bottom, not after scrolling up', () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    const size = { scrollHeight: 0, clientHeight: 300 }
    const proto = HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => size.scrollHeight,
    })
    try {
      const { getByTestId, rerender } = render(<Harness id="a" />)
      const el = getByTestId('scroller')
      layout(el, size)
      const grow = (height: number) => {
        size.scrollHeight = height
        act(() => callbacks.at(-1)!())
      }
      grow(1000)
      expect(el.scrollTop).toBe(1000)

      // 往上翻看：内容再变高也不动
      el.scrollTop = 200
      el.dispatchEvent(new Event('scroll'))
      grow(1200)
      expect(el.scrollTop).toBe(200)

      // 回到底部附近又会跟随
      el.scrollTop = 1200 - 300 - 20
      el.dispatchEvent(new Event('scroll'))
      grow(1500)
      expect(el.scrollTop).toBe(1500)

      // 切换会话回到底部
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
      rerender(<Harness id="b" />)
      expect(el.scrollTop).toBe(1500)
    } finally {
      if (original) Object.defineProperty(proto, 'scrollHeight', original)
      else delete (proto as { scrollHeight?: number }).scrollHeight
    }
  })

  it('unpins when wheel scrolls up and provides scrollToBottom', () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    const size = { scrollHeight: 1000, clientHeight: 300 }
    const proto = HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => size.scrollHeight,
    })
    try {
      const { getByTestId } = render(<Harness id="a" />)
      const el = getByTestId('scroller')
      layout(el, size)
      el.scrollTop = 700

      // 向上滚轮（deltaY < 0）
      const wheelEvent = new Event('wheel') as Event & { deltaY: number }
      Object.defineProperty(wheelEvent, 'deltaY', { value: -50 })
      el.dispatchEvent(wheelEvent)

      // 即使高度增加，也不再强行拉回底部
      size.scrollHeight = 1400
      act(() => callbacks.at(-1)!())
      expect(el.scrollTop).toBe(700)
    } finally {
      if (original) Object.defineProperty(proto, 'scrollHeight', original)
      else delete (proto as { scrollHeight?: number }).scrollHeight
    }
  })

  it('still scrolls to the bottom once without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { getByTestId } = render(<Harness id="a" />)
    expect(getByTestId('scroller').scrollTop).toBe(0)
  })

  it('stays pinned when the content fits and the wheel cannot actually scroll', () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    let pinned: boolean | undefined
    const Capture = () => {
      const scroller = useRef<HTMLDivElement>(null)
      const content = useRef<HTMLDivElement>(null)
      pinned = useStickToBottom(scroller, content, 'a').isPinned
      return (
        <div data-testid="scroller" ref={scroller}>
          <div ref={content} />
        </div>
      )
    }
    const { getByTestId } = render(<Capture />)
    const el = getByTestId('scroller')
    // 内容不足一屏：没有滚动条。
    layout(el, { scrollHeight: 300, clientHeight: 300 })

    const wheelEvent = new Event('wheel') as Event & { deltaY: number }
    Object.defineProperty(wheelEvent, 'deltaY', { value: -50 })
    act(() => {
      el.dispatchEvent(wheelEvent)
    })
    // 滚轮不会真的滚动，不应该解除贴底（否则会冒出一个没用的“回到底部”按钮）。
    expect(pinned).toBe(true)

    // 内容长起来后仍然跟着滚到底。
    layout(el, { scrollHeight: 900, clientHeight: 300 })
    act(() => callbacks.at(-1)!())
    expect(el.scrollTop).toBe(900)
  })

  it('repins when content shrinks back to fit without scrolling', () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    let pinned: boolean | undefined
    const Capture = () => {
      const scroller = useRef<HTMLDivElement>(null)
      const content = useRef<HTMLDivElement>(null)
      pinned = useStickToBottom(scroller, content, 'a').isPinned
      return (
        <div data-testid="scroller" ref={scroller}>
          <div ref={content} />
        </div>
      )
    }
    const { getByTestId } = render(<Capture />)
    const el = getByTestId('scroller')
    layout(el, { scrollHeight: 1000, clientHeight: 300 })
    el.scrollTop = 100
    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })
    expect(pinned).toBe(false)

    // 消息被删掉或会话内容变短：没有可滚的余地了，恢复贴底。
    layout(el, { scrollHeight: 300, clientHeight: 300 })
    act(() => callbacks.at(-1)!())
    expect(pinned).toBe(true)
  })

  it('scrollToBottom prefers smooth scrolling and falls back to scrollTop', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    let scrollToBottom: ((smooth?: boolean) => void) | undefined
    const Capture = () => {
      const scroller = useRef<HTMLDivElement>(null)
      const content = useRef<HTMLDivElement>(null)
      const result = useStickToBottom(scroller, content, 'a')
      scrollToBottom = result.scrollToBottom
      return (
        <div data-testid="scroller" ref={scroller}>
          <div ref={content} />
        </div>
      )
    }
    const { getByTestId } = render(<Capture />)
    const el = getByTestId('scroller')
    layout(el, { scrollHeight: 500, clientHeight: 200 })
    const smooth = vi.fn()
    Object.defineProperty(el, 'scrollTo', { configurable: true, value: smooth })

    // 默认平滑滚动
    act(() => scrollToBottom!())
    expect(smooth).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' })

    // 明确要求不平滑时直接设置 scrollTop
    el.scrollTop = 0
    act(() => scrollToBottom!(false))
    expect(el.scrollTop).toBe(500)

    // 没有 scrollTo 时退化为直接设置 scrollTop
    Object.defineProperty(el, 'scrollTo', { configurable: true, value: undefined })
    el.scrollTop = 0
    act(() => scrollToBottom!())
    expect(el.scrollTop).toBe(500)
  })

  it('does nothing when the scroller is not mounted', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    let scrollToBottom: ((smooth?: boolean) => void) | undefined
    const Missing = () => {
      const scroller = useRef<HTMLDivElement>(null)
      const content = useRef<HTMLDivElement>(null)
      const result = useStickToBottom(scroller, content, 'missing')
      scrollToBottom = result.scrollToBottom
      return <div ref={content} />
    }
    render(<Missing />)
    expect(() => act(() => scrollToBottom!())).not.toThrow()
  })
})
