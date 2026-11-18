// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { MemoryEntry } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { MemoryPanel } from './MemoryPanel.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const view = {
  ...createSessionView('s1'),
  info: {
    projectId: 'p1',
    projectPath: '/work/a',
    workspacePath: '/work/a',
    title: 'A',
    model: undefined,
    thinkingLevel: undefined,
    createdAt: 0,
  },
}

const entries: readonly MemoryEntry[] = [
  {
    memoryId: 's1m',
    scope: 'session',
    sessionId: 's1',
    content: '本会话约定',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    memoryId: 'p1m',
    scope: 'project',
    projectId: 'p1',
    content: '本项目约定',
    status: 'active',
    createdAt: 2,
    updatedAt: 2,
  },
  {
    memoryId: 'p2m',
    scope: 'project',
    projectId: 'p2',
    content: '别的项目',
    status: 'active',
    createdAt: 3,
    updatedAt: 3,
  },
  {
    memoryId: 'g1',
    scope: 'global',
    content: '全局偏好',
    status: 'active',
    createdAt: 4,
    updatedAt: 4,
  },
]

const makeStore = (
  listMemories: () => Promise<MemoryEntry[] | undefined> = vi.fn(async () => [...entries]),
  deleteMemory = vi.fn(async () => true),
) =>
  createStore<Record<string, unknown>>(() => ({
    listMemories,
    deleteMemory,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('MemoryPanel（M7-04）', () => {
  it('只显示本会话、本项目与全局的记忆', async () => {
    wrap(<MemoryPanel sessionId="s1" view={view} />)
    expect(await screen.findByText('本会话约定')).toBeTruthy()
    expect(screen.getByText('本项目约定')).toBeTruthy()
    expect(screen.getByText('全局偏好')).toBeTruthy()
    expect(screen.queryByText('别的项目')).toBeNull()
  })

  it('没有记忆时显示空状态', async () => {
    wrap(<MemoryPanel sessionId="s1" view={view} />, makeStore(vi.fn(async () => [])))
    expect(await screen.findByText('还没有记忆')).toBeTruthy()
  })

  it('读取失败时显示错误，重试后恢复', async () => {
    const listMemories = vi
      .fn<() => Promise<MemoryEntry[] | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([...entries])
    wrap(<MemoryPanel sessionId="s1" view={view} />, makeStore(listMemories))
    expect(await screen.findByRole('alert')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('本会话约定')).toBeTruthy())
  })

  it('删除时把当前会话 id 交给 store', async () => {
    const deleteMemory = vi.fn(async () => true)
    wrap(<MemoryPanel sessionId="s1" view={view} />, makeStore(undefined, deleteMemory))
    await screen.findByText('本会话约定')
    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!)
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith('s1m', 's1'))
  })
})
