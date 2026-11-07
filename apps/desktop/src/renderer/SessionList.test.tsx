// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type SessionSummary } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import { groupSessions } from './SessionList.js'

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
  it('shows an empty state and the new chat form', async () => {
    setup({ 'session.list': () => ({ sessions: [] }) })
    expect(await screen.findByText('还没有会话')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '新对话' })).toBeTruthy()
    // 没有会话时不能取消
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
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
      '未命名会话运行中',
      '修复登录已崩溃',
      '审批等待审批',
    ])
    expect(screen.getByRole('region', { name: '项目 work' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '项目 other' })).toBeTruthy()

    await userEvent.click(sessionButton(items[1]!))
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))
    expect(request).toHaveBeenCalledWith('session.subscribe', { sessionId: 's2', afterSeq: 0 })
    expect(sessionButton(items[1]!).getAttribute('aria-current')).toBe('true')
    expect(sessionButton(items[0]!).getAttribute('aria-current')).toBeNull()
  })

  it('opens a session from search with Ctrl+K (M2-12)', async () => {
    const user = userEvent.setup()
    const { store } = setup({
      'session.list': () => ({
        sessions: [summary('s1', '修复登录'), summary('s2', '写文档', 'idle', '/docs')],
      }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
      'project.list': () => ({
        projects: [{ projectId: 'p', name: 'API', path: '/work', createdAt: 1 }],
      }),
    })
    await screen.findByRole('button', { name: '修复登录' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog', { name: '搜索会话' })
    await user.type(within(dialog).getByRole('combobox'), '文档')
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['写文档docs'])
    await user.keyboard('{Enter}')
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves the search highlight with the arrow keys, click, and closes again', async () => {
    const user = userEvent.setup()
    const { store } = setup({
      'session.list': () => ({
        sessions: [summary('s1', '修复登录'), summary('s2', '写文档', 'idle', '/docs')],
      }),
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    await screen.findByRole('button', { name: '修复登录' })
    await user.click(screen.getByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '搜索会话' })
    const options = () => within(dialog).getAllByRole('option')
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowUp}')
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    await user.hover(options()[1]!)
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    await user.click(options()[1]!)
    await waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))

    await user.keyboard('{Control>}k{/Control}')
    const again = await screen.findByRole('dialog', { name: '搜索会话' })
    const box = within(again).getByRole('combobox')
    await user.type(box, '没有这回事')
    expect(within(again).getByText('没有匹配的会话')).toBeTruthy()
    // 组字期间方向键不改变高亮
    fireEvent.keyDown(box, { key: 'ArrowDown', isComposing: true })
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowUp}')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 再按一次快捷键打开后，再按一次关闭
    await user.keyboard('{Control>}k{/Control}')
    await screen.findByRole('dialog', { name: '搜索会话' })
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    expect(await screen.findByRole('button', { name: '新标题' })).toBeTruthy()
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

  it('creates a session from the form', async () => {
    const sessions: SessionSummary[] = [summary('s0', '已有')]
    const { request, store } = setup({
      'session.list': () => ({ sessions }),
      'session.create': ({ title }: { title?: string }) => {
        sessions.unshift(summary('s1', title ?? ''))
        return { sessionId: 's1' }
      },
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /新对话/ }))
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
    expect(screen.getByRole('heading', { level: 2, name: '演示' })).toBeTruthy()
  })

  it('opens the form with Ctrl+N and cancels back to the conversation', async () => {
    setup({ 'session.list': () => ({ sessions: [summary('s0', '已有')] }) })
    await screen.findAllByRole('listitem')
    expect(screen.queryByLabelText('项目目录')).toBeNull()
    await userEvent.keyboard('{Control>}n{/Control}')
    expect(screen.getByLabelText('项目目录')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('项目目录')).toBeNull()
  })

  it('keeps the form open and shows the error when creating fails', async () => {
    const { request } = setup({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => {
        throw new RpcError('rpc.invalid_params')
      },
    })
    await userEvent.type(await screen.findByLabelText('项目目录'), 'relative')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect((await screen.findByRole('alert')).textContent).toContain('请求参数无效')
    expect(request).toHaveBeenCalledWith('session.create', { projectPath: 'relative' })
    expect(screen.getByLabelText('项目目录')).toBeTruthy()

    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('collapses and expands the sidebar', async () => {
    setup({ 'session.list': () => ({ sessions: [summary('s0', '已有')] }) })
    await userEvent.click(await screen.findByRole('button', { name: '收起侧栏' }))
    expect(screen.queryByRole('navigation')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('navigation')).toBeTruthy()
  })
})

describe('App without the preload API', () => {
  it('renders only the app name', () => {
    render(<App i18n={createI18n('en-US')} />)
    expect(screen.getByRole('heading').textContent).toBe('Cairn')
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
    const path = (await screen.findByLabelText('项目目录')) as HTMLInputElement
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
