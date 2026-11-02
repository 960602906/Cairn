// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@nexus/i18n'
import { RpcError } from '@nexus/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

function storeWith(update: (patch: { locale: string }) => unknown) {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'settings.update') return update(params as { locale: string })
    if (method === 'session.list') return { sessions: [] }
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  return { store: createSessionStore(api), request }
}

describe('LanguageSwitcher', () => {
  it('switches the interface language immediately and saves it', async () => {
    const { store, request } = storeWith((patch) => patch)
    const i18n = createI18n('zh-CN')
    render(<App i18n={i18n} store={store} />)
    expect(await screen.findByText('还没有会话')).toBeTruthy()
    const select = screen.getByLabelText('语言') as HTMLSelectElement
    expect(select.value).toBe('zh-CN')
    expect([...select.options].map((o) => o.textContent)).toEqual(['简体中文', 'English'])

    await userEvent.selectOptions(select, 'en-US')
    expect(await screen.findByText('No sessions yet')).toBeTruthy()
    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('en-US')
    expect(i18n.language).toBe('en-US')
    expect(request).toHaveBeenCalledWith('settings.update', { locale: 'en-US' })
  })

  it('keeps the new language and shows an error when saving fails', async () => {
    const { store } = storeWith(() => {
      throw new RpcError('settings.write_failed')
    })
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    await userEvent.selectOptions(screen.getByLabelText('语言'), 'en-US')
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to save settings')
    expect(screen.getByText('No sessions yet')).toBeTruthy()
  })

  it('only switches the language without preload', async () => {
    const i18n = createI18n('en-US')
    render(<App i18n={i18n} />)
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'zh-CN')
    await waitFor(() => expect(screen.getByLabelText('语言')).toBeTruthy())
    expect(i18n.language).toBe('zh-CN')
  })
})
