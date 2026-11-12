// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { PendingApproval } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { AgentTrial } from './AgentTrial.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const started = {
  sessionId: 'trial-1',
  agent: { id: 'user.custom', draftHash: 'h1' },
  draftHash: 'h1',
  useAgentPermissions: false,
}

const archivedTrial = {
  sessionId: 'trial-0',
  agent: { id: 'user.custom', draftHash: 'h0' },
  projectPath: '/work',
  title: '旧试运行',
  createdAt: 1,
  updatedAt: 2,
}

const approval: PendingApproval = {
  approvalId: 'a1',
  toolCallId: 'call-a1',
  runId: 'r1',
  agent: { id: 'user.custom', draftHash: 'h1' },
  tool: { name: 'run_command', category: 'execute' },
  input: { command: 'npm test' },
  targets: { command: 'npm test' },
  kind: 'tool',
  preview: { summary: 'Run npm test', command: 'npm test' },
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
}

function setup(
  handlers: Record<string, (params: unknown) => unknown> = {},
  projects = [{ projectId: 'p1', name: '项目', path: '/work' }],
) {
  const calls: { method: string; params: unknown }[] = []
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      const handler = handlers[method]
      if (handler) return handler(params)
      if (method === 'project.list') return { projects }
      if (method === 'trial.list') return { trials: [archivedTrial] }
      if (method === 'trial.start')
        return {
          ...started,
          useAgentPermissions:
            (params as { useAgentPermissions?: boolean }).useAgentPermissions === true,
        }
      if (method === 'trial.restart')
        return {
          ...started,
          useAgentPermissions:
            (params as { useAgentPermissions?: boolean }).useAgentPermissions === true,
        }
      if (method === 'trial.clear') return { cleared: 2 }
      if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
      if (method === 'approval.pending') return { approvals: [approval] }
      return {}
    },
    on: () => () => {},
  }
  const store = createSessionStore(api as unknown as MainApi)
  return { store, calls }
}

function trialElement(
  store: ReturnType<typeof createSessionStore>,
  configKey: string,
  onOpenChange: (open: boolean) => void,
) {
  return (
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentTrial agentId="user.custom" configKey={configKey} open onOpenChange={onOpenChange} />
      </SessionStoreContext.Provider>
    </I18nextProvider>
  )
}

function renderTrial(store: ReturnType<typeof createSessionStore>, configKey = 'k1') {
  const onOpenChange = vi.fn()
  const view = render(trialElement(store, configKey, onOpenChange))
  return {
    onOpenChange,
    rerender: (nextKey: string) => view.rerender(trialElement(store, nextKey, onOpenChange)),
  }
}

describe('AgentTrial', () => {
  it('starts a trial, sends a prompt, handles approvals, and clears history', async () => {
    const { store, calls } = setup()
    await store.getState().refreshProjects()
    const { onOpenChange, rerender } = renderTrial(store)
    await waitFor(() => expect(screen.getByText('旧试运行')).toBeDefined())

    // 默认项目来自已打开的项目；切换到 Agent 自己的权限。
    expect(screen.getByLabelText('项目')).toBeDefined()
    fireEvent.click(screen.getByRole('switch', { name: '使用 Agent 自身的权限' }))
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'trial.start',
        params: {
          agentId: 'user.custom',
          projectPath: '/work',
          useAgentPermissions: true,
        },
      }),
    )

    // 试运行开始后可以输入任务；审批来自试运行会话。
    const input = await screen.findByLabelText('试运行输入')
    expect(await screen.findByText('待审批')).toBeDefined()
    // 空输入与 Ctrl+Enter 都不发送。
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(calls.some((call) => call.method === 'session.prompt')).toBe(false)

    // 试运行中切换权限模式会重启。
    fireEvent.click(screen.getByRole('switch', { name: '使用 Agent 自身的权限' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'trial.restart',
        params: { sessionId: 'trial-1', useAgentPermissions: false },
      }),
    )
    fireEvent.click(screen.getByRole('switch', { name: '使用 Agent 自身的权限' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'trial.restart',
        params: { sessionId: 'trial-1', useAgentPermissions: true },
      }),
    )

    fireEvent.change(input, { target: { value: '跑一下测试' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.prompt',
        params: {
          sessionId: 'trial-1',
          content: [{ type: 'text', text: '跑一下测试' }],
        },
      }),
    )

    // 发送后视为运行中，可以停止。
    fireEvent.click(await screen.findByRole('button', { name: '停止' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'session.abort',
        params: { sessionId: 'trial-1' },
      }),
    )

    // 处理审批走试运行会话。
    fireEvent.click(screen.getByRole('button', { name: /运行一次/ }))
    await waitFor(() => expect(calls.some((call) => call.method === 'approval.resolve')).toBe(true))

    // 草稿变化后提示重启，并按新的权限模式重新开始。
    rerender('k2')
    expect(await screen.findByText(/配置已变化/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'trial.restart',
        params: { sessionId: 'trial-1', useAgentPermissions: true },
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '清除记录' }))
    await waitFor(() => expect(screen.getByText('已清除 2 条试运行记录')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: '关闭试运行' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

    // 对话框自身关闭（Esc）也走同一条清理路径。
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(onOpenChange.mock.calls.length).toBeGreaterThanOrEqual(1))
  })

  it('chooses a project folder before starting when no project is listed', async () => {
    let picks = 0
    const { store, calls } = setup(
      {
        'project.open': () => {
          picks += 1
          return picks === 1
            ? { project: { projectId: 'p9', name: '新项目', path: '/new' } }
            : undefined
        },
      },
      [],
    )
    renderTrial(store)

    const start = screen.getByRole('button', { name: '开始试运行' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    await waitFor(() => expect(screen.getByLabelText('项目')).toBeDefined())
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/new')
    // 取消选择时保持原路径。
    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/new')
    expect(start.disabled).toBe(false)

    fireEvent.click(start)
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'trial.start',
        params: { agentId: 'user.custom', projectPath: '/new', useAgentPermissions: false },
      }),
    )
  })

  it('ignores a trial started for another agent', async () => {
    const { store } = setup({
      'trial.start': () => ({ ...started, agent: { id: 'user.other', draftHash: 'h9' } }),
      // 旧主进程可能没有试运行历史与清理接口。
      'trial.list': () => undefined,
      'trial.clear': () => undefined,
    })
    await store
      .getState()
      .startTrial({ agentId: 'user.other', projectPath: '/work', configKey: 'k' })
    renderTrial(store)
    expect(screen.getByRole('button', { name: '开始试运行' })).toBeDefined()
    expect(screen.queryByLabelText('试运行输入')).toBeNull()
    expect(screen.getByText('还没有试运行记录。')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '清除记录' }))
    await waitFor(() => expect(screen.queryByText(/已清除/)).toBeNull())
  })
})
