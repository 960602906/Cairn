// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type SessionSummary } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import { formatSessionTime, groupSessions } from './SessionList.js'

afterEach(cleanup)

const summary = (
  sessionId: string,
  title: string,
  status: SessionSummary['status'] = 'idle',
  projectPath = '/work',
): SessionSummary => ({
  sessionId,
  title,
  projectPath,
  status,
  createdAt: 1,
  updatedAt: 1,
})

function setup(overrides: Record<string, (params: never) => unknown> = {}) {
  const handlers: Record<string, (params: never) => unknown> = {
    'settings.get': () => ({
      providers: [
        {
          id: 'fake',
          kind: 'openai',
          displayName: '测试供应商',
          baseUrl: 'https://example.com',
          models: [{ id: 'fast', displayName: '快' }],
        },
      ],
      defaultModel: { providerId: 'fake', modelId: 'fast' },
    }),
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

const sessionButton = (item: HTMLElement) => within(item).getAllByRole('button')[0]!

describe('groupSessions', () => {
  it('groups by project in order of the most recent session, naming by project or folder', () => {
    const groups = groupSessions(
      [
        summary('a', 'A', 'idle', '/work/api'),
        summary('b', 'B', 'idle', 'C:\\code\\web\\'),
        summary('c', 'C', 'idle', '/work/api'),
      ],
      [{ projectId: 'p1', name: 'API 服务', path: '/work/api', createdAt: 1 }],
    )
    expect(groups.map((g) => [g.name, g.sessions.map((s) => s.sessionId)])).toEqual([
      ['API 服务', ['a', 'c']],
      ['web', ['b']],
    ])
  })
})

describe('SessionList', () => {
  it('does not repeat the session empty state when there are no workspaces', async () => {
    setup({ 'session.list': () => ({ sessions: [] }) })
    expect(await screen.findByText('还没有工作空间')).toBeTruthy()
    expect(screen.queryByText('还没有会话')).toBeNull()
    expect(screen.getByPlaceholderText('有什么可以帮你？')).toBeTruthy()
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not show a session empty state when a workspace exists', async () => {
    setup({
      'project.list': () => ({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work/demo', createdAt: 1 }],
      }),
      'session.list': () => ({ sessions: [] }),
    })
    expect(await screen.findByRole('button', { name: 'demo 的会话' })).toBeTruthy()
    expect(screen.queryByText('还没有会话')).toBeNull()
    expect(screen.queryByText('还没有工作空间')).toBeNull()
  })

  it('does not repeat sessions that already sit under a workspace', async () => {
    setup({
      'project.list': () => ({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
      }),
      'session.list': () => ({ sessions: [summary('s1', '工作空间里的会话')] }),
    })
    expect(await screen.findByText('工作空间里的会话')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'demo 的会话' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '项目 work' })).toBeNull()
    expect(screen.queryByRole('region', { name: '项目 demo' })).toBeNull()
  })

  it('lists sessions grouped by project with their status and selects one on click', async () => {
    const { request, store } = setup({
      'session.list': () => ({
        sessions: [
          summary('s1', '', 'running'),
          summary('s2', '修复登录', 'crashed'),
          summary('s3', '审批', 'waiting_approval', '/other'),
        ],
      }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    const items = await screen.findAllByRole('listitem')
    expect(items.map((li) => sessionButton(li).textContent)).toEqual([
      expect.stringMatching(/^未命名会话.+运行中$/),
      expect.stringMatching(/^修复登录.+已崩溃$/),
      expect.stringMatching(/^审批.+等待审批$/),
    ])
    expect(screen.getByRole('region', { name: '项目 work' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '项目 other' })).toBeTruthy()
    expect(
      screen.getByRole('region', { name: '项目 work' }).querySelector('img')?.getAttribute('src'),
    ).toBe('./folder-open.svg')
    expect(screen.getByRole('region', { name: '项目 work' }).querySelector('h3 img')).not.toBeNull()

    await userEvent.click(sessionButton(items[1]!))
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))
    expect(request).toHaveBeenCalledWith('session.subscribe', { sessionId: 's2', afterSeq: 0 })
    expect(sessionButton(items[1]!).getAttribute('aria-current')).toBe('true')
    expect(sessionButton(items[0]!).getAttribute('aria-current')).toBeNull()
  })

  it('collapses a project group and swaps its folder icon', async () => {
    setup({
      'session.list': () => ({
        sessions: [summary('s1', '第一项'), summary('s2', '第二项')],
      }),
    })
    const group = await screen.findByRole('region', { name: '项目 work' })
    const toggle = within(group).getByRole('button', { name: /^work/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(group.querySelector('h3 img')?.getAttribute('src')).toBe('./folder-open.svg')
    expect(group.querySelector('h3 svg.lucide-chevron-right')?.getAttribute('class')).toContain(
      'rotate-90',
    )
    expect(within(group).getAllByRole('listitem')).toHaveLength(2)

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(group.querySelector('h3 img')?.getAttribute('src')).toBe('./folder.svg')
    expect(group.querySelector('h3 svg.lucide-chevron-right')?.getAttribute('class')).not.toContain(
      'rotate-90',
    )
    expect(within(group).queryByRole('listitem')).toBeNull()

    await userEvent.click(toggle)
    expect(within(group).getAllByRole('listitem')).toHaveLength(2)
  })

  it('previews long project groups and expands the remaining sessions', async () => {
    setup({
      'session.list': () => ({
        sessions: Array.from({ length: 10 }, (_, index) => summary(`s${index}`, `会话 ${index}`)),
      }),
    })
    const group = await screen.findByRole('region', { name: '项目 work' })
    expect(within(group).getAllByRole('listitem')).toHaveLength(8)

    await userEvent.click(within(group).getByRole('button', { name: '展开剩余 2 个' }))
    expect(within(group).getAllByRole('listitem')).toHaveLength(10)

    await userEvent.click(within(group).getByRole('button', { name: '收起' }))
    expect(within(group).getAllByRole('listitem')).toHaveLength(8)
  })

  it('renames a session in place; Esc cancels and unchanged titles are not saved', async () => {
    let sessions = [summary('s1', '旧标题')]
    const { request } = setup({
      'session.list': () => ({ sessions }),
      'session.rename': ({ title }: { title: string }) => {
        sessions = [summary('s1', title.trim())]
        return {}
      },
    })
    const item = (await screen.findAllByRole('listitem'))[0]!
    const rename = async () => {
      await userEvent.click(within(item).getByRole('button', { name: '会话操作' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
      return screen.getByLabelText('会话标题') as HTMLInputElement
    }

    let input = await rename()
    expect(input.value).toBe('旧标题')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('会话标题')).toBeNull()

    input = await rename()
    fireEvent.blur(input)
    expect(request.mock.calls.some(([m]) => m === 'session.rename')).toBe(false)

    input = await rename()
    await userEvent.clear(input)
    await userEvent.type(input, '新标题{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.rename', { sessionId: 's1', title: '新标题' }),
    )
    expect(await screen.findByRole('button', { name: /^新标题/ })).toBeTruthy()
  })

  it('deletes a session after confirming', async () => {
    let sessions = [summary('s1', '要删除的'), summary('s2', '保留')]
    const { request } = setup({
      'session.list': () => ({ sessions }),
      'session.archive': ({ sessionId }: { sessionId: string }) => {
        sessions = sessions.filter((s) => s.sessionId !== sessionId)
        return {}
      },
    })
    const item = (await screen.findAllByRole('listitem'))[0]!
    const askDelete = async () => {
      await userEvent.click(within(item).getByRole('button', { name: '会话操作' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
      return screen.findByRole('dialog', { name: '删除会话“要删除的”？' })
    }

    let dialog = await askDelete()
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(request.mock.calls.some(([m]) => m === 'session.archive')).toBe(false)

    dialog = await askDelete()
    await userEvent.click(within(dialog).getByRole('button', { name: '删除会话' }))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))
    expect(request).toHaveBeenCalledWith('session.archive', { sessionId: 's1' })
  })

  it('restores an archived session from its menu', async () => {
    let sessions = [summary('s1', '已归档的会话', 'archived')]
    const { request } = setup({
      'session.list': () => ({ sessions }),
      'session.unarchive': () => {
        sessions = [summary('s1', '已归档的会话')]
        return {}
      },
    })
    const item = (await screen.findAllByRole('listitem'))[0]!
    await userEvent.click(within(item).getByRole('button', { name: '会话操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '取消归档' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.unarchive', { sessionId: 's1' }),
    )
  })

  it('reloads the session list with archived sessions from the sidebar toggle', async () => {
    const { request } = setup({ 'session.list': () => ({ sessions: [] }) })
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.list', { includeArchived: false }),
    )
    await userEvent.click(await screen.findByRole('button', { name: '显示已归档内容' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.list', { includeArchived: true }),
    )
    expect(screen.getByRole('button', { name: '隐藏已归档内容' })).toBeTruthy()
  })

  it('creates a session from the first message', async () => {
    const sessions: SessionSummary[] = [summary('s0', '已有')]
    const { request, store } = setup({
      'session.list': () => ({ sessions }),
      'project.list': () => ({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
      }),
      'session.create': ({ title }: { title?: string }) => {
        sessions.unshift(summary('s1', title ?? ''))
        return { sessionId: 's1' }
      },
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    await screen.findAllByRole('listitem')
    await userEvent.keyboard('{Control>}n{/Control}')
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await userEvent.type(screen.getByPlaceholderText('有什么可以帮你？'), ' 演示 ')
    await userEvent.click(send)

    await waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
    expect(request).toHaveBeenCalledWith('session.create', {
      projectPath: '/work',
      title: '演示',
    })
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: [{ type: 'text', text: '演示' }],
    })
    expect(screen.queryByPlaceholderText('有什么可以帮你？')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: '演示' })).toBeTruthy()
  })

  it('opens the composer with Ctrl+N and returns by selecting a session', async () => {
    const { store } = setup({
      'session.list': () => ({ sessions: [summary('s0', '已有')] }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    const items = await screen.findAllByRole('listitem')
    await userEvent.click(sessionButton(items[0]!))
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s0'))
    expect(screen.queryByPlaceholderText('有什么可以帮你？')).toBeNull()
    await userEvent.keyboard('{Control>}n{/Control}')
    expect(screen.getByPlaceholderText('有什么可以帮你？')).toBeTruthy()
    const currentItems = await screen.findAllByRole('listitem')
    await userEvent.click(sessionButton(currentItems[0]!))
    await waitFor(() => expect(screen.queryByPlaceholderText('有什么可以帮你？')).toBeNull())
  })

  it('keeps the composer open and shows the error when creating fails', async () => {
    const { request } = setup({
      'session.list': () => ({ sessions: [] }),
      'project.list': () => ({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
      }),
      'session.create': () => {
        throw new RpcError('rpc.invalid_params')
      },
    })
    await userEvent.type(await screen.findByPlaceholderText('有什么可以帮你？'), '修复')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect((await screen.findByRole('alert')).textContent).toContain('请求参数无效')
    expect(request).toHaveBeenCalledWith('session.create', {
      projectPath: '/work',
      title: '修复',
    })
    expect(screen.getByPlaceholderText('有什么可以帮你？')).toBeTruthy()

    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('collapses and expands the sidebar from the icon rail', async () => {
    setup({ 'session.list': () => ({ sessions: [summary('s0', '已有')] }) })
    await userEvent.click(await screen.findByRole('button', { name: '收起侧栏' }))
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
  })
})

describe('App without the preload API', () => {
  it('renders only the app name', () => {
    render(<App i18n={createI18n('en-US')} />)
    expect(screen.getByRole('heading').textContent).toBe('Cairn')
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('chooses the workspace from the composer or the folder dialog', async () => {
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
    const workspace = () => screen.getByRole('button', { name: /^工作空间：/ })
    await waitFor(() => expect(workspace().getAttribute('aria-label')).toBe('工作空间：api'))

    await userEvent.click(workspace())
    await userEvent.click(await screen.findByRole('menuitem', { name: '选择文件夹…' }))
    await waitFor(() => expect(workspace().getAttribute('aria-label')).toBe('工作空间：web'))

    // 取消对话框时不改动
    await userEvent.click(workspace())
    await userEvent.click(await screen.findByRole('menuitem', { name: '选择文件夹…' }))
    await waitFor(() =>
      expect(request.mock.calls.filter(([m]) => m === 'project.open')).toHaveLength(2),
    )
    expect(workspace().getAttribute('aria-label')).toBe('工作空间：web')

    await userEvent.click(workspace())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'api' }))
    expect(workspace().getAttribute('aria-label')).toBe('工作空间：api')

    await userEvent.type(screen.getByPlaceholderText('有什么可以帮你？'), '你好')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.create', {
        projectPath: '/work/api',
        title: '你好',
      }),
    )
  })
})

describe('formatSessionTime', () => {
  const now = new Date(2026, 10, 11, 21, 30).getTime()
  it('shows the time today, “yesterday” and month-day before that', () => {
    expect(formatSessionTime(new Date(2026, 10, 11, 9, 5).getTime(), '昨天', now)).toBe('09:05')
    expect(formatSessionTime(new Date(2026, 10, 10, 23, 0).getTime(), '昨天', now)).toBe('昨天')
    expect(formatSessionTime(new Date(2026, 9, 3, 8, 0).getTime(), '昨天', now)).toBe('10-03')
    expect(formatSessionTime(Number.NaN, '昨天', now)).toBe('')
  })
})
