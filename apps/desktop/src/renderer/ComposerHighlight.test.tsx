// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerHighlight } from './ComposerHighlight.js'

afterEach(cleanup)

function setup(text: string, clientWidth = 0) {
  const textarea = createRef<HTMLTextAreaElement>()
  const view = (value: string) => (
    <div>
      <textarea
        ref={(el) => {
          textarea.current = el
          if (el)
            Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true })
        }}
        defaultValue={value}
      />
      <ComposerHighlight text={value} commands={['plan']} textarea={textarea} className="px-1" />
    </div>
  )
  const result = render(view(text))
  const layer = result.container.querySelector<HTMLElement>('[data-composer-highlight]')
  if (!layer) throw new Error('highlight layer missing')
  return { ...result, layer, textarea, rerender: (value: string) => result.rerender(view(value)) }
}

describe('ComposerHighlight', () => {
  it('mirrors the draft and marks commands, urls and code', () => {
    const draft = '/plan 看 https://a.dev 和 `x`'
    const { layer } = setup(draft)
    expect(layer.textContent).toBe(draft)
    expect(layer.parentElement?.getAttribute('aria-hidden')).toBe('true')
    const marked = [...layer.querySelectorAll('[data-token]')].map((el) => [
      el.getAttribute('data-token'),
      el.textContent,
    ])
    expect(marked).toEqual([
      ['command', '/plan'],
      ['url', 'https://a.dev'],
      ['code', '`x`'],
    ])
    expect(layer.className).toContain('px-1')
  })

  it('follows the textarea width and scroll position', () => {
    const { layer, textarea, rerender } = setup('一行', 320)
    expect(layer.style.width).toBe('320px')
    expect(layer.style.transform).toBe('translateY(0px)')
    const input = textarea.current as HTMLTextAreaElement
    input.scrollTop = 48
    fireEvent.scroll(input)
    expect(layer.style.transform).toBe('translateY(-48px)')
    rerender('两行\n文字')
    expect(layer.textContent).toBe('两行\n文字')
  })

  it('leaves the width alone before layout and without a textarea', () => {
    expect(setup('草稿').layer.style.width).toBe('')
    cleanup()
    const { container } = render(
      <ComposerHighlight text="草稿" commands={[]} textarea={createRef<HTMLTextAreaElement>()} />,
    )
    expect(container.textContent).toBe('草稿')
  })
})
