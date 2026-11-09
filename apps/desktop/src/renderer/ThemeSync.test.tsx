// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'

afterEach(cleanup)

describe('ThemeSync', () => {
  it('loads settings and applies the saved theme, then follows updates', async () => {
    let settings: Settings = { locale: 'zh-CN', providers: [], theme: 'paper' }
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'settings.get') return settings
      if (method === 'settings.update') {
        settings = { ...settings, ...(params as Partial<Settings>) }
        return settings
      }
      return {}
    })
    const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
    const store = createSessionStore(api)
    const root = { setAttribute: vi.fn() }
    const env = { root }
    render(
      <SessionStoreProvider store={store}>
        <ThemeSync env={env} />
      </SessionStoreProvider>,
    )
    // 设置读到之前按默认的板岩
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'slate')
    await vi.waitFor(() =>
      expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'paper'),
    )
    await act(() => store.getState().updateSettings({ theme: 'slate' }))
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'slate')
  })
})
