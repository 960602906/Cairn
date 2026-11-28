// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import { ErrorBanner } from './ErrorBanner.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

afterEach(() => cleanup())

function renderBanner(error: { code: string; params?: Record<string, unknown> } | undefined) {
  const clearError = vi.fn()
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
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
})
