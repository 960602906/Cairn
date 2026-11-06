// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@nexus/i18n'
import { RpcError, type SessionSummary } from '@nexus/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

const summary = (sessionId: string, title: string, status: SessionSummary['status'] = 'idle') => ({
  sessionId,
  title,
  projectPath: '/work',
  status,
  createdAt: 1,
  updatedAt: 1,
})

function setup(overrides: Record<string, (params: never) => unknown> = {}) {
  const handlers: Record<string, (params: never) => unknown> = {
    'project.list': () => ({ projects: [] }),
    ...overrides,
  }
  const request = vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method]
    return handler ? handler(params as never) : {}
  })
  const api = {
    ready: () => Promise.resolve(),
    request,
    on: () => () => {},
  } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  return { request, store }
}

describe('SessionList', () => {
  it('shows an empty state', async () => {
    setup({ 'session.list': () => ({ sessions: [] }) })
    expect(await screen.findByText('还没有会话')).toBeTruthy()
  })

  it('lists sessions with their status and selects one on click', async () => {
    const { request, store } = setup({
      'session.list': () => ({
        sessions: [summary('s1', '', 'running'), summary('s2', '修复登录', 'crashed')],
      }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    const items = await screen.findAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['未命名会话运行中', '修复登录已崩溃'])

    await userEvent.click(within(items[1]!).getByRole('button'))
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))
    expect(request).toHaveBeenCalledWith('session.subscribe', { sessionId: 's2', afterSeq: 0 })
    expect(within(items[1]!).getByRole('button').getAttribute('aria-current')).toBe('true')
    expect(within(items[0]!).getByRole('button').getAttribute('aria-current')).toBeNull()
  })

  it('creates a session from the form', async () => {
    const sessions: SessionSummary[] = []
    const { request, store } = setup({
      'session.list': () => ({ sessions }),
      'session.create': ({ title }: { title?: string }) => {
        sessions.push(summary('s1', title ?? ''))
        return { sessionId: 's1' }
      },
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    const create = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('项目目录'), '  /work/demo  ')
    await userEvent.type(screen.getByLabelText('标题（可选）'), '演示')
    await userEvent.click(create)

    await waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
    expect(request).toHaveBeenCalledWith('session.create', {
      projectPath: '/work/demo',
      title: '演示',
    })
    expect(screen.queryByLabelText('项目目录')).toBeNull()
    expect(screen.getByRole('listitem').textContent).toBe('演示空闲')
  })

  it('keeps the form open and shows the error when creating fails', async () => {
    const { request } = setup({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => {
        throw new RpcError('rpc.invalid_params')
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    await userEvent.type(screen.getByLabelText('项目目录'), 'relative')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect((await screen.findByRole('alert')).textContent).toContain('请求参数无效')
    expect(request).toHaveBeenCalledWith('session.create', { projectPath: 'relative' })
    expect(screen.getByLabelText('项目目录')).toBeTruthy()

    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('项目目录')).toBeNull()
  })
})

describe('App without the preload API', () => {
  it('renders only the app name', () => {
    render(<App i18n={createI18n('en-US')} />)
    expect(screen.getByRole('heading').textContent).toBe('NEXUS-OS')
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('fills the project folder from the folder dialog or a recent project', async () => {
    const recent = { projectId: 'p1', name: 'api', path: '/work/api', createdAt: 1 }
    const opened = { projectId: 'p2', name: 'web', path: '/work/web', createdAt: 2 }
    const results = [{ project: opened }, {}]
    const { request } = setup({
      'session.list': () => ({ sessions: [] }),
      'project.list': () => ({ projects: [recent] }),
      'project.open': () => results.shift(),
      'session.create': () => ({ sessionId: 's9' }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    const path = screen.getByLabelText('项目目录') as HTMLInputElement
    const recentSelect = (await screen.findByLabelText('最近的项目')) as HTMLSelectElement
    await userEvent.selectOptions(recentSelect, '/work/api')
    expect(path.value).toBe('/work/api')

    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => expect(path.value).toBe('/work/web'))
    // 新打开的项目排在最前面
    expect([...recentSelect.options].map((o) => o.value)).toEqual(['', '/work/web', '/work/api'])
    expect(recentSelect.value).toBe('/work/web')

    // 取消对话框时不改动
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() =>
      expect(request.mock.calls.filter(([m]) => m === 'project.open')).toHaveLength(2),
    )
    expect(path.value).toBe('/work/web')
    await userEvent.selectOptions(recentSelect, '')
    expect(path.value).toBe('/work/web')

    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.create', { projectPath: '/work/web' }),
    )
  })
})
