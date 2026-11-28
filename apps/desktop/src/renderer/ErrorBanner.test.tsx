// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import { ErrorBanner } from './ErrorBanner.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

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
        diagnosticsSummary: vi.fn(async () => ({
          app: { name: 'Cairn', version: '0.0.0', commit: 'abc' },
          platform: { os: 'linux', arch: 'x64' },
          session: undefined,
          includeSensitiveContent: false,
          exportItems: [],
        })),
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
