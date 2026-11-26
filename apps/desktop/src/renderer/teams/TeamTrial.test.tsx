// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { TeamTrial } from './TeamTrial.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const historyItem = {
  sessionId: 'tt0',
  teamId: 'team-1',
  agent: { id: 'builtin.coder', draftHash: 'a0' },
  projectPath: '/work',
  title: '旧团队试运行',
  createdAt: 1,
  updatedAt: 2,
}

function setup(
  options: { noHistory?: boolean; openProject?: boolean; promptFails?: boolean } = {},
) {
  let starts = 0
  const calls: { method: string; params: unknown }[] = []
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'project.list')
        return {
          projects: [
            { projectId: 'p1', name: '项目', path: '/work' },
            { projectId: 'p2', name: '另一个项目', path: '/other' },
          ],
        }
      if (method === 'team.trial.list')
        return options.noHistory === true ? {} : { trials: [historyItem] }
      if (method === 'team.trial.start') {
        starts += 1
        const input = params as { teamId: string; useAgentPermissions?: boolean }
        return {
          sessionId: `tt${starts}`,
          teamId: input.teamId,
          teamDraftHash: `h${starts}`,
          agent: { id: 'builtin.coder', draftHash: `a${starts}` },
          useAgentPermissions: input.useAgentPermissions === true,
        }
      }
      if (method === 'team.trial.clear') return { cleared: 2 }
      if (method === 'session.prompt') {
        if (options.promptFails) throw new RpcError('rpc.closed')
        return { accepted: true }
      }
      if (method === 'project.open')
        return options.openProject === false
          ? {}
          : { project: { projectId: 'p3', name: '新项目', path: '/picked' } }
      if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
      return {}
    },
    on: () => () => {},
  }
  return { store: createSessionStore(api as unknown as MainApi), calls }
}

function element(
  store: ReturnType<typeof createSessionStore>,
  configKey: string,
  onOpenChange: (open: boolean) => void = vi.fn(),
) {
  return (
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <TeamTrial teamId="team-1" configKey={configKey} open onOpenChange={onOpenChange} />
      </SessionStoreContext.Provider>
    </I18nextProvider>
  )
}

describe('TeamTrial', () => {
  it('lists history, starts a trial, restarts on config change, and clears history', async () => {
    const { store, calls } = setup()
    await store.getState().refreshProjects()
    const onOpenChange = vi.fn()
    const view = render(element(store, 'draft-1', onOpenChange))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())
    expect(screen.getByText('团队试运行')).toBeDefined()

    fireEvent.click(screen.getByRole('switch', { name: '使用 Agent 自身的权限' }))
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.trial.start',
        params: {
          teamId: 'team-1',
          projectPath: '/work',
          useAgentPermissions: true,
        },
      }),
    )
    expect(store.getState().trial).toMatchObject({
      sessionId: 'tt1',
      teamId: 'team-1',
      draftHash: 'h1',
      projectPath: '/work',
      useAgentPermissions: true,
      configKey: 'draft-1',
    })

    // 草稿变化：提示用新配置重新开始，重新开始会创建一个新的隐藏会话。
    view.rerender(element(store, 'draft-2', onOpenChange))
    expect(screen.getByText(/配置已变化/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }))
    await waitFor(() =>
      expect(store.getState().trial).toMatchObject({
        sessionId: 'tt2',
        teamId: 'team-1',
        configKey: 'draft-2',
      }),
    )
    expect(calls.filter((call) => call.method === 'team.trial.start')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '清除记录' }))
    await waitFor(() => expect(screen.getByText(/已清除 2 条试运行记录/)).toBeDefined())
    expect(store.getState().trial?.sessionId).toBe('tt2')
  })

  it('changes the project, sends and stops a prompt, restarts on permission change, and closes', async () => {
    const { store, calls } = setup()
    await store.getState().refreshProjects()
    const onOpenChange = vi.fn()
    render(element(store, 'draft-1', onOpenChange))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())

    // 换一个项目再开始，开始参数跟着选择走。
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '/other' } })
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.trial.start',
        params: {
          teamId: 'team-1',
          projectPath: '/other',
          useAgentPermissions: false,
        },
      }),
    )

    // 发送消息后进入运行中，可以停止。
    fireEvent.change(screen.getByLabelText('试运行输入'), {
      target: { value: '检查一下' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.prompt',
        params: { sessionId: 'tt1', content: [{ type: 'text', text: '检查一下' }] },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.abort',
        params: { sessionId: 'tt1' },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('button', { name: '停止' })).toBeNull())

    // 运行中切换权限模式会重新开始一个新的隐藏会话。
    fireEvent.click(screen.getByRole('switch', { name: '使用 Agent 自身的权限' }))
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'team.trial.start')).toHaveLength(2),
    )
    expect(store.getState().trial).toMatchObject({ sessionId: 'tt2', useAgentPermissions: true })

    fireEvent.click(screen.getByRole('button', { name: '关闭试运行' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(calls.some((call) => call.method === 'session.unsubscribe')).toBe(true)
    expect(store.getState().trial).toBeUndefined()
  })

  it('sends with ⌘Enter and clears the input', async () => {
    const { store, calls } = setup()
    await store.getState().refreshProjects()
    render(element(store, 'draft-1'))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(screen.getByLabelText('试运行输入')).toBeDefined())

    const input = screen.getByLabelText('试运行输入')
    fireEvent.change(input, { target: { value: '快捷发送' } })
    // 不带 ⌘ / Ctrl 的 Enter 只换行，不发送。
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.some((call) => call.method === 'session.prompt')).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.prompt',
        params: { sessionId: 'tt1', content: [{ type: 'text', text: '快捷发送' }] },
      }),
    )
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''))
  })

  it('keeps the draft text when sending fails', async () => {
    const { store, calls } = setup({ promptFails: true })
    await store.getState().refreshProjects()
    render(element(store, 'draft-1'))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(screen.getByLabelText('试运行输入')).toBeDefined())

    const input = screen.getByLabelText('试运行输入')
    fireEvent.change(input, { target: { value: '不会丢' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'session.prompt')).toBe(true))
    await waitFor(() => expect(store.getState().error?.code).toBe('rpc.closed'))
    expect((input as HTMLTextAreaElement).value).toBe('不会丢')
  })

  it('picks a project from the folder dialog before starting', async () => {
    const { store, calls } = setup()
    await store.getState().refreshProjects()
    render(element(store, 'draft-1'))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    await waitFor(() =>
      expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/picked'),
    )
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.trial.start',
        params: { teamId: 'team-1', projectPath: '/picked', useAgentPermissions: false },
      }),
    )
  })

  it('keeps the project selection when the folder dialog is cancelled', async () => {
    const { store, calls } = setup({ openProject: false })
    await store.getState().refreshProjects()
    render(element(store, 'draft-1'))
    await waitFor(() => expect(screen.getByText('旧团队试运行')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'project.open')).toBe(true))
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/work')
  })

  it('shows an empty history when the trial list is unavailable', async () => {
    const { store } = setup({ noHistory: true })
    await store.getState().refreshProjects()
    render(element(store, 'draft-1'))
    await waitFor(() => expect(screen.getByText('还没有试运行记录。')).toBeDefined())
  })

  it('ignores another team’s trial and shows the start entry', async () => {
    const { store } = setup()
    await store.getState().refreshProjects()
    await store.getState().startTeamTrial({
      teamId: 'other-team',
      projectPath: '/work',
      configKey: 'other',
    })
    render(element(store, 'draft-1'))
    expect(screen.getByRole('button', { name: '开始试运行' })).toBeDefined()
    expect(screen.queryByLabelText('试运行输入')).toBeNull()
  })
})
