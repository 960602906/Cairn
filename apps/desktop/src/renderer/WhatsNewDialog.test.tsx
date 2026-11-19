// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AppInfo, Settings } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { createSessionStore, type SessionStore } from './session-store.js'
import { SessionStoreContext } from './store-context.js'
import { WhatsNewDialog } from './WhatsNewDialog.js'

afterEach(cleanup)

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    schemaVersion: 1,
    version: '0.1.4',
    channel: 'beta',
    commit: 'abcdef1',
    buildTime: '2026-11-19T00:00:00.000Z',
    electronVersion: '45.2.1',
    nodeVersion: '24.11.0',
    name: 'Cairn',
    appId: 'com.cairn.desktop',
    copyright: 'Copyright © 2026 Cairn contributors',
    packaged: true,
    databaseSchemaVersion: 24,
    releaseNotes: '### Added\n\n- 新的更新弹窗',
    ...overrides,
  }
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { locale: 'zh-CN', providers: [], ...overrides }
}

function setup(options: { readonly info: AppInfo; readonly initialSettings: Settings }): {
  readonly store: SessionStore
  readonly request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'settings.update') return { ...options.initialSettings, ...(params as object) }
    if (method === 'settings.get') return options.initialSettings
    if (method === 'app.info') return options.info
    return {}
  })
  const store = createSessionStore({
    ready: async () => {},
    request,
    on: () => () => {},
  } as unknown as MainApi)
  store.setState({ appInfo: options.info, settings: options.initialSettings })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <WhatsNewDialog />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request }
}

describe('WhatsNewDialog', () => {
  it('shows release notes after installing the matching version and clears the marker', async () => {
    const user = userEvent.setup()
    const { request } = setup({
      info: appInfo({ version: '0.1.4' }),
      initialSettings: settings({ updateInstalledVersion: '0.1.4' }),
    })
    expect(await screen.findByText('已更新到 0.1.4')).toBeDefined()
    expect(await screen.findByText('新的更新弹窗')).toBeDefined()

    await user.click(screen.getByRole('button', { name: '知道了' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('settings.update', {
        updateInstalledVersion: null,
      }),
    )
  })

  it('falls back to a version-only message when the build has no notes', async () => {
    setup({
      info: appInfo({ version: '0.1.4', releaseNotes: undefined }),
      initialSettings: settings({ updateInstalledVersion: '0.1.4' }),
    })
    expect(await screen.findByText('已更新到 0.1.4')).toBeDefined()
    expect(screen.getByText('这个版本没有提供更新说明。')).toBeDefined()
  })

  it('clears a stale marker without showing anything', async () => {
    const { request } = setup({
      info: appInfo({ version: '0.1.4' }),
      initialSettings: settings({ updateInstalledVersion: '0.1.3' }),
    })
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('settings.update', {
        updateInstalledVersion: null,
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('已更新到 0.1.4')).toBeNull()
  })

  it('stays closed when there is no pending installed version', async () => {
    const { request } = setup({
      info: appInfo(),
      initialSettings: settings(),
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).not.toHaveBeenCalledWith('settings.update', {
      updateInstalledVersion: null,
    })
  })
})
