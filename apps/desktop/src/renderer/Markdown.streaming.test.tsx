// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown.js'

afterEach(() => {
  cleanup()
})

/** 去掉块之间的空白文本节点：整段渲染时 react-markdown 会在块与块之间插入换行。 */
const html = (element: HTMLElement) => element.innerHTML.replace(/>\s+</g, '><')

describe('Markdown 流式分块', () => {
  it('按块渲染的结果与整段渲染相同', () => {
    const text = [
      '# 标题',
      '',
      '第一段',
      '',
      '```ts',
      'const a = 1',
      '',
      'const b = 2',
      '```',
      '',
      '- 一',
      '- 二',
      '',
      '最后一段',
      '',
      '还在写',
    ].join('\n')
    const whole = html(render(<Markdown text={text} />).container)
    cleanup()
    const streamed = html(render(<Markdown text={text} streaming />).container)
    expect(streamed).toBe(whole)
  })

  it('追加文字后，已有的块保持原位，只更新最后一块', () => {
    const { container, rerender } = render(<Markdown text={'第一段\n\n第二段\n\n第三'} streaming />)
    const first = container.querySelector('p')
    rerender(<Markdown text={'第一段\n\n第二段\n\n第三段还在写'} streaming />)
    expect(container.querySelector('p')).toBe(first)
    expect(container.textContent).toContain('第三段还在写')
  })
})
