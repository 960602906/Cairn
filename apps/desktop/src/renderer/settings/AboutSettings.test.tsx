// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AppInfo } from '@cairn/protocol'
import { AboutSettings } from './AboutSettings.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

afterEach(cleanup)

const info: AppInfo = {
  schemaVersion: 1,
  version: '0.1.0',
  channel: 'beta',
  commit: 'abcdef1234567890',
  buildTime: '2026-11-10T08:30:00.000Z',
  electronVersion: '45.2.1',
  nodeVersion: '24.11.0',
  name: 'Cairn',
  appId: 'com.cairn.desktop',
  copyright: 'Copyright © 2026 Cairn contributors',
  packaged: false,
  databaseSchemaVersion: 17,
  git: { source: 'system', version: '2.56.0.windows.4' },
}

function setup(value: AppInfo | (() => Promise<AppInfo>)) {
  const request = vi.fn(async (method: string) => {
    if (method === 'app.info') return typeof value === 'function' ? value() : value
    if (method === 'update.status') {
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
      }
    }
    if (method === 'app.licenses') {
      return { available: true, text: 'MIT — demo', truncated: false }
    }
    return undefined
  })
  const store = createSessionStore({
    request,
    on: () => () => {},
    ready: async () => {},
  } as unknown as MainApi)
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <AboutSettings />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request }
}

describe('AboutSettings', () => {
  it('shows version, channel, commit and toolchain information', async () => {
    const { request } = setup(info)
    expect(screen.getByText('正在读取构建信息…')).toBeDefined()
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(request).toHaveBeenCalledWith('app.info', {})
    expect(screen.getByText('Beta 测试版')).toBeDefined()
    expect(screen.getByText('abcdef1')).toBeDefined()
    expect(screen.getByText('45.2.1')).toBeDefined()
    expect(screen.getByText('24.11.0')).toBeDefined()
    expect(screen.getByText('17')).toBeDefined()
    expect(screen.getByText('本机 Git · 2.56.0.windows.4')).toBeDefined()
    expect(screen.getByText('开发模式')).toBeDefined()
    expect(screen.getByText(/Copyright/)).toBeDefined()
  })

  it('shows the bundled Git runtime and unavailable fallbacks', async () => {
    setup({
      ...info,
      git: { source: 'bundled', version: '2.56.0.windows.4' },
    })
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(screen.getByText('随包 MinGit · 2.56.0.windows.4')).toBeDefined()

    cleanup()
    setup({ ...info, git: { source: 'unavailable', reason: 'not_found' } })
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(screen.getByText('不可用')).toBeDefined()

    cleanup()
    setup({ ...info, git: undefined })
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(screen.getByText('Git（检查点）')).toBeDefined()
    expect(screen.getAllByText('未知').length).toBe(1)
  })

  it('uses translated fallbacks for unknown build values', async () => {
    setup({
      ...info,
      commit: 'unknown',
      buildTime: '',
      electronVersion: '',
      nodeVersion: '',
      packaged: true,
    })
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(screen.getAllByText('未知').length).toBe(4)
    expect(screen.getByText('安装版')).toBeDefined()
  })

  it('treats an invalid build time and commit as unknown', async () => {
    setup({ ...info, commit: 'not-a-commit', buildTime: 'not-a-date' })
    await waitFor(() => expect(screen.getByText('0.1.0')).toBeDefined())
    expect(screen.getAllByText('未知').length).toBe(2)
  })

  it('keeps the loading state when the request fails', async () => {
    const { store } = setup(async () => {
      throw new Error('offline')
    })
    await waitFor(() => expect(store.getState().error).toBeDefined())
    expect(screen.getByText('正在读取构建信息…')).toBeDefined()
  })

  it('shows the update source and opens the third-party notices', async () => {
    setup(info)
    expect(await screen.findByText('https://updates.example/cairn/')).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: '查看许可' }))
    expect(await screen.findByText('MIT — demo')).toBeDefined()
  })
})
