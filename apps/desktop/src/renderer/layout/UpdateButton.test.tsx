// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SessionSummary, Settings, UpdateStatus } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { UpdateButton } from './UpdateButton.js'

afterEach(cleanup)

const SETTINGS: Settings = { locale: 'zh-CN', providers: [] }

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: 'idle',
    currentVersion: '0.1.0',
    channel: 'beta',
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

function setup(update: UpdateStatus, sessions: readonly SessionSummary[] = []) {
  const request = vi.fn(async (method: string) =>
    method === 'update.download' ? status({ phase: 'downloading' }) : {},
  )
  const store = createSessionStore({
    request,
    on: () => () => {},
    ready: async () => {},
  } as unknown as MainApi)
  store.setState({ updateStatus: update, settings: SETTINGS, sessions })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <UpdateButton />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request }
}

describe('UpdateButton', () => {
  it('stays hidden when there is nothing to do', () => {
    setup(status())
    expect(screen.queryByRole('button')).toBeNull()

    cleanup()
    setup(status({ phase: 'up_to_date' }))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('downloads an available update', async () => {
    const { request } = setup(status({ phase: 'available', availableVersion: '0.1.1' }))
    await userEvent.click(screen.getByRole('button', { name: '下载更新 0.1.1' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.download', {}))
  })

  it('shows progress while downloading', () => {
    setup(
      status({
        phase: 'downloading',
        progress: { percent: 42, transferred: 42, total: 100 },
      }),
    )
    const ring = screen.getByRole('progressbar', { name: '正在下载更新 42%' })
    expect(ring.getAttribute('aria-valuenow')).toBe('42')
  })

  it('turns into an update button that confirms the restart', async () => {
    const { request } = setup(
      status({ phase: 'downloaded', availableVersion: '0.1.1', requiresRestart: true }),
    )
    await userEvent.click(screen.getByRole('button', { name: '安装 0.1.1 并重启' }))
    expect(await screen.findByText('安装 0.1.1 并重启？')).toBeDefined()
    expect(request).not.toHaveBeenCalledWith('update.install', {})
  })

  it('blocks installing while a task runs', () => {
    setup(status({ phase: 'downloaded', availableVersion: '0.1.1' }), [runningSession()])
    expect(screen.getByRole('button', { name: '有任务在运行，完成后再重启安装' })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('retries a failed check', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'update.check') return status({ phase: 'up_to_date' })
      return {}
    })
    const store = createSessionStore({
      request,
      on: () => () => {},
      ready: async () => {},
    } as unknown as MainApi)
    store.setState({ updateStatus: status({ phase: 'error' }), settings: SETTINGS })
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreContext.Provider value={store}>
          <UpdateButton />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: '重试更新' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.check', { force: true }))
    expect(request).not.toHaveBeenCalledWith('update.download', {})
  })
})
