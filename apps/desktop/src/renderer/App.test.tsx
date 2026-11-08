// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import type { MainApi } from './api.js'
import type { ActivityListResult } from '@cairn/protocol'

afterEach(cleanup)

function makeStore() {
  const fakeApi = {
    ready: () => Promise.resolve(),
    request: async (method: string) => {
      if (method === 'session.list') return { sessions: [] }
      if (method === 'agent.list') return { agents: [] }
      if (method === 'settings.get') return { providers: [], theme: 'system', language: 'zh-CN' }
      if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
      if (method === 'activity.list')
        return { approvals: [], running: [], completed: [], counts: { approvals: 0, running: 0 } }
      return {}
    },
    on: () => () => {},
  }
  return createSessionStore(fakeApi as unknown as MainApi)
}

const emptyActivity: ActivityListResult = {
  approvals: [],
  running: [],
  completed: [],
  counts: { approvals: 0, running: 0 },
}

function makeActivityStore(activity: ActivityListResult = emptyActivity) {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const fakeApi = {
    ready: () => Promise.resolve(),
    request: async (method: string) => {
      if (method === 'session.list') return { sessions: [] }
      if (method === 'agent.list') return { agents: [] }
      if (method === 'settings.get') return { providers: [], theme: 'system', language: 'zh-CN' }
      if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
      if (method === 'activity.list') return activity
      if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
      if (method === 'approval.pending') return { approvals: [] }
      if (method === 'changes.list') return { changes: [] }
      return {}
    },
    on: (name: string, listener: (data: unknown) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
  }
  return {
    store: createSessionStore(fakeApi as unknown as MainApi),
    emit: (name: string, data: unknown) =>
      listeners.get(name)?.forEach((listener) => listener(data)),
  }
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

  it('opens the activity center and returns to a new chat', async () => {
    const { store } = makeActivityStore()
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '活动' }))
    expect(await screen.findByRole('heading', { name: '活动' })).toBeDefined()
    expect(screen.getByText('目前没有需要关注的活动')).toBeDefined()

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '活动' })).toBeNull())
  })

  it('shows the approval badge and opens the session requested by a notification', async () => {
    const activity: ActivityListResult = {
      ...emptyActivity,
      counts: { approvals: 2, running: 0 },
    }
    const { store, emit } = makeActivityStore(activity)
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '活动，2 个待审批' }))
    await screen.findByRole('heading', { name: '活动' })

    emit('activity.open', { sessionId: 's1' })
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
    expect(screen.queryByRole('heading', { name: '活动' })).toBeNull()
  })
})
