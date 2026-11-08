// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import { RpcError, type EventEnvelope, type PendingApproval } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { TrialPanel } from './TrialPanel.js'

afterEach(cleanup)

const i18n = createI18n('zh-CN')

const project = {
  projectId: 'p1',
  name: 'demo',
  path: '/work',
  createdAt: 1,
}

const started = (sessionId: string, useAgentPermissions = false) => ({
  sessionId,
  agent: { id: 'user.reviewer', draftHash: `hash-${sessionId}` },
  draftHash: `hash-${sessionId}`,
  useAgentPermissions,
})

type Handler = (params: never) => unknown

function setup(handlers: Record<string, Handler> = {}) {
  const calls: [string, unknown][] = []
  const api = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      const handler = handlers[method]
      return handler ? handler(params as never) : {}
    }),
    on: () => () => {},
  } as unknown as MainApi
  const store = createSessionStore(api)
  return { api, calls, store }
}

function renderPanel(
  store: ReturnType<typeof createSessionStore>,
  props: Partial<{
    agentId: string
    agentName: string
    draftKey: string
    saveDraft: () => Promise<boolean>
    onClose: () => void
  }> = {},
) {
  const onClose = props.onClose ?? vi.fn()
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <TrialPanel
          agentId={props.agentId ?? 'user.reviewer'}
          agentName={props.agentName ?? '审查助手'}
          draftKey={props.draftKey ?? 'draft-1'}
          {...(props.saveDraft ? { saveDraft: props.saveDraft } : {})}
          onClose={onClose}
        />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { ...view, onClose }
}

const defaultHandlers = (): Record<string, Handler> => ({
  'trial.start': () => started('t1'),
  'session.subscribe': () => ({ events: [], lastSeq: 0 }),
  'approval.pending': () => ({ approvals: [] }),
})

describe('TrialPanel', () => {
  it('starts a trial from the selected project, sends input, and stops it', async () => {
    const saveDraft = vi.fn(async () => true)
    const { calls, store } = setup({
      ...defaultHandlers(),
      'session.prompt': () => ({ messageId: 'm1' }),
    })
    store.setState({ projects: [project] })
    renderPanel(store, { saveDraft })

    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/work')
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(calls).toContainEqual([
      'trial.start',
      { agentId: 'user.reviewer', projectPath: '/work', useAgentPermissions: false },
    ])

    fireEvent.change(screen.getByLabelText('试运行输入'), {
      target: { value: '  检查日志  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(calls).toContainEqual([
        'session.prompt',
        { sessionId: 't1', content: [{ type: 'text', text: '检查日志' }] },
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(calls).toContainEqual(['session.abort', { sessionId: 't1' }]))
  })

  it('shows a configuration change and restarts with the current draft', async () => {
    const saveDraft = vi.fn(async () => true)
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.restart': () => started('t2'),
    })
    store.setState({ projects: [project] })
    const { rerender } = renderPanel(store, { saveDraft, draftKey: 'draft-1' })
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    rerender(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <TrialPanel
            agentId="user.reviewer"
            agentName="审查助手"
            draftKey="draft-2"
            saveDraft={saveDraft}
            onClose={vi.fn()}
          />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(screen.getByText(/配置已变化/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }))

    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t2'))
    expect(calls).toContainEqual(['trial.restart', { sessionId: 't1', useAgentPermissions: false }])
    expect(store.getState().trial?.configKey).toBe('draft-2')
    expect(saveDraft).toHaveBeenCalledTimes(2)
  })

  it('restarts when the user switches to the Agent permissions', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.restart': () => started('t2', true),
    })
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    fireEvent.click(screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t2'))
    expect(calls).toContainEqual(['trial.restart', { sessionId: 't1', useAgentPermissions: true }])
    expect(store.getState().trial?.useAgentPermissions).toBe(true)
  })

  it('routes approvals to the trial session', async () => {
    const approval: PendingApproval = {
      approvalId: 'a1',
      toolCallId: 'c1',
      runId: 'r1',
      agent: { id: 'user.reviewer', draftHash: 'hash-t1' },
      tool: { name: 'run_command', category: 'execute' },
      input: { command: 'npm test' },
      targets: { command: 'npm test' },
      kind: 'tool',
      preview: { summary: 'Run npm test', command: 'npm test' },
      reasonCode: 'permission.category_default',
      matchedRuleIds: [],
    }
    const { calls, store } = setup(defaultHandlers())
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    store.setState({ approvals: { t1: [approval] } })
    fireEvent.click(await screen.findByRole('button', { name: /运行一次/ }))
    await waitFor(() =>
      expect(calls).toContainEqual([
        'approval.resolve',
        { sessionId: 't1', approvalId: 'a1', decision: 'allow_once' },
      ]),
    )
  })

  it('clears trial history and closes the panel', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.clear': () => ({ cleared: 2 }),
    })
    store.setState({ projects: [project] })
    const { onClose } = renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    fireEvent.click(screen.getByRole('button', { name: '清除记录' }))
    expect(await screen.findByText('已清除 2 条试运行记录')).toBeTruthy()
    expect(store.getState().trial).toBeUndefined()
    expect(calls).toContainEqual(['trial.clear', { agentId: 'user.reviewer' }])

    fireEvent.click(screen.getByRole('button', { name: '关闭试运行' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('fills the project select after projects load asynchronously', async () => {
    const { store } = setup(defaultHandlers())
    renderPanel(store)
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('')
    store.setState({ projects: [project] })
    await waitFor(() =>
      expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/work'),
    )
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '/work' } })
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/work')
  })

  it('opens a project folder when none is available', async () => {
    const { store } = setup({
      ...defaultHandlers(),
      'project.open': () => ({
        project: { projectId: 'p2', name: 'opened', path: '/opened', createdAt: 2 },
      }),
    })
    renderPanel(store)
    expect((screen.getByRole('button', { name: '开始试运行' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    await waitFor(() =>
      expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('/opened'),
    )
  })

  it('keeps the project empty when opening a folder is cancelled', async () => {
    const { store } = setup({ ...defaultHandlers(), 'project.open': () => ({}) })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }))
    await waitFor(() => expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe(''))
  })

  it('closes without an active trial', () => {
    const { store } = setup(defaultHandlers())
    store.setState({ projects: [project] })
    const { onClose } = renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '关闭试运行' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes an active trial and only sends Enter with a modifier', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'session.prompt': () => ({ messageId: 'm1' }),
    })
    store.setState({ projects: [project] })
    const { onClose } = renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    const input = screen.getByLabelText('试运行输入')
    fireEvent.change(input, { target: { value: '检查' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.some(([method]) => method === 'session.prompt')).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(calls).toContainEqual([
        'session.prompt',
        { sessionId: 't1', content: [{ type: 'text', text: '检查' }] },
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭试运行' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await waitFor(() => expect(calls).toContainEqual(['session.unsubscribe', { sessionId: 't1' }]))
  })

  it('does not start when saving the draft fails', async () => {
    const saveDraft = vi.fn(async () => false)
    const { calls, store } = setup(defaultHandlers())
    store.setState({ projects: [project] })
    renderPanel(store, { saveDraft })
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    expect(calls.some(([method]) => method === 'trial.start')).toBe(false)
    expect(store.getState().trial).toBeUndefined()
  })

  it('does not restart when saving the draft fails', async () => {
    let attempts = 0
    const saveDraft = vi.fn(async () => ++attempts === 1)
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.restart': () => started('t2'),
    })
    store.setState({ projects: [project] })
    renderPanel(store, { saveDraft, draftKey: 'draft-1' })
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    fireEvent.change(screen.getByLabelText('试运行输入'), { target: { value: '检查' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }))
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    expect(calls.some(([method]) => method === 'trial.restart')).toBe(false)
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }) as HTMLInputElement)
          .checked,
      ).toBe(false),
    )
  })

  it('restores the permission choice when restarting the trial fails', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.restart': () => {
        throw new RpcError('run.busy', { sessionId: 't1' })
      },
    })
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    fireEvent.click(screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }))
    await waitFor(() => expect(calls.some(([method]) => method === 'trial.restart')).toBe(true))
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }) as HTMLInputElement)
          .checked,
      ).toBe(false),
    )
    expect(store.getState().trial?.sessionId).toBe('t1')
    expect(store.getState().trial?.useAgentPermissions).toBe(false)
  })

  it('restores the input when sending fails', async () => {
    const { store } = setup({
      ...defaultHandlers(),
      'session.prompt': () => {
        throw new RpcError('run.busy', { sessionId: 't1' })
      },
    })
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    fireEvent.change(screen.getByLabelText('试运行输入'), { target: { value: '检查' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect((screen.getByLabelText('试运行输入') as HTMLTextAreaElement).value).toBe('检查'),
    )
  })

  it('starts with the Agent permissions selected before the trial', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'trial.start': () => started('t1', true),
    })
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('checkbox', { name: /使用 Agent 自身的权限/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))
    expect(calls).toContainEqual([
      'trial.start',
      { agentId: 'user.reviewer', projectPath: '/work', useAgentPermissions: true },
    ])
  })

  it('sends with Ctrl+Enter and continues a limited turn in the trial session', async () => {
    const { calls, store } = setup({
      ...defaultHandlers(),
      'session.prompt': () => ({ messageId: 'm1' }),
    })
    store.setState({ projects: [project] })
    renderPanel(store)
    fireEvent.click(screen.getByRole('button', { name: '开始试运行' }))
    await waitFor(() => expect(store.getState().trial?.sessionId).toBe('t1'))

    const input = screen.getByLabelText('试运行输入')
    fireEvent.change(input, { target: { value: '继续检查' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(calls).toContainEqual([
        'session.prompt',
        { sessionId: 't1', content: [{ type: 'text', text: '继续检查' }] },
      ]),
    )

    const event = (seq: number, type: string, payload: object): EventEnvelope =>
      ({
        v: 1,
        sessionId: 't1',
        runId: 't1',
        turnId: 't1',
        ts: seq,
        seq,
        type,
        payload,
      }) as EventEnvelope
    const view = reduceSessionEvents(createSessionView('t1'), [
      event(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/work',
        workspacePath: '/work',
        title: '',
      }),
      event(2, 'run.created', {
        agent: { id: 'user.reviewer', draftHash: 'hash-t1' },
        model: { providerId: 'p', modelId: 'm' },
        mode: 'interactive',
        limits: { maxStepsPerTurn: 1, maxTurnDurationMs: 1, maxConsecutiveToolErrors: 1 },
      }),
      event(3, 'message.user', {
        messageId: 'u1',
        content: [{ type: 'text', text: '检查' }],
      }),
      event(4, 'turn.started', {}),
      event(5, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 1 }),
      event(6, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }),
    ])
    act(() => store.setState({ views: { t1: view }, awaitingTurn: {} }))
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    await waitFor(() =>
      expect(
        calls.filter(([method, params]) => {
          if (method !== 'session.prompt') return false
          const { sessionId } = params as { sessionId: string }
          return sessionId === 't1'
        }),
      ).toHaveLength(2),
    )
  })
})
