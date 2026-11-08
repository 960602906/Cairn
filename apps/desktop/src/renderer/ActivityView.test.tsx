// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ActivityListResult, AgentSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { ActivityView } from './ActivityView.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const snapshot: ActivityListResult = {
  approvals: [
    {
      approvalId: 'a1',
      sessionId: 's1',
      sessionTitle: '修复登录',
      runId: 'r1',
      agent: { id: 'builtin.coder', version: 1 },
      toolName: 'run_command',
      toolCategory: 'execute',
      kind: 'tool',
      summary: 'npm install lodash',
      reasonCode: 'permission.ask',
      matchedRuleIds: [],
      requestedAt: 1_700_000_000_000,
    },
    {
      approvalId: 'a2',
      sessionId: 's2',
      sessionTitle: '调整布局',
      runId: 'r2',
      agent: { id: 'builtin.reviewer', version: 2 },
      toolName: 'no_checkpoint',
      toolCategory: 'write',
      kind: 'no_checkpoint',
      summary: '继续写入但无法保存检查点',
      reasonCode: 'checkpoint.unavailable',
      matchedRuleIds: [],
      requestedAt: 1_700_000_001_000,
    },
  ],
  running: [
    {
      sessionId: 's2',
      sessionTitle: '补充测试',
      runId: 'r3',
      agent: { id: 'builtin.coder', version: 1 },
      mode: 'interactive',
      state: 'tooling',
      summary: '运行测试',
      step: 'npm test',
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
    },
  ],
  completed: [
    {
      sessionId: 's3',
      sessionTitle: '重构工具',
      runId: 'r4',
      turnId: 't4',
      agent: { id: 'builtin.reviewer', version: 1 },
      status: 'completed',
      summary: '重构完成',
      completedAt: 1_700_000_003_000,
    },
  ],
  counts: { approvals: 2, running: 1 },
}

function setup(
  overrides: {
    activity?: ActivityListResult | undefined
    loading?: boolean
    error?: { code: string } | undefined
    agents?: readonly AgentSummary[]
    resolveActivity?: (approvalId: string, decision: string) => Promise<boolean>
  } = {},
) {
  const refreshActivity = vi.fn(async () => {})
  const resolveActivity = vi.fn(overrides.resolveActivity ?? (async () => true))
  const onOpenSession = vi.fn()
  const store = createStore<Record<string, unknown>>(() => ({
    activity: 'activity' in overrides ? overrides.activity : snapshot,
    activityLoading: overrides.loading ?? false,
    activityError: overrides.error,
    agents: overrides.agents,
    refreshActivity,
    resolveActivity,
  })) as unknown as SessionStore
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <ActivityView onOpenSession={onOpenSession} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { refreshActivity, resolveActivity, onOpenSession }
}

afterEach(cleanup)

describe('ActivityView', () => {
  it('renders the three sections with counts and live announcement', () => {
    setup()
    expect(screen.getByRole('heading', { name: '活动' })).toBeTruthy()
    expect(screen.getByText('待审批 2 · 运行中 1 · 最近完成 1')).toBeTruthy()
    expect(screen.getByRole('region', { name: '待审批' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '运行中' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '最近完成' })).toBeTruthy()
    expect(screen.getByText('2 个待审批，1 个运行中')).toBeTruthy()
    expect(screen.getByText('npm install lodash')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText('重构完成')).toBeTruthy()
  })

  it('decides approvals in place and hides session-wide allow for no_checkpoint', async () => {
    const user = userEvent.setup()
    const { resolveActivity } = setup()
    const first = screen.getByRole('article', { name: '修复登录 · run_command 的审批' })
    await user.click(within(first).getByRole('button', { name: '允许一次' }))
    expect(resolveActivity).toHaveBeenCalledWith('a1', 'allow_once')

    const second = screen.getByRole('article', { name: '调整布局 · no_checkpoint 的审批' })
    expect(within(second).queryByRole('button', { name: '本会话始终允许' })).toBeNull()
    await user.click(within(second).getByRole('button', { name: '拒绝' }))
    expect(resolveActivity).toHaveBeenCalledWith('a2', 'deny')

    await user.click(within(first).getByRole('button', { name: '本会话始终允许' }))
    expect(resolveActivity).toHaveBeenCalledWith('a1', 'allow_session')
  })

  it('opens the matching session from approval, running, and completed rows', async () => {
    const user = userEvent.setup()
    const { onOpenSession } = setup()

    const approval = screen.getByRole('article', { name: '修复登录 · run_command 的审批' })
    await user.click(within(approval).getByRole('button', { name: '查看' }))
    expect(onOpenSession).toHaveBeenLastCalledWith('s1')

    const running = screen.getByRole('article', { name: '运行中：补充测试' })
    await user.click(within(running).getByRole('button', { name: '查看' }))
    expect(onOpenSession).toHaveBeenLastCalledWith('s2')

    const completed = screen.getByRole('article', { name: '最近完成：重构工具' })
    await user.click(within(completed).getByRole('button', { name: '查看' }))
    expect(onOpenSession).toHaveBeenLastCalledWith('s3')
  })

  it('shows empty, loading, and error states with retry', async () => {
    const user = userEvent.setup()
    setup({
      activity: { approvals: [], running: [], completed: [], counts: { approvals: 0, running: 0 } },
    })
    expect(screen.getByText('目前没有需要关注的活动')).toBeTruthy()
    cleanup()

    const loading = setup({ loading: true })
    expect(screen.getByRole('status').textContent).toContain('正在读取活动…')
    expect(loading.refreshActivity).toHaveBeenCalled()
    cleanup()

    const failed = setup({ activity: undefined, error: { code: 'activity.failed' } })
    expect(screen.getByRole('alert')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.refreshActivity).toHaveBeenCalledTimes(2)
  })

  it('shows section-specific empty text when only some sections are empty', () => {
    setup({
      activity: {
        approvals: [],
        running: [snapshot.running[0]!],
        completed: [],
        counts: { approvals: 0, running: 1 },
      },
    })
    expect(screen.getByText('没有待审批。')).toBeTruthy()
    expect(screen.getByText('还没有最近完成的任务。')).toBeTruthy()
  })

  it('uses agent summaries, failed status, and missing turn ids', () => {
    setup({
      agents: [
        {
          agentId: 'builtin.coder',
          source: 'builtin',
          version: 1,
          status: 'published',
          hasDraft: false,
          archived: false,
          updatedAt: 1,
          name: { 'zh-CN': '自定义编程助手' },
          description: {},
          modelMode: 'inherit',
        },
      ],
      activity: {
        approvals: [snapshot.approvals[0]!],
        running: [],
        completed: [
          {
            ...snapshot.completed[0]!,
            turnId: undefined,
            status: 'failed',
            summary: '测试失败',
          },
        ],
        counts: { approvals: 1, running: 0 },
      },
    })
    expect(screen.getByText('自定义编程助手')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('没有正在运行的任务。')).toBeTruthy()
    expect(screen.getByRole('article', { name: '最近完成：重构工具' })).toBeTruthy()
  })

  it('refreshes from the header and ignores a second decision while one is pending', async () => {
    const user = userEvent.setup()
    let release: ((value: boolean) => void) | undefined
    const pending = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const { refreshActivity, resolveActivity } = setup({
      resolveActivity: () => pending,
    })
    await user.click(screen.getByRole('button', { name: '刷新活动' }))
    expect(refreshActivity).toHaveBeenCalledTimes(2)

    const first = screen.getByRole('article', { name: '修复登录 · run_command 的审批' })
    const second = screen.getByRole('article', { name: '调整布局 · no_checkpoint 的审批' })
    await user.click(within(first).getByRole('button', { name: '允许一次' }))
    await user.click(within(second).getByRole('button', { name: '拒绝' }))
    expect(resolveActivity).toHaveBeenCalledTimes(1)
    release?.(true)
    await waitFor(() => expect(resolveActivity).toHaveBeenCalledTimes(1))
  })
})
