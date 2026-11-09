// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SessionSummary, Settings, UpdateStatus } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { createSessionStore, type SessionStore } from './session-store.js'
import { SessionStoreContext } from './store-context.js'
import { UpdateNotice } from './UpdateNotice.js'

afterEach(cleanup)

const SETTINGS: Settings = { locale: 'zh-CN', providers: [] }

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: 'idle',
    currentVersion: '0.1.0',
    channel: 'beta',
    channelPinned: false,
    enabled: true,
    autoCheck: true,
    signatureVerified: false,
    requiresRestart: false,
    ...overrides,
  }
}

function runningSession(): SessionSummary {
  return {
    sessionId: 's1',
    projectPath: 'C:\\work',
    title: '任务',
    status: 'running',
    createdAt: 0,
    updatedAt: 0,
  }
}

function setup(options: {
  readonly update?: UpdateStatus
  readonly sessions?: readonly SessionSummary[]
  readonly download?: () => UpdateStatus
  readonly cancel?: () => UpdateStatus
  readonly install?: () => UpdateStatus
}): {
  readonly store: SessionStore
  readonly request: ReturnType<typeof vi.fn>
  readonly onOpenSettings: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async (method: string) => {
    if (method === 'update.status') return options.update
    if (method === 'update.download') return options.download?.() ?? options.update
    if (method === 'update.cancel') return options.cancel?.() ?? options.update
    if (method === 'update.install') return options.install?.() ?? options.update
    if (method === 'settings.get') return SETTINGS
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({
    ...(options.update ? { updateStatus: options.update } : {}),
    settings: SETTINGS,
    sessions: options.sessions ?? [],
  })
  const onOpenSettings = vi.fn()
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <UpdateNotice onOpenSettings={onOpenSettings} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request, onOpenSettings }
}

describe('UpdateNotice', () => {
  it('stays hidden without a status or in quiet phases', () => {
    setup({})
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    setup({ update: status() })
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    setup({
      update: status({
        phase: 'error',
        error: { code: 'update.network', message: 'x', retryable: true },
      }),
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers download, dismissal and settings for an available update', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({ phase: 'available', availableVersion: '0.1.1' }),
      download: () =>
        status({
          phase: 'downloading',
          availableVersion: '0.1.1',
          progress: { percent: 10, transferred: 10, total: 100 },
        }),
    })
    expect(screen.getByText('新版本 0.1.1 可用')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.download', {}))
    expect(screen.getByText('正在下载更新 10%')).toBeDefined()

    cleanup()
    const dismissed = setup({ update: status({ phase: 'available', availableVersion: '0.1.1' }) })
    await user.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.queryByRole('status')).toBeNull()
    dismissed.store.setState({
      updateStatus: status({ phase: 'available', availableVersion: '0.1.2' }),
    })
    expect(await screen.findByText('新版本 0.1.2 可用')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '更新设置' }))
    expect(dismissed.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('cancels a running download', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({
        phase: 'downloading',
        availableVersion: '0.1.1',
        progress: { percent: 35, transferred: 35, total: 100 },
      }),
      cancel: () => status({ phase: 'available', availableVersion: '0.1.1' }),
    })
    expect(screen.getByText('正在下载更新 35%')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.cancel', {}))
  })

  it('delays restart while tasks are running', async () => {
    const user = userEvent.setup()
    setup({
      update: status({
        phase: 'downloaded',
        availableVersion: '0.1.1',
        blockedReason: 'update.busy',
      }),
      sessions: [runningSession()],
    })
    expect(screen.getByText('0.1.1 已下载，任务结束后可重启安装')).toBeDefined()
    const restart = screen.getByRole('button', { name: '重启安装' })
    expect(restart).toHaveProperty('disabled', true)
    await user.click(restart)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('confirms a restart when no task is running', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1', requiresRestart: true }),
      install: () => status({ phase: 'installing', availableVersion: '0.1.1' }),
    })
    expect(screen.getByText('0.1.1 已下载，重启后安装')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    expect(await screen.findByRole('dialog')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重启并安装' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.install', {}))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the dialog open with the failure when restart is blocked late', async () => {
    const user = userEvent.setup()
    setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
      install: () =>
        status({
          phase: 'downloaded',
          availableVersion: '0.1.1',
          blockedReason: 'update.busy',
          error: { code: 'update.busy', message: 'tasks are still running', retryable: true },
        }),
    })
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    await user.click(screen.getByRole('button', { name: '重启并安装' }))
    expect(await screen.findByText('还有任务在运行，任务结束后再安装更新')).toBeDefined()
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('keeps the dialog open when the install request itself fails', async () => {
    const user = userEvent.setup()
    setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
      install: () => {
        throw new Error('ipc closed')
      },
    })
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    await user.click(screen.getByRole('button', { name: '重启并安装' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重启并安装' })).toHaveProperty('disabled', false),
    )
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('closes the restart dialog without installing', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
    })
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '稍后' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).not.toHaveBeenCalledWith('update.install', {})
  })

  it('warns about unsigned builds and disables restart when a task starts', async () => {
    const user = userEvent.setup()
    const { store } = setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
    })
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    expect(
      await screen.findByText(
        '这个版本没有可验证的发布者签名（unsigned beta）。只从你信任的更新源安装。',
      ),
    ).toBeDefined()
    store.setState({ sessions: [runningSession()] })
    expect(
      await screen.findByText(
        '还有任务在运行。完成或停止任务后再安装更新；应用不会在任务运行时静默重启。',
      ),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: '重启并安装' })).toHaveProperty('disabled', true)
  })

  it('shows the delayed notice directly when tasks are already running', () => {
    setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
      sessions: [runningSession()],
    })
    expect(screen.getByText('0.1.1 已下载，任务结束后可重启安装')).toBeDefined()
    expect(screen.getByRole('button', { name: '重启安装' })).toHaveProperty('disabled', true)
  })

  it('refreshes the main-process busy reason when the task set changes', async () => {
    const { request, store } = setup({
      update: status({ phase: 'downloaded', availableVersion: '0.1.1' }),
    })
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.status', {}))
    const calls = request.mock.calls.filter(([method]) => method === 'update.status').length
    store.setState({ sessions: [runningSession()] })
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === 'update.status').length,
      ).toBeGreaterThan(calls),
    )
  })
})
