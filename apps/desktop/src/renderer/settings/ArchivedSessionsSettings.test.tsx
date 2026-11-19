// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SessionSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { ArchivedSessionsSettings } from './ArchivedSessionsSettings.js'
import { clearSettingsData } from './settings-data-cache.js'

const i18n = createI18n('zh-CN')

const summary = (sessionId: string, title: string, status: SessionSummary['status']) => ({
  sessionId,
  title,
  projectPath: '/work/demo',
  status,
  createdAt: 1,
  updatedAt: 1,
})

function setup(sessions: SessionSummary[]) {
  const request = vi.fn(async (method: string) => {
    if (method === 'session.list') return { ok: true, result: { sessions } }
    return { ok: true, result: {} }
  })
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request,
    on: () => () => undefined,
  }
  const unarchiveSession = vi.fn(async () => true)
  const deleteSession = vi.fn(async () => true)
  const store = createStore<Record<string, unknown>>(() => ({
    projects: [],
    sessions: [],
    unarchiveSession,
    deleteSession,
  })) as unknown as SessionStore
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <ArchivedSessionsSettings />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { request, unarchiveSession, deleteSession }
}

beforeEach(clearSettingsData)
afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('ArchivedSessionsSettings', () => {
  it('lists archived conversations and unarchives one', async () => {
    const user = userEvent.setup()
    const { request, unarchiveSession } = setup([
      summary('s1', '归档的对话', 'archived'),
      summary('s2', '还在用的对话', 'idle'),
    ])
    await waitFor(() => expect(screen.getByText('归档的对话')).toBeTruthy())
    expect(screen.queryByText('还在用的对话')).toBeNull()
    expect(request).toHaveBeenCalledWith('session.list', { includeArchived: true }, undefined)

    await user.click(screen.getByRole('button', { name: '取消归档' }))
    expect(unarchiveSession).toHaveBeenCalledWith('s1')
  })

  it('confirms before deleting an archived conversation for good', async () => {
    const user = userEvent.setup()
    const { deleteSession } = setup([summary('s1', '归档的对话', 'archived')])
    await waitFor(() => expect(screen.getByText('归档的对话')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: '彻底删除' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('彻底删除“归档的对话”？')).toBeTruthy()
    expect(deleteSession).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '彻底删除' }))
    expect(deleteSession).toHaveBeenCalledWith('s1')
  })

  it('shows the empty state when nothing is archived', async () => {
    setup([summary('s2', '还在用的对话', 'idle')])
    await waitFor(() => expect(screen.getByText('没有已归档的对话')).toBeTruthy())
  })

  it('renders multiple archived conversations, including an untitled one in a known workspace', async () => {
    const request = vi.fn(async () => ({
      ok: true,
      result: {
        sessions: [
          summary('s1', '', 'archived'),
          { ...summary('s2', '第二个归档会话', 'archived'), updatedAt: 0 },
        ],
      },
    }))
    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request,
      on: () => () => undefined,
    }
    const store = createStore<Record<string, unknown>>(() => ({
      projects: [
        {
          projectId: 'p1',
          name: '工作空间 A',
          path: '/work/demo',
          createdAt: 1,
          sessionCount: 0,
        },
      ],
      unarchiveSession: vi.fn(async () => true),
      deleteSession: vi.fn(async () => true),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store}>
          <ArchivedSessionsSettings />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

    await waitFor(() => expect(screen.getByText('第二个归档会话')).toBeTruthy())
    expect(screen.getByText('未命名会话')).toBeTruthy()
    expect(screen.getAllByText('工作空间 A').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('falls back to the empty state without the preload bridge', async () => {
    delete (window as { cairn?: unknown }).cairn
    const store = createStore<Record<string, unknown>>(() => ({
      projects: [],
      unarchiveSession: vi.fn(async () => true),
      deleteSession: vi.fn(async () => true),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store}>
          <ArchivedSessionsSettings />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.getByText('没有已归档的对话')).toBeTruthy())
  })

  it('names an untitled conversation in the delete confirmation', async () => {
    const user = userEvent.setup()
    const { deleteSession } = setup([summary('s1', '', 'archived')])
    await waitFor(() => expect(screen.getByText('未命名会话')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: '彻底删除' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('彻底删除“未命名会话”？')).toBeTruthy()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('does not delete a conversation when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    const { deleteSession } = setup([summary('s1', '归档的对话', 'archived')])
    await waitFor(() => expect(screen.getByText('归档的对话')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: '彻底删除' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(deleteSession).not.toHaveBeenCalled()
  })
})
