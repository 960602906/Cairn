// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { FindBar } from './FindBar.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

function Harness({
  open,
  text = '看看 cairn 和 Cairn',
  revision = 0,
  focusToken = 0,
  onClose = () => {},
}: {
  readonly open: boolean
  readonly text?: string
  readonly revision?: number
  readonly focusToken?: number
  readonly onClose?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  return (
    <>
      <div data-testid="root" ref={root}>
        {text}
      </div>
      <FindBar
        open={open}
        root={root}
        revision={revision}
        focusToken={focusToken}
        onClose={onClose}
      />
    </>
  )
}

const renderBar = (props: Parameters<typeof Harness>[0]) =>
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <Harness {...props} />
    </I18nextProvider>,
  )

describe('FindBar', () => {
  it('counts matches and steps through them with the keyboard and buttons', async () => {
    const user = userEvent.setup()
    renderBar({ open: true })
    const input = screen.getByLabelText('在对话中查找')
    expect(document.activeElement).toBe(input)

    await user.type(input, 'cairn')
    await waitFor(() => expect(screen.getByText('1/2')).toBeTruthy())

    // 输入法组字时的 Enter 属于候选词确认，不跳到下一处。
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.getByText('1/2')).toBeTruthy()

    await user.keyboard('{Enter}')
    expect(screen.getByText('2/2')).toBeTruthy()
    await user.keyboard('{Enter}')
    expect(screen.getByText('1/2')).toBeTruthy()
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByText('2/2')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '下一处' }))
    expect(screen.getByText('1/2')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '上一处' }))
    expect(screen.getByText('2/2')).toBeTruthy()
  })

  it('shows no results and disables stepping when nothing matches', async () => {
    const user = userEvent.setup()
    renderBar({ open: true })
    await user.type(screen.getByLabelText('在对话中查找'), '没有')
    expect(screen.getByText('无结果')).toBeTruthy()
    expect((screen.getByRole('button', { name: '上一处' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '下一处' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('closes with Escape, the close button, or keeps focus with a new focus token', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = renderBar({ open: true, onClose })
    const input = screen.getByLabelText('在对话中查找')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    await user.click(screen.getByRole('button', { name: '关闭查找' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    input.blur()
    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <Harness open focusToken={2} onClose={onClose} />
      </I18nextProvider>,
    )
    expect(document.activeElement).toBe(screen.getByLabelText('在对话中查找'))
  })

  it('highlights matches and scrolls the active one into view', async () => {
    const set = vi.fn()
    const remove = vi.fn()
    vi.stubGlobal('Highlight', class {})
    vi.stubGlobal('CSS', { highlights: { set, delete: remove } })
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const user = userEvent.setup()
    const { rerender } = renderBar({ open: true })
    await user.type(screen.getByLabelText('在对话中查找'), 'cairn')
    await waitFor(() => expect(set).toHaveBeenCalledWith('cairn-find', expect.anything()))
    expect(set).toHaveBeenCalledWith('cairn-find-active', expect.anything())
    expect(scrollIntoView).toHaveBeenCalled()

    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <Harness open={false} />
      </I18nextProvider>,
    )
    expect(remove).toHaveBeenCalledWith('cairn-find')
    expect(remove).toHaveBeenCalledWith('cairn-find-active')
  })
})
