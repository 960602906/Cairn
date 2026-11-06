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

  it('still scrolls to the bottom once without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { getByTestId } = render(<Harness id="a" />)
    expect(getByTestId('scroller').scrollTop).toBe(0)
  })
})
