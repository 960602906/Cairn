// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ToolOutputChunk } from '@cairn/core'
import { TERMINAL_LINE_HEIGHT, TerminalCard, type TerminalCardProps } from './TerminalCard.js'

const i18n = createI18n('zh-CN')
const wrap = (ui: ReactNode) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
afterEach(cleanup)

const out = (text: string): ToolOutputChunk => ({ stream: 'stdout', text })
const err = (text: string): ToolOutputChunk => ({ stream: 'stderr', text })

const card = (props: Partial<TerminalCardProps> = {}) => {
  wrap(<TerminalCard command="npm test" chunks={[]} {...props} />)
  return screen.getByRole('figure', { name: '终端：npm test' })
}
const log = () => screen.getByRole('log', { name: '命令输出' })
const rows = () => [...log().querySelectorAll('[style*="height: 21px"]')]

describe('TerminalCard：标题栏', () => {
  it('命令、退出码 0、耗时', () => {
    const c = card({ exitCode: 0, durationMs: 1234 })
    expect(within(c).getByText('npm test').tagName).toBe('CODE')
    expect(within(c).getByText('退出码 0').className).toContain('sr-only')
    expect(within(c).getByText('退出码 0').parentElement!.className).toContain('text-term-ok')
    expect(within(c).getByText('1.2s')).toBeTruthy()
    expect(within(c).getByText('（没有输出）')).toBeTruthy()
  })

  it.each([
    [{ exitCode: 2 }, '退出码 2', 'text-term-c1'],
    [{ exitCode: null, timedOut: true }, '超时', 'text-term-c1'],
    [{ exitCode: null, aborted: true }, '已取消', 'text-term-dim'],
    [{ exitCode: null, signal: 'SIGKILL' }, '被信号 SIGKILL 结束', 'text-term-c1'],
    [{ running: true }, '运行中', 'text-term-dim'],
  ])('徽标 %o', (props, text, tone) => {
    const c = card(props)
    const el = within(c).getByText(text)
    expect((el.className.includes('sr-only') ? el.parentElement! : el).className).toContain(tone)
  })

  it('没有退出码也没有信号时不显示徽标；运行中不显示耗时', () => {
    const c = card({ exitCode: null, durationMs: 5, running: true })
    expect(within(c).queryByText('5ms')).toBeNull()
    cleanup()
    const d = card({ exitCode: null })
    expect(d.querySelector('figcaption')!.textContent).toBe('$npm test复制')
  })

  it('复制去掉控制符的输出', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    card({ chunks: [out('\x1b[32mok\x1b[0m\n\n')], exitCode: 0 })
    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('ok')
  })
})

describe('TerminalCard：输出', () => {
  it('ANSI 颜色映射到终端令牌；标准错误没有着色的文字用 --term-err', () => {
    card({
      chunks: [
        out('plain \x1b[1;31mred\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\n'),
        out('\x1b[7;32minv\x1b[0m \x1b[2;3;4;9mdeco\x1b[0m \x1b[7mbare\x1b[0m\n'),
        err('oops\n'),
        err('\x1b[33mwarn\x1b[0m'),
      ],
    })
    const style = (text: string) => screen.getByText(text).getAttribute('style') ?? ''
    expect(screen.getByText(/plain/).tagName).toBe('DIV')
    expect(style('red')).toContain('color: var(--term-c1)')
    expect(style('red')).toContain('font-weight: 600')
    expect(style('rgb')).toContain('color: rgb(1, 2, 3)')
    expect(style('inv')).toContain('color: var(--term-bg)')
    expect(style('inv')).toContain('background: var(--term-c2)')
    expect(style('deco')).toContain('opacity: 0.6')
    expect(style('deco')).toContain('font-style: italic')
    expect(style('deco')).toContain('text-decoration: underline line-through')
    expect(style('bare')).toContain('background: var(--term-fg)')
    expect(style('oops')).toContain('color: var(--term-err)')
    expect(style('warn')).toContain('color: var(--term-c3)')
  })

  it('省略处：中间与开头', () => {
    card({ chunks: [out('head\n'), out('tail\n')], omittedChars: 99, omittedAt: 1 })
    expect(rows().map((r) => r.textContent)).toEqual(['head', '…… 省略了 99 个字符 ……', 'tail'])
    cleanup()
    card({ chunks: [out('rest\n')], omittedChars: 5, omittedAt: 0, running: true })
    expect(rows().map((r) => r.textContent)).toEqual(['…… 前面省略了 5 个字符', 'rest'])
  })

  it('运行中还没有输出时输出区为空', () => {
    card({ running: true })
    expect(log().textContent).toBe('')
  })

  it('1 万行只渲染看得见的部分，滚动后换成对应的行', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n')
    const start = performance.now()
    card({ chunks: [out(text)], exitCode: 0 })
    expect(performance.now() - start).toBeLessThan(1000)
    const inner = log().firstElementChild as HTMLElement
    expect(inner.style.height).toBe(`${10_000 * TERMINAL_LINE_HEIGHT}px`)
    expect(rows().length).toBeLessThan(60)
    expect(rows()[0]!.textContent).toBe('line 0')
    log().scrollTop = 5000 * TERMINAL_LINE_HEIGHT
    fireEvent.scroll(log())
    const visible = rows().map((r) => r.textContent)
    expect(visible).toContain('line 5000')
    expect(visible).not.toContain('line 0')
    expect(rows().length).toBeLessThan(60)
  })

  it('运行中停在底部时跟着新输出滚动；往上翻后不再跟随', () => {
    const many = (n: number) => out(Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n')
    const { rerender } = wrap(<TerminalCard command="x" running chunks={[many(100)]} />)
    const el = log()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 99_999 })
    rerender(
      <I18nextProvider i18n={i18n}>
        <TerminalCard command="x" running chunks={[many(200)]} />
      </I18nextProvider>,
    )
    expect(el.scrollTop).toBeGreaterThan(0)
    el.scrollTop = 0
    fireEvent.scroll(el)
    rerender(
      <I18nextProvider i18n={i18n}>
        <TerminalCard command="x" running chunks={[many(300)]} />
      </I18nextProvider>,
    )
    expect(el.scrollTop).toBe(0)
  })
})

describe('TerminalCard：底部汇总', () => {
  it('测试数量、Shell 与工作目录', () => {
    const c = card({
      chunks: [out('      Tests  12 passed | 1 failed | 2 skipped (15)\n')],
      exitCode: 1,
      shell: 'bash',
      cwd: '/work/demo',
    })
    expect(within(c).getByText('12 通过')).toBeTruthy()
    expect(within(c).getByText('1 失败')).toBeTruthy()
    expect(within(c).getByText('2 跳过')).toBeTruthy()
    expect(within(c).getByTitle('/work/demo').textContent).toBe('bash · 工作目录 /work/demo')
  })

  it('全部通过时只显示通过数；只有 Shell 时没有分隔符；什么都没有时不显示', () => {
    const c = card({
      chunks: [out('test result: ok. 3 passed; 0 failed; 0 ignored\n')],
      shell: 'cmd.exe',
    })
    expect(within(c).getByText('3 通过')).toBeTruthy()
    expect(within(c).queryByText(/失败/)).toBeNull()
    expect(within(c).getByText('cmd.exe').textContent).toBe('cmd.exe')
    cleanup()
    const d = card({ chunks: [out('hi\n')], exitCode: 0 })
    expect(d.children).toHaveLength(2)
  })

  it('运行中不识别测试汇总', () => {
    const c = card({ chunks: [out('test result: ok. 3 passed; 0 failed\n')], running: true })
    expect(within(c).queryByText('3 通过')).toBeNull()
  })
})
