// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { MemoryEntry } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { MemorySettings } from './MemorySettings.js'

const i18n = createI18n('zh-CN')

const entries: readonly MemoryEntry[] = [
  {
    memoryId: 's1m',
    scope: 'session',
    sessionId: 's1',
    content: '本会话先跑单测',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    memoryId: 'p1m',
    scope: 'project',
    projectId: 'p1',
    content: '提交信息用中文',
    status: 'proposed',
    sourceAgentId: 'builtin.coder',
    createdAt: 2,
    updatedAt: 2,
  },
  {
    memoryId: 'g1',
    scope: 'global',
    content: '回复用英文',
    status: 'active',
    createdAt: 3,
    updatedAt: 3,
  },
]

const makeStore = (
  listMemories: () => Promise<MemoryEntry[] | undefined> = vi.fn(async () => [...entries]),
) =>
  createStore<Record<string, unknown>>(() => ({
    listMemories,
    updateMemory: vi.fn(async () => true),
    deleteMemory: vi.fn(async () => true),
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('MemorySettings（M7-04）', () => {
  it('按范围分组显示条目', async () => {
    wrap(<MemorySettings />)
    expect(await screen.findByRole('region', { name: '本会话' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '本项目' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '所有项目' })).toBeTruthy()
    expect(screen.getByText('本会话先跑单测')).toBeTruthy()
    expect(screen.getByText('待确认')).toBeTruthy()
  })

  it('搜索只留下匹配的条目', async () => {
    wrap(<MemorySettings />)
    await screen.findByText('提交信息用中文')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索记忆' }), '英文')
    expect(screen.queryByText('提交信息用中文')).toBeNull()
    expect(screen.getByText('回复用英文')).toBeTruthy()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索记忆' }), 'zzz')
    expect(screen.getByText('没有匹配的记忆。')).toBeTruthy()
  })

  it('没有条目时显示空状态', async () => {
    wrap(<MemorySettings />, makeStore(vi.fn(async () => [])))
    expect(await screen.findByText('还没有记忆')).toBeTruthy()
  })

  it('读取失败时显示错误并可重试', async () => {
    const listMemories = vi
      .fn<() => Promise<MemoryEntry[] | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([...entries])
    wrap(<MemorySettings />, makeStore(listMemories))
    expect(await screen.findByRole('alert')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('提交信息用中文')).toBeTruthy())
  })
})
