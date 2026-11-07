// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  DIFF_MAX_ROWS,
  DiffCard,
  LineContent,
  SPLIT_MIN_WIDTH,
  type DiffCardProps,
} from './DiffCard.js'
import { languageByName } from './languages.js'

const i18n = createI18n('zh-CN')
const wrap = (ui: ReactNode) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const BEFORE = [
  'function f() {',
  '  let total = 1',
  '  return total',
  '}',
  ...Array(10).fill('// pad'),
  'end',
].join('\n')
const AFTER = BEFORE.replace('let total = 1', 'let total = 2').replace('end', 'end\nmore')

const card = (props: Partial<DiffCardProps> = {}) => {
  wrap(
    <DiffCard
      path="src/a.js"
      kind="modify"
      content={{ state: 'ready', before: BEFORE, after: AFTER }}
      added={0}
      removed={0}
      {...props}
    />,
  )
  return screen.getByRole('figure', { name: `差异：${props.path ?? 'src/a.js'}` })
}
const rows = (root: HTMLElement, type?: string) => [
  ...root.querySelectorAll<HTMLElement>(type ? `[data-type="${type}"]` : '[data-type]'),
]

describe('DiffCard：标题栏', () => {
  it('路径、按实际 diff 计算的增删数与比例方块', () => {
    const c = card({ added: 99, removed: 99 })
    expect(c.querySelector('figcaption')!.textContent).toContain('src/a.js+2 −1')
    const blocks = c.querySelectorAll('figcaption [aria-hidden] > span')
    expect([...blocks].map((b) => b.className.match(/bg-(ok|danger|hair2)/)![1])).toEqual([
      'ok',
      'ok',
      'ok',
      'danger',
      'danger',
    ])
  })

  it('新文件与已删除标记；二进制和过大的文件不显示增删数', () => {
    card({ kind: 'create', content: { state: 'binary' } })
    expect(screen.getByText('新文件')).toBeTruthy()
    expect(screen.getByText('二进制文件，不显示内容差异')).toBeTruthy()
    expect(screen.queryByText('+0')).toBeNull()
    cleanup()
    card({ kind: 'delete', content: { state: 'too_large' } })
    expect(screen.getByText('已删除')).toBeTruthy()
    expect(screen.getByText('文件太大，不显示差异')).toBeTruthy()
  })

  it('读取中显示改动记录的增删数；失败与没有变化', () => {
    card({ content: { state: 'loading' }, added: 3, removed: 1 })
    expect(screen.getByText('正在读取改动…')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'diff 视图' })).toBeNull()
    cleanup()
    card({ content: { state: 'error' } })
    expect(screen.getByText('无法读取改动内容')).toBeTruthy()
    cleanup()
    card({ content: { state: 'ready', before: 'same\n', after: 'same\r\n' } })
    expect(screen.getByText('内容没有变化')).toBeTruthy()
    cleanup()
    card({ kind: 'create', content: { state: 'ready', before: '', after: '' } })
    expect(screen.getByText('空文件')).toBeTruthy()
  })

  it('撤销此文件：传入 onRevert 才有，可以禁用', async () => {
    const onRevert = vi.fn()
    card({ onRevert })
    await userEvent.click(screen.getByRole('button', { name: '撤销此文件' }))
    expect(onRevert).toHaveBeenCalledOnce()
    cleanup()
    card({ onRevert, revertDisabled: true })
    expect((screen.getByRole('button', { name: '撤销此文件' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    cleanup()
    card()
    expect(screen.queryByRole('button', { name: '撤销此文件' })).toBeNull()
  })
})

describe('DiffCard：合并视图', () => {
  it('hunk 标题、行号、标记与词级着色；未改动的行折叠，点击展开', async () => {
    const c = card()
    expect(within(c).getByText('@@ -1,5 +1,5 @@')).toBeTruthy()
    expect(within(c).getByText(/^@@ -13,3 \+13,4 @@/).textContent).toBe(
      '@@ -13,3 +13,4 @@function f() {',
    )
    const del = rows(c, 'del')[0]!
    expect([...del.children].map((s) => s.textContent)).toEqual(['2', '', '−', '  let total = 1'])
    expect(del.querySelector('.bg-del-word')!.textContent).toBe('1')
    const add = rows(c, 'add')
    expect([...add[0]!.children].map((s) => s.textContent)).toEqual([
      '',
      '2',
      '+',
      '  let total = 2',
    ])
    expect(add[0]!.querySelector('.bg-add-word')!.textContent).toBe('2')
    expect(add[1]!.querySelector('.bg-add-word')).toBeNull()

    const contextBefore = rows(c, 'context').length
    await userEvent.click(within(c).getByRole('button', { name: '展开下方 7 行未改动的代码' }))
    expect(rows(c, 'context').length).toBe(contextBefore + 7)
  })

  it('一次最多显示 DIFF_MAX_ROWS 行，其余点击后显示', async () => {
    const big = Array.from({ length: DIFF_MAX_ROWS + 20 }, (_, i) => `l${i}`).join('\n')
    const c = card({ kind: 'create', content: { state: 'ready', before: '', after: big } })
    expect(rows(c)).toHaveLength(DIFF_MAX_ROWS)
    await userEvent.click(within(c).getByRole('button', { name: '显示其余 20 行' }))
    expect(rows(c)).toHaveLength(DIFF_MAX_ROWS + 20)
    expect(within(c).queryByRole('button', { name: /显示其余/ })).toBeNull()
  })

  it('行数用完时后面折叠的部分也算在“其余”里', async () => {
    const before = Array.from({ length: DIFF_MAX_ROWS + 50 }, (_, i) => `l${i}`)
    const after = before.map((l) => `${l}!`)
    after.push(...Array.from({ length: 10 }, (_, i) => `x${i}`))
    const c = card({
      content: {
        state: 'ready',
        before: [...before, ...Array(10).fill('z')].join('\n'),
        after: [...after, ...Array(10).fill('z')].join('\n'),
      },
    })
    expect(within(c).getByRole('button', { name: /显示其余/ })).toBeTruthy()
  })

  it('语法高亮后按令牌着色', async () => {
    const c = card({ language: languageByName('js') })
    await waitFor(() => {
      const keyword = [...c.querySelectorAll('span')].find((s) => s.textContent === 'function')
      expect(keyword?.getAttribute('style')).toContain('var(--tk-k)')
    })
  })
})

describe('DiffCard：分栏视图', () => {
  it('左旧右新，对侧没有对应行时用占位', async () => {
    const c = card()
    await userEvent.click(within(c).getByRole('button', { name: '分栏' }))
    expect(within(c).getByRole('button', { name: '分栏' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    const pair = rows(c, 'del')[0]!.parentElement!
    expect(pair.children).toHaveLength(3)
    expect(pair.children[2]!.getAttribute('data-type')).toBe('add')
    const lone = rows(c, 'add').at(-1)!.parentElement!
    expect(lone.children[0]!.className).toContain('repeating-linear-gradient')
    await userEvent.click(within(c).getByRole('button', { name: '合并' }))
    expect(rows(c, 'del')[0]!.children).toHaveLength(4)
  })

  it('卡片太窄时只用合并视图', () => {
    let callback: ResizeObserverCallback = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb
        }
        observe() {}
        disconnect = disconnect
      },
    )
    const c = card()
    const resize = (width: number) =>
      act(() => callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver))
    resize(SPLIT_MIN_WIDTH - 1)
    expect(within(c).queryByRole('group', { name: 'diff 视图' })).toBeNull()
    resize(SPLIT_MIN_WIDTH)
    expect(within(c).getByRole('group', { name: 'diff 视图' })).toBeTruthy()
    cleanup()
    expect(disconnect).toHaveBeenCalled()
  })
})

describe('LineContent', () => {
  it('词级范围跨过高亮片段时按片段切开', () => {
    const { container } = render(
      <div>
        <LineContent
          tokens={[
            { content: 'abc', color: 'red' },
            { content: 'def', italic: true, bold: true },
          ]}
          words={[
            [1, 4],
            [5, 6],
          ]}
          wordClass="mark"
        />
      </div>,
    )
    const spans = [...container.querySelectorAll('span')]
    expect(spans.map((s) => [s.textContent, s.className])).toEqual([
      ['a', ''],
      ['bc', 'rounded-[2px] mark'],
      ['d', 'rounded-[2px] mark'],
      ['e', ''],
      ['f', 'rounded-[2px] mark'],
    ])
    expect(spans[3]!.getAttribute('style')).toContain('font-style: italic')
    expect(spans[3]!.getAttribute('style')).toContain('font-weight: 600')
  })
})
