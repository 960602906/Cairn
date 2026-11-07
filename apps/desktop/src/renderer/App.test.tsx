// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import type { MainApi } from './api.js'

afterEach(cleanup)

function makeStore() {
  const fakeApi = {
    ready: () => Promise.resolve(),
    request: async (method: string) => {
      if (method === 'session.list') return { sessions: [] }
      if (method === 'agent.list') return { agents: [] }
      if (method === 'settings.get') return { providers: [], theme: 'system', language: 'zh-CN' }
      if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
      return {}
    },
    on: () => () => {},
  }
  return createSessionStore(fakeApi as unknown as MainApi)
}

describe('App', () => {
  it('renders the app name and the language switcher without preload', () => {
    const html = renderToStaticMarkup(<App i18n={createI18n('zh-CN')} />)
    expect(html).toMatch(/^<main[^>]*><svg[^>]*aria-label="Cairn"[^>]*>/)
    expect(html).toContain('<h1 class="text-page">Cairn</h1>')
    expect(html).toContain('<label>语言<select>')
    expect(html).not.toContain('事件查看器')
  })

  it('uses the given i18n instance', () => {
    const i18n = createI18n('en-US')
    i18n.addResource('en-US', 'common', 'app.name', 'Cairn Test')
    expect(renderToStaticMarkup(<App i18n={i18n} />)).toContain('>Cairn Test</h1>')
  })

  it('opens settings from the sidebar and returns to the chat', async () => {
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    fireEvent.click(await screen.findByRole('button', { name: /设置/ }))
    expect(await screen.findByRole('navigation', { name: '设置分类' })).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '设置分类' })).toBeNull())
  })

  it('opens settings with Ctrl+, and closes it with Escape', async () => {
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    await screen.findByRole('button', { name: /设置/ })
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(await screen.findByRole('navigation', { name: '设置分类' })).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '设置分类' })).toBeNull())
  })

  it('opens the Agents page and starts a new chat from there', async () => {
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Agents' }))
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined()

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull())
  })
})
