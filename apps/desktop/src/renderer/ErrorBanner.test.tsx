// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { MainApi } from './api.js'
import { ErrorBanner } from './ErrorBanner.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

afterEach(cleanup)

describe('ErrorBanner', () => {
  it('uses the danger banner and can be dismissed (M2-12)', async () => {
    const api = {
      ready: async () => {},
      request: vi.fn(async () => ({})),
      on: () => () => {},
    } as unknown as MainApi
    const store = createSessionStore(api)
    store.setState({ error: { code: 'rpc.invalid_params' } })
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <ErrorBanner />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('bg-danger-soft')
    expect(alert.className).not.toContain('bg-raise')
    expect(alert.textContent).toContain('请求参数无效')
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(store.getState().error).toBeUndefined()
  })
})
