// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { MemoryEntry } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { MemoryEntryCard } from './MemoryEntryCard.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const entry: MemoryEntry = {
  memoryId: 'm1',
  scope: 'project',
  projectId: 'p1',
  content: '提交信息用中文',
  status: 'active',
  sourceRunId: 'r1',
  sourceAgentId: 'builtin.coder',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const makeStore = (
  updateMemory = vi.fn(async () => true),
  deleteMemory = vi.fn(async () => true),
) =>
  createStore<Record<string, unknown>>(() => ({
    updateMemory,
    deleteMemory,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('MemoryEntryCard（M7-04）', () => {
  it('显示正文、状态与来源', () => {
    wrap(<MemoryEntryCard entry={entry} />)
    expect(screen.getByText('提交信息用中文')).toBeTruthy()
    expect(screen.getByText('已生效')).toBeTruthy()
    expect(screen.getByText(/builtin\.coder/)).toBeTruthy()
  })

  it('待确认的条目显示对应状态', () => {
    wrap(<MemoryEntryCard entry={{ ...entry, status: 'proposed' }} />)
    expect(screen.getByText('待确认')).toBeTruthy()
  })

  it('长内容默认折叠，可展开与收起', async () => {
    wrap(<MemoryEntryCard entry={{ ...entry, content: `开头 ${'很长的内容'.repeat(60)}` }} />)
    const toggle = screen.getByRole('button', { name: '展开' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('设置页可以编辑并保存', async () => {
    const updateMemory = vi.fn(async () => true)
    const onChanged = vi.fn()
    const user = userEvent.setup()
    wrap(<MemoryEntryCard entry={entry} editable onChanged={onChanged} />, makeStore(updateMemory))
    await user.click(screen.getByRole('button', { name: '编辑' }))
    const textarea = screen.getByRole('textbox', { name: '编辑' })
    await user.clear(textarea)
    await user.type(textarea, '新的约定')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith('m1', '新的约定'))
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByText('已保存')).toBeTruthy()
  })

  it('没有改动时直接退出编辑，不调用接口', async () => {
    const updateMemory = vi.fn(async () => true)
    const user = userEvent.setup()
    wrap(<MemoryEntryCard entry={entry} editable />, makeStore(updateMemory))
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(updateMemory).not.toHaveBeenCalled()
  })

  it('删除前确认，并把会话 id 一起交给 store', async () => {
    const deleteMemory = vi.fn(async () => true)
    const onChanged = vi.fn()
    const user = userEvent.setup()
    wrap(
      <MemoryEntryCard entry={entry} sessionId="s1" onChanged={onChanged} />,
      makeStore(undefined, deleteMemory),
    )
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith('m1', 's1'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('取消删除时不调用接口', async () => {
    const deleteMemory = vi.fn(async () => true)
    const user = userEvent.setup()
    wrap(<MemoryEntryCard entry={entry} />, makeStore(undefined, deleteMemory))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(deleteMemory).not.toHaveBeenCalled()
  })
})
