// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import type { DiagnosticsSummary } from '@cairn/protocol'
import { ErrorBanner } from './ErrorBanner.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const mockDiagnosticsSummary: DiagnosticsSummary = {
  appVersion: '0.0.0',
  electronVersion: '0.0.0',
  build: {
    schemaVersion: 1,
    version: '0.0.0',
    channel: 'dev',
    commit: 'abc',
    buildTime: '2026-01-01T00:00:00.000Z',
    electronVersion: '0.0.0',
    nodeVersion: '24.0.0',
    name: 'Cairn',
    appId: 'com.cairn.desktop',
    copyright: 'Copyright © Cairn',
    packaged: false,
    databaseSchemaVersion: 1,
  },
  platform: 'linux',
  arch: 'x64',
  logs: { mainLogLines: 0, hostLogLines: 0 },
  settings: { providersCount: 0, mcpServersCount: 0 },
  sandbox: {
    platform: 'linux',
    mechanism: 'restricted-token',
    policy: { profile: 'workspace-write', network: 'none' },
    unavailable: 'deny',
    capability: {
      available: true,
      supported: true,
      mechanism: 'restricted-token',
      networkIsolated: false,
      checks: {
        restrictedToken: true,
        lowIntegrity: true,
        jobObject: true,
        appContainer: false,
      },
    },
  },
  exportItems: [],
}

afterEach(() => cleanup())

function renderBanner(
  error: { code: string; params?: Record<string, unknown> } | undefined,
  activeSessionId = 's1',
) {
  const clearError = vi.fn()
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId,
    error,
    clearError,
  })) as unknown as SessionStore
  render(
    <I18nextProvider i18n={createI18n('en-US')}>
      <SessionStoreProvider store={store}>
        <ErrorBanner />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { clearError, store }
}

describe('ErrorBanner', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('shows a softer title for timeouts and a dismiss control', async () => {
    const { clearError } = renderBanner({ code: 'rpc.timeout', params: { timeoutMs: 30_000 } })
    expect(screen.getByText('This is taking longer than expected')).toBeTruthy()
    expect(screen.getByText('The request timed out')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(clearError).toHaveBeenCalled()
  })

  it('keeps the ordinary title for other errors', () => {
    renderBanner({ code: 'rpc.internal' })
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('opens diagnostics from the banner action', async () => {
    const { store } = renderBanner({ code: 'rpc.timeout', params: { timeoutMs: 1 } })
    act(() => {
      store.setState({
        diagnosticsSummary: vi.fn(async () => mockDiagnosticsSummary),
      })
    })
    await userEvent.click(screen.getByRole('button', { name: 'Export Diagnostics' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('clears the error when the active session changes', () => {
    const { clearError, store } = renderBanner({ code: 'rpc.internal' })
    expect(clearError).not.toHaveBeenCalled()
    act(() => {
      store.setState({ activeSessionId: 's2' })
    })
    expect(clearError).toHaveBeenCalled()
  })

  it('auto-dismisses timeout errors after a delay', () => {
    vi.useFakeTimers()
    const { clearError } = renderBanner({ code: 'rpc.timeout', params: { timeoutMs: 1 } })
    expect(clearError).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(clearError).toHaveBeenCalled()
  })
})
