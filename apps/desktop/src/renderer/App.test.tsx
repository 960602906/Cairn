// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import type { MainApi } from './api.js'
import type { ActivityListResult } from '@cairn/protocol'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as typeof window & { cairn?: unknown }).cairn
})

function stubMedia(narrow: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('max-width') ? narrow : false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

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

function makeActivityStore(
  activity: ActivityListResult = emptyActivity,
  sessions: unknown[] = [],
  changeSet?: unknown,
) {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const fakeApi = {
    ready: () => Promise.resolve(),
    request: async (method: string) => {
      if (method === 'session.list') return { sessions }
      if (method === 'agent.list') return { agents: [] }
      if (method === 'settings.get') return { providers: [], theme: 'system', language: 'zh-CN' }
      if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
      if (method === 'activity.list') return activity
      if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
      if (method === 'approval.pending') return { approvals: [] }
      if (method === 'changes.list') return { changes: [] }
      if (method === 'changeset.list') return { changeSets: [] }
      if (method === 'changeset.get' && changeSet) return { changeSet }
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
    fireEvent.click(await screen.findByRole('button', { name: /^设置$/ }))
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

  it('opens the activity center and returns to a new chat', async () => {
    const { store } = makeActivityStore()
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '活动' }))
    expect(await screen.findByRole('heading', { name: '活动' })).toBeDefined()
    expect(screen.getByText('目前没有需要关注的活动')).toBeDefined()

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '活动' })).toBeNull())
  })

  it('keeps the sidebar next to the activity center and offers expand and new chat when collapsed', async () => {
    const { store } = makeActivityStore()
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    expect(screen.queryByRole('navigation', { name: '全局导航' })).toBeNull()
    const activity = await screen.findByRole('button', { name: '活动' })
    fireEvent.click(activity)
    expect(await screen.findByRole('heading', { name: '活动' })).toBeDefined()
    // 活动中心显示在主区，左栏仍在，入口标成当前页。
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '活动' }).getAttribute('aria-current')).toBe('page')

    // 收起左栏后，顶栏左侧出现展开与新对话；展开不会离开活动中心。
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('heading', { name: '活动' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    fireEvent.click(await screen.findByRole('button', { name: '新对话' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '活动' })).toBeNull())
  })

  it('opens search with Ctrl+K and closes settings without restoring the narrow drawer', async () => {
    stubMedia(true)
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByPlaceholderText('按标题或项目名搜索')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByPlaceholderText('按标题或项目名搜索')).toBeNull())

    // 窄窗口下设置入口在左栏抽屉里。
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    fireEvent.click(await screen.findByRole('button', { name: /^设置$/ }))
    expect(await screen.findByRole('navigation', { name: '设置分类' })).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '设置分类' })).toBeNull())
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()
  })

  it('closes the narrow drawer with Escape unless another dialog is open', async () => {
    stubMedia(true)
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    expect(await screen.findByRole('navigation', { name: '会话' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'x' })
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
    dialog.remove()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull())
  })

  it('starts a new chat from the rail and closes the narrow drawer', async () => {
    stubMedia(true)
    render(<App i18n={createI18n('zh-CN')} store={makeStore()} />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    expect(await screen.findByRole('navigation', { name: '会话' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新对话' }))
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull())
    expect(screen.getByPlaceholderText('有什么可以帮你？')).toBeTruthy()
  })

  it('applies platform window-control insets and dismisses onboarding', async () => {
    Object.defineProperty(window, 'cairn', {
      configurable: true,
      value: {
        windowControls: {
          platform: 'win32',
          minimize: vi.fn(async () => undefined),
          toggleMaximize: vi.fn(async () => true),
          close: vi.fn(async () => undefined),
          isMaximized: vi.fn(async () => false),
          onMaximizedChange: vi.fn(() => () => undefined),
        },
      },
    })
    const listeners: ((data: unknown) => void)[] = []
    const fakeApi = {
      ready: () => Promise.resolve(),
      request: async (method: string) => {
        if (method === 'session.list') return { sessions: [] }
        if (method === 'agent.list') return { agents: [] }
        if (method === 'settings.get')
          return {
            providers: [],
            theme: 'system',
            language: 'zh-CN',
            onboardingSeen: false,
          }
        if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
        if (method === 'activity.list')
          return { approvals: [], running: [], completed: [], counts: { approvals: 0, running: 0 } }
        if (method === 'settings.update') {
          listeners.forEach((listener) => listener({}))
          return {}
        }
        return {}
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)
    const { container } = render(<App i18n={createI18n('zh-CN')} store={store} />)
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        '--window-controls-inset',
      ),
    ).toBe('150px')

    fireEvent.click(await screen.findByRole('button', { name: '稍后' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '稍后' })).toBeNull())
  })

  it('opens the activity session without a change set on narrow windows', async () => {
    stubMedia(true)
    const activity: ActivityListResult = {
      ...emptyActivity,
      completed: [
        {
          sessionId: 's1',
          sessionTitle: '修复登录',
          runId: 'r1',
          turnId: 't1',
          agent: { id: 'builtin.coder', version: 1 },
          status: 'completed',
          summary: '完成',
          completedAt: 10,
        },
      ],
    }
    const { store } = makeActivityStore(activity, [
      {
        sessionId: 's1',
        title: '修复登录',
        projectPath: '/work',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    fireEvent.click(await screen.findByRole('button', { name: '活动' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看' }))
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()
  })

  it('closes the narrow drawer when selecting a session or opening an activity item', async () => {
    stubMedia(true)
    const { store, emit } = makeActivityStore(emptyActivity, [
      {
        sessionId: 's1',
        title: '修复登录',
        projectPath: '/work',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    render(<App i18n={createI18n('zh-CN')} store={store} />)

    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    const item = await screen.findByRole('listitem')
    fireEvent.click(within(item).getAllByRole('button')[0]!)
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    fireEvent.click(await screen.findByRole('button', { name: '活动' }))
    emit('activity.open', { sessionId: 's1' })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '活动' })).toBeNull())
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()
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

  it('opens the change set review from a completed activity item (M4-10)', async () => {
    const activity: ActivityListResult = {
      ...emptyActivity,
      completed: [
        {
          sessionId: 's1',
          sessionTitle: '修复登录',
          runId: 'r1',
          turnId: 't1',
          agent: { id: 'builtin.coder', version: 1 },
          status: 'completed',
          summary: '完成',
          completedAt: 10,
          changeSetId: 'cs1',
        },
      ],
    }
    const detail = {
      changeSetId: 'cs1',
      sessionId: 's1',
      runId: 'child1',
      baseCommit: 'a'.repeat(40),
      status: 'pending',
      createdAt: 10,
      conflicts: 0,
      files: [],
    }
    const { store } = makeActivityStore(
      activity,
      [
        {
          sessionId: 's1',
          title: '修复登录',
          projectPath: '/work',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      detail,
    )
    render(<App i18n={createI18n('zh-CN')} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '活动' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看改动' }))
    expect(await screen.findByRole('region', { name: '改动集审阅' })).toBeTruthy()
    expect(store.getState().activeSessionId).toBe('s1')
  })
})
