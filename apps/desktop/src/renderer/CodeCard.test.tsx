// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { CodeCard, parseLineRanges } from './CodeCard.js'
import { COPIED_MS } from './CopyButton.js'
import { languageByName } from './languages.js'
import { codeBlockOf, Markdown } from './Markdown.js'

const i18n = createI18n('zh-CN')
const wrap = (ui: ReactNode) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

let writeText: ReturnType<typeof vi.fn>
/** user-event 会换掉 navigator.clipboard，所以在它之后再放入假的剪贴板。 */
function setupUser(options?: Parameters<typeof userEvent.setup>[0]) {
  const user = userEvent.setup(options)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return user
}
beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const lineNumbers = (card: HTMLElement) =>
  [...card.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'))

describe('parseLineRanges', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['title="a.ts"', []],
    ['{3}', [3]],
    ['{1, 4-6}', [1, 4, 5, 6]],
    ['{0,2-}', [2]],
  ])('%s', (meta, lines) => {
    expect([...parseLineRanges(meta)]).toEqual(lines)
  })
})

describe('CodeCard', () => {
  it('标题栏：路径（目录与文件名）、新文件、增删数；行号从 startLine 开始', () => {
    wrap(
      <CodeCard
        code={'a\r\nb\n'}
        path="src/util/sum.ts"
        language={languageByName('ts')}
        startLine={9}
        isNew
        added={3}
        removed={1}
      />,
    )
    const card = screen.getByRole('figure', { name: '代码：src/util/sum.ts' })
    expect(within(card).getByText('src/util/').className).toContain('text-muted')
    expect(within(card).getByText('sum.ts').className).toContain('font-semibold')
    expect(within(card).getByText('新文件')).toBeTruthy()
    expect(within(card).getByText('+3')).toBeTruthy()
    expect(within(card).getByText('−1')).toBeTruthy()
    expect(within(card).getByText('TS')).toBeTruthy()
    expect(lineNumbers(card)).toEqual(['9', '10'])
  })

  it('没有路径时显示语言名，未知语言按纯文本；行号不可选中', () => {
    wrap(<CodeCard code="x" languageName="brainfuck" />)
    const card = screen.getByRole('figure', { name: '代码：brainfuck' })
    expect(within(card).getByText('TXT')).toBeTruthy()
    const gutter = card.querySelector('[data-line] > span')!
    expect(gutter.className).toContain('select-none')
    expect(gutter.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    wrap(<CodeCard code="x" />)
    expect(screen.getByRole('figure', { name: '代码：文本' })).toBeTruthy()
    cleanup()
    wrap(<CodeCard code={'1\n'.repeat(10_000)} />)
    expect(screen.getByRole('figure').querySelector('[data-line] > span')!.className).toContain(
      'w-[58px]',
    )
  })

  it('重点行带标记，行号变为强调色', () => {
    wrap(<CodeCard code={'a\nb\nc'} highlightLines={new Set([2])} />)
    const marked = document.querySelector('[data-line="2"]')!
    expect(marked.getAttribute('data-highlighted')).toBe('true')
    expect(marked.firstElementChild!.className).toContain('text-accent')
    expect(document.querySelector('[data-line="1"]')!.hasAttribute('data-highlighted')).toBe(false)
  })

  it('高亮完成后按令牌着色', async () => {
    wrap(<CodeCard code="const a = 1" language={languageByName('ts')} />)
    await waitFor(() => {
      expect(screen.getByText('const').getAttribute('style')).toContain('var(--tk-k)')
    })
  })

  it('换行开关', async () => {
    const user = setupUser()
    wrap(<CodeCard code="long line" />)
    const toggle = screen.getByRole('button', { name: '换行' })
    const body = () => document.querySelector('[data-line] > span:last-child')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(body().className).toContain('whitespace-pre')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(body().className).toContain('whitespace-pre-wrap')
  })

  it('复制不带行号，显示“已复制”1.6 秒', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = setupUser({ advanceTimers: vi.advanceTimersByTime })
    wrap(<CodeCard code={'a\nb\n'} />)
    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('a\nb')
    act(() => vi.advanceTimersByTime(COPIED_MS))
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('剪贴板不可用时不提示', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const user = setupUser()
    wrap(<CodeCard code="a" />)
    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull()
  })
})

describe('Markdown 代码块（M2-06）', () => {
  it('代码块用代码卡片：语言、重点行；行内代码不变', async () => {
    wrap(<Markdown text={'用 `x`\n\n```ts {2}\nconst a = 1\nconst b = 2\n```'} />)
    const card = screen.getByRole('figure', { name: '代码：ts' })
    expect(lineNumbers(card)).toEqual(['1', '2'])
    expect(card.querySelector('[data-line="2"]')!.getAttribute('data-highlighted')).toBe('true')
    expect(screen.getByText('x').tagName).toBe('CODE')
    await waitFor(() => expect(within(card).getAllByText('const')[0]!.getAttribute('style')).toBeTruthy())
  })

  it('没有语言的代码块', () => {
    wrap(<Markdown text={'```\nplain\n```'} />)
    expect(screen.getByRole('figure', { name: '代码：文本' })).toBeTruthy()
  })

  it('结构不是 pre > code 时退回普通的 pre', () => {
    expect(codeBlockOf(undefined)).toBeUndefined()
    expect(
      codeBlockOf({
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [{ type: 'element', tagName: 'span', properties: {}, children: [] }],
      }),
    ).toBeUndefined()
    expect(
      codeBlockOf({
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [
          {
            type: 'element',
            tagName: 'code',
            properties: { className: ['x'] },
            children: [
              { type: 'element', tagName: 'b', properties: {}, children: [{ type: 'text', value: 'a' }] },
              { type: 'comment', value: 'c' },
            ],
          },
        ],
      }),
    ).toEqual({ lang: undefined, highlightLines: new Set(), text: 'a' })
  })
})
