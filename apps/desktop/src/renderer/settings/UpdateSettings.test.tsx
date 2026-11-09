// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SessionSummary, Settings, UpdateStatus } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore, type SessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { UpdateSettings } from './UpdateSettings.js'

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
    source: 'https://updates.example/cairn/',
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
  readonly update: UpdateStatus
  readonly sessions?: readonly SessionSummary[]
  readonly check?: () => UpdateStatus
  readonly download?: () => UpdateStatus
  readonly install?: () => UpdateStatus
  readonly cancel?: () => UpdateStatus
  readonly settingsUpdate?: () => unknown
}): {
  readonly store: SessionStore
  readonly request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'update.status') return options.update
    if (method === 'update.check') return options.check?.() ?? options.update
    if (method === 'update.download') return options.download?.() ?? options.update
    if (method === 'update.install') return options.install?.() ?? options.update
    if (method === 'update.cancel') return options.cancel?.() ?? options.update
    if (method === 'settings.get') return SETTINGS
    if (method === 'settings.update') {
      return options.settingsUpdate?.() ?? { ...SETTINGS, ...(params as object) }
    }
    return {}
  })
  const api = {
    ready: async () => {},
    request,
    on: () => () => {},
  } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({
    updateStatus: options.update,
    settings: SETTINGS,
    sessions: options.sessions ?? [],
  })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <UpdateSettings />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request }
}

describe('UpdateSettings', () => {
  it('shows the version, channel, auto check state and last check time', async () => {
    const checkedAt = Date.UTC(2026, 10, 10, 8, 30)
    setup({ update: status({ lastCheckedAt: checkedAt }) })
    expect(await screen.findByText('v0.1.0')).toBeDefined()
    expect(screen.getByText('Beta 测试版')).toBeDefined()
    expect(screen.getByRole('switch', { name: '自动检查更新' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByText(new Date(checkedAt).toLocaleString('zh-CN'))).toBeDefined()
    expect(screen.getByText('https://updates.example/cairn/')).toBeDefined()
  })

  it('shows the disabled reason and hides update actions', async () => {
    setup({
      update: status({
        phase: 'disabled',
        enabled: false,
        disabledReason: 'update.source_missing',
      }),
    })
    expect(await screen.findByText('已停用')).toBeDefined()
    expect(screen.getByText('没有配置更新源')).toBeDefined()
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull()
  })

  it('checks manually with force and reloads the status', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status(),
      check: () => status({ phase: 'up_to_date' }),
    })
    await screen.findByText('v0.1.0')
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.check', { force: true }))
    expect(await screen.findByText('已经是最新版本。')).toBeDefined()
  })

  it('toggles automatic checks through settings and reloads the status', async () => {
    const user = userEvent.setup()
    const { request } = setup({ update: status() })
    await screen.findByText('v0.1.0')
    await user.click(screen.getByRole('switch', { name: '自动检查更新' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('settings.update', { updateAutoCheck: false }),
    )
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.status', {}))
  })

  it('changes the channel unless the build pins it', async () => {
    const user = userEvent.setup()
    const { request } = setup({ update: status() })
    await screen.findByText('v0.1.0')
    await user.click(screen.getByRole('radio', { name: '稳定版' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('settings.update', { updateChannel: 'stable' }),
    )

    cleanup()
    setup({ update: status({ channel: 'beta', channelPinned: true }) })
    expect(await screen.findByText('这个构建的通道已固定，设置中的选择不会生效。')).toBeDefined()
    expect(screen.queryByRole('radiogroup', { name: '更新通道' })).toBeNull()
  })

  it('downloads, shows progress, and cancels a download', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({ phase: 'available', availableVersion: '0.1.1' }),
      download: () =>
        status({
          phase: 'downloading',
          availableVersion: '0.1.1',
          progress: {
            percent: 42,
            transferred: 1536,
            total: 2 * 1024 * 1024,
            bytesPerSecond: 1024,
          },
        }),
      cancel: () =>
        status({
          phase: 'available',
          availableVersion: '0.1.1',
          error: { code: 'update.cancelled', message: 'download cancelled', retryable: true },
        }),
    })
    expect(await screen.findByText('新版本 0.1.1 可以下载。')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '下载更新' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.download', {}))
    expect(
      (await screen.findByRole('progressbar', { name: '下载进度' })).getAttribute('aria-valuenow'),
    ).toBe('42')
    expect(screen.getByText('42% · 1.5 KB / 2 MB · 1 KB/s')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '取消下载' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.cancel', {}))
    expect(await screen.findByText('更新下载已取消')).toBeDefined()
  })

  it('skips the available version and can stop skipping', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({ phase: 'available', availableVersion: '0.1.1' }),
    })
    await screen.findByText('新版本 0.1.1 可以下载。')
    await user.click(screen.getByRole('button', { name: '跳过此版本' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('settings.update', {
        updateSkippedVersion: '0.1.1',
      }),
    )

    cleanup()
    const skipped = setup({
      update: status({ phase: 'skipped', availableVersion: '0.1.1', skippedVersion: '0.1.1' }),
    })
    expect(await screen.findByText('已跳过 0.1.1；手动检查仍会显示这个版本。')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '取消跳过' }))
    await waitFor(() =>
      expect(skipped.request).toHaveBeenCalledWith('settings.update', {
        updateSkippedVersion: null,
      }),
    )
  })

  it('shows verifying, installing and up-to-date states', async () => {
    setup({ update: status({ phase: 'verifying' }) })
    expect(await screen.findByText('正在校验下载的安装包…')).toBeDefined()

    cleanup()
    setup({ update: status({ phase: 'installing' }) })
    expect(await screen.findByText('正在启动安装程序，应用即将重启…')).toBeDefined()

    cleanup()
    setup({ update: status({ phase: 'up_to_date' }) })
    expect(await screen.findByText('已经是最新版本。')).toBeDefined()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeDefined()
  })

  it('shows the checking state and a release date', async () => {
    setup({ update: status({ phase: 'checking' }) })
    expect(await screen.findByText('正在检查更新…')).toBeDefined()

    cleanup()
    const releasedAt = Date.UTC(2026, 10, 1, 9, 0)
    setup({
      update: status({
        phase: 'available',
        availableVersion: '0.1.1',
        releaseDate: releasedAt,
      }),
    })
    expect(
      await screen.findByText(`发布于 ${new Date(releasedAt).toLocaleString('zh-CN')}`),
    ).toBeDefined()
  })

  it('falls back to the phase label and never when dates are missing or invalid', async () => {
    setup({
      update: status({ phase: 'disabled', lastCheckedAt: Number.NaN }),
    })
    expect((await screen.findAllByText('已停用')).length).toBe(2)
    expect(screen.getByText('还没有检查过')).toBeDefined()
  })

  it('does not reload the status when saving the channel or auto check fails', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status(),
      settingsUpdate: () => {
        throw new Error('offline')
      },
    })
    await screen.findByText('v0.1.0')
    await user.click(screen.getByRole('radio', { name: '稳定版' }))
    await user.click(screen.getByRole('switch', { name: '自动检查更新' }))
    await waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'settings.update')).toHaveLength(2),
    )
    expect(request.mock.calls.filter(([method]) => method === 'update.status')).toHaveLength(1)
  })

  it('shows downloaded signature state and opens the restart dialog', async () => {
    const user = userEvent.setup()
    setup({
      update: status({
        phase: 'downloaded',
        availableVersion: '0.1.1',
        requiresRestart: true,
      }),
    })
    expect(await screen.findByText('0.1.1 已下载并通过校验，可以重启安装。')).toBeDefined()
    expect(screen.getByText('未配置发布者签名；这是 unsigned beta，请确认来源可信')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重启安装' }))
    expect(await screen.findByRole('dialog')).toBeDefined()
    expect(screen.getByText('安装 0.1.1 并重启？')).toBeDefined()
  })

  it('marks verified signatures and busy tasks', async () => {
    setup({
      update: status({
        phase: 'downloaded',
        availableVersion: '0.1.1',
        signatureVerified: true,
        blockedReason: 'update.busy',
      }),
      sessions: [runningSession()],
    })
    expect(await screen.findByText('发布者签名已验证')).toBeDefined()
    expect(screen.getByText('还有任务在运行；完成或停止后再重启安装。')).toBeDefined()
    expect(screen.getByRole('button', { name: '重启安装' })).toHaveProperty('disabled', true)
  })

  it('shows an error with technical details and retries', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      update: status({
        phase: 'error',
        error: { code: 'update.network', message: 'getaddrinfo ENOTFOUND', retryable: true },
      }),
    })
    expect(await screen.findByText('无法连接更新源，请检查网络或代理')).toBeDefined()
    expect(screen.getByText('update.network · getaddrinfo ENOTFOUND')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('update.check', { force: true }))
  })

  it('shows a loading state until the status arrives', async () => {
    let resolve: ((value: UpdateStatus) => void) | undefined
    const pending = new Promise<UpdateStatus>((done) => {
      resolve = done
    })
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'update.status') return pending
      if (method === 'settings.get') return SETTINGS
      if (method === 'settings.update') return { ...SETTINGS, ...(params as object) }
      return {}
    })
    const store = createSessionStore({
      ready: async () => {},
      request,
      on: () => () => {},
    } as unknown as MainApi)
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreContext.Provider value={store}>
          <UpdateSettings />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(screen.getByText('正在读取更新状态…')).toBeDefined()
    await act(async () => {
      resolve?.(status())
    })
    expect(await screen.findByText('v0.1.0')).toBeDefined()
  })
})
