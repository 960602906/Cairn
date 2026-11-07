// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProjectSummary, SessionSummary, Settings } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import { searchSessions } from './SessionSearch.js'

afterEach(cleanup)

const summary = (sessionId: string, title: string, projectPath = '/work/api'): SessionSummary => ({
  sessionId,
  title,
  projectPath,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})

const PROJECTS: ProjectSummary[] = [
  { projectId: 'p1', name: 'API 服务', path: '/work/api', createdAt: 1 },
]
const SESSIONS = [
  summary('a', '修复登录失败'),
  summary('b', 'Refactor parser', '/work/web'),
  summary('c', ''),
]

function setup(
  sessions: SessionSummary[] = SESSIONS,
  settings: Partial<Settings> = { providers: [] },
) {
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case 'session.list':
        return { sessions }
      case 'project.list':
        return { projects: PROJECTS }
      case 'settings.get':
        return { locale: 'zh-CN', ...settings }
      case 'settings.shell':
        return { detected: 'bash', options: ['auto'] }
      case 'session.subscribe':
        return { events: [], lastSeq: 0 }
      default:
        return {}
    }
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  return { request, store }
}

const press = (key: string) => userEvent.keyboard(key)

describe('searchSessions', () => {
  it('matches every term in the title or project name, case-insensitively', () => {
    const names = (query: string, limit?: number) =>
      searchSessions(SESSIONS, PROJECTS, query, limit).map((r) => [r.session.sessionId, r.project])
    expect(names('')).toEqual([
      ['a', 'API 服务'],
      ['b', 'web'],
      ['c', 'API 服务'],
    ])
    expect(names('登录')).toEqual([['a', 'API 服务']])
    expect(names('api 登录')).toEqual([['a', 'API 服务']])
    expect(names('PARSER web')).toEqual([['b', 'web']])
    expect(names('parser api')).toEqual([])
    expect(names('', 2)).toHaveLength(2)
  })
})

describe('SessionSearch', () => {
  it('opens from the sidebar, filters and opens a session with the keyboard', async () => {
    const { store } = setup()
    await userEvent.click(await screen.findByRole('button', { name: /^搜索/ }))
    const dialog = await screen.findByRole('dialog', { name: '搜索对话' })
    const options = () => within(dialog).getAllByRole('option')
    await waitFor(() => expect(options()).toHaveLength(3))
    expect(options().map((o) => o.textContent)).toEqual([
      '修复登录失败API 服务',
      'Refactor parserweb',
      '未命名会话API 服务',
    ])
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')

    await press('{ArrowDown}')
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    await press('{ArrowUp}{ArrowUp}')
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')

    await userEvent.type(within(dialog).getByRole('combobox'), 'parser')
    expect(options().map((o) => o.textContent)).toEqual(['Refactor parserweb'])
    await press('{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(store.getState().activeSessionId).toBe('b')
  })

  it('opens with Ctrl+K, also from the settings page, and returns to the conversation', async () => {
    const { store } = setup()
    await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
    expect(await screen.findByRole('heading', { name: '通用与外观' })).toBeTruthy()
    await press('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog', { name: '搜索对话' })
    await userEvent.type(within(dialog).getByRole('combobox'), 'xyz')
    expect(within(dialog).getByText('没有找到匹配的对话')).toBeTruthy()
    await userEvent.clear(within(dialog).getByRole('combobox'))
    await userEvent.click(within(dialog).getAllByRole('option')[0]!)
    expect(store.getState().activeSessionId).toBe('a')
    expect(screen.queryByRole('heading', { name: '通用与外观' })).toBeNull()

    // 再次打开时输入框是空的
    await press('{Control>}k{/Control}')
    const again = await screen.findByRole('dialog', { name: '搜索对话' })
    expect((within(again).getByRole('combobox') as HTMLInputElement).value).toBe('')
    await press('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says there are no conversations yet', async () => {
    setup([])
    await press('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog', { name: '搜索对话' })
    expect(within(dialog).getByText('还没有会话')).toBeTruthy()
    // 没有结果时 Enter 不做任何事
    await press('{Enter}')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('NewSession empty states (M2-12)', () => {
  it('guides to the provider settings and to choosing a folder', async () => {
    setup([], { providers: [] })
    const guide = await screen.findByRole('region', { name: '还没有配置模型供应商' })
    await userEvent.click(within(guide).getByRole('button', { name: '去设置' }))
    expect(await screen.findByRole('heading', { name: '模型供应商' })).toBeTruthy()
  })

  it('hides the provider guide once a provider exists', async () => {
    setup([], {
      providers: [
        { id: 'p', kind: 'openai', displayName: 'P', baseUrl: 'https://p.example', models: [] },
      ],
    })
    expect(await screen.findByRole('heading', { level: 2, name: '新对话' })).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '还没有配置模型供应商' })).toBeNull(),
    )
  })
})
