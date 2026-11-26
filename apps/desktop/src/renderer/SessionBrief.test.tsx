// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createI18n } from '@cairn/i18n'
import { SessionBriefPanel } from './SessionBrief.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

afterEach(cleanup)

function setup(content: string | undefined, saved = true) {
  const updateBrief = vi.fn(async () => saved)
  const store = createStore(() => ({
    views: { s1: content === undefined ? {} : { brief: { content } } },
    updateBrief,
  })) as unknown as SessionStore
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreProvider store={store}>
        <SessionBriefPanel sessionId="s1" />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { updateBrief }
}

describe('SessionBriefPanel', () => {
  it('shows the empty hint, then saves an edited brief', async () => {
    const { updateBrief } = setup(undefined)
    expect(screen.getByText(/还没有会话要点/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    await userEvent.type(screen.getByRole('textbox', { name: '编辑' }), '只改前端')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(updateBrief).toHaveBeenCalledWith('s1', '只改前端')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('renders the brief, cancels an edit and keeps editing when saving fails', async () => {
    const { updateBrief } = setup('**目标**：重构输入框', false)
    expect(screen.getByText('目标').tagName).toBe('STRONG')
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('**目标**：重构输入框')
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(updateBrief).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('focuses the editor and saves with Ctrl+Enter, then returns to Edit', async () => {
    const { updateBrief } = setup('旧要点')
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '编辑' })
    await waitFor(() => expect(document.activeElement).toBe(editor))
    expect(editor.selectionStart).toBe(editor.value.length)

    await userEvent.clear(editor)
    await userEvent.type(editor, '新要点')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(updateBrief).toHaveBeenCalledWith('s1', '新要点'))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '编辑' })),
    )
  })

  it('cancels with Escape and returns focus to Edit', async () => {
    setup('旧要点')
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    await userEvent.type(screen.getByRole('textbox'), '{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '编辑' }))
  })
})
