// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type DelegationView, type SessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { FileChangeSummary, PendingApproval, RunInspectResult } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { DelegationCard } from './DelegationCard.js'
import { inspectionKey, type SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')
const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 10 }

const inspection: RunInspectResult = {
  tree: {
    sessionId: 's1',
    rootRunId: 'c1',
    generatedAt: 2,
    runs: [
      {
        runId: 'c1',
        agent: { id: 'builtin.reviewer', version: 1 },
        model,
        mode: 'unattended',
        state: 'completed',
        createdAt: 1,
        updatedAt: 2,
        durationMs: 1,
        limits,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          modelCalls: 1,
          toolCalls: 1,
          durationMs: 1,
        },
        turns: [
          {
            turnId: 'ct1',
            startedAt: 1,
            endedAt: 2,
            status: 'completed',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              modelCalls: 1,
              toolCalls: 1,
              durationMs: 1,
            },
            steps: [
              {
                stepId: 'cs1',
                model,
                startedAt: 1,
                endedAt: 2,
                finishReason: 'stop',
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  modelCalls: 1,
                  toolCalls: 1,
                  durationMs: 1,
                },
                toolCalls: [],
              },
            ],
          },
        ],
      },
    ],
  },
  snapshots: [],
  settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
}

const approval: PendingApproval = {
  approvalId: 'a1',
  toolCallId: 'tc1',
  runId: 'c1',
  parentRunId: 'r1',
  agent: { id: 'builtin.reviewer', version: 1 },
  tool: { name: 'write_file', category: 'write' },
  input: { path: 'src/a.ts' },
  targets: { paths: ['src/a.ts'] },
  kind: 'tool',
  preview: { summary: '写入 src/a.ts' },
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
}

const completed = (
  patch: Partial<NonNullable<DelegationView['completed']>> = {},
): NonNullable<DelegationView['completed']> => ({
  status: 'completed',
  summary: undefined,
  usage: undefined,
  changeSetId: undefined,
  issues: undefined,
  ...patch,
})

function view(): SessionView {
  return {
    ...createSessionView('s1'),
    runs: {
      c1: {
        runId: 'c1',
        parentRunId: 'r1',
        agent: { id: 'builtin.reviewer', version: 1 },
        model,
        mode: 'unattended',
        limits,
        state: 'thinking',
        createdAt: 1,
        turn: {
          turnId: 'ct1',
          status: 'running',
          startedAt: 1,
          endedAt: undefined,
          stepCount: 2,
          step: undefined,
          durationMs: undefined,
          abortReason: undefined,
          error: undefined,
          retryable: undefined,
          limitReached: undefined,
          retry: undefined,
        },
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    },
    delegations: [
      {
        childRunId: 'c1',
        parentRunId: 'r1',
        agent: { id: 'builtin.reviewer', version: 1 },
        task: '检查登录流程',
        workspace: 'shared',
        workspacePath: undefined,
        budget: limits,
        turnId: 't1',
        createdAt: 1,
        completed: undefined,
      },
    ],
  }
}

function setup({
  childError = false,
  inspectionState = 'result',
  approvals = [],
  completed,
  changes = [
    {
      changeId: 'ch1',
      path: 'src/a.ts',
      kind: 'modify',
      status: 'pending',
      turnId: 'ct1',
      hunks: [],
      added: 3,
      removed: 1,
      createdAt: 1,
    },
  ],
  onOpenChangesAvailable = true,
  withChildRun = true,
  agentId,
}: {
  readonly childError?: boolean
  readonly inspectionState?: 'result' | 'loading' | 'empty'
  readonly approvals?: readonly PendingApproval[]
  readonly completed?: DelegationView['completed']
  readonly changes?: readonly FileChangeSummary[]
  readonly onOpenChangesAvailable?: boolean
  readonly withChildRun?: boolean
  readonly agentId?: string
} = {}) {
  const inspectRun = vi.fn(async () => inspection)
  const resolveApproval = vi.fn(async () => true)
  const store = createStore<Record<string, unknown>>(() => ({
    agents: [],
    inspections: {
      [inspectionKey('s1', 'c1')]: childError
        ? { loading: false, result: undefined, error: { code: 'run.not_found' } }
        : inspectionState === 'loading'
          ? { loading: true, result: undefined, error: undefined }
          : inspectionState === 'empty'
            ? { loading: false, result: undefined, error: undefined }
            : { loading: false, result: inspection, error: undefined },
    },
    approvals: { s1: approvals },
    changes: { s1: changes },
    inspectRun,
    resolveApproval,
  })) as unknown as SessionStore
  const onOpenChanges = onOpenChangesAvailable ? vi.fn() : undefined
  const base = view()
  const delegation = {
    ...base.delegations[0]!,
    ...(agentId === undefined ? {} : { agent: { ...base.delegations[0]!.agent, id: agentId } }),
    ...(completed === undefined ? {} : { completed }),
  }
  const sessionView: SessionView = {
    ...base,
    ...(withChildRun ? {} : { runs: {} }),
    delegations: [delegation],
  }
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <DelegationCard
          sessionId="s1"
          view={sessionView}
          delegation={delegation}
          onOpenChanges={onOpenChanges}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { inspectRun, resolveApproval, onOpenChanges }
}

afterEach(cleanup)

describe('DelegationCard', () => {
  it('shows the agent, task, status, usage and change count, and expands the child run', async () => {
    const user = userEvent.setup()
    const { inspectRun, onOpenChanges } = setup()
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    expect(card.textContent).toContain('builtin.reviewer')
    expect(card.textContent).toContain('运行中')
    expect(card.textContent).toContain('150 tokens')
    await user.click(withinCard(card).getByRole('button', { name: /检查登录流程/ }))
    expect(inspectRun).toHaveBeenCalledWith('s1', 'c1')
    expect(await withinCard(card).findByRole('list', { name: '运行树' })).toBeTruthy()
    await user.click(withinCard(card).getByRole('button', { name: '查看改动（+3 −1）' }))
    expect(onOpenChanges).toHaveBeenCalled()
  })

  it('shows a failed child run read error', async () => {
    const user = userEvent.setup()
    setup({ childError: true })
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    await user.click(withinCard(card).getByRole('button', { name: /检查登录流程/ }))
    expect(withinCard(card).getByRole('alert').textContent).toBe('无法读取子运行过程。')
  })

  it('shows child approvals in the delegation card and resolves them', async () => {
    const user = userEvent.setup()
    const { resolveApproval } = setup({ approvals: [approval] })
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    expect(withinCard(card).getByRole('article', { name: '需要审批：write_file' })).toBeTruthy()
    await user.click(withinCard(card).getByRole('button', { name: '允许一次' }))
    expect(resolveApproval).toHaveBeenCalledWith('a1', 'allow_once', '')
  })

  it('shows a completed summary, issues and a disabled change link', () => {
    setup({
      completed: completed({
        status: 'failed',
        summary: '子运行失败原因',
        issues: ['测试失败', '缺少输入'],
        usage: { inputTokens: 10, outputTokens: 5 },
        changeSetId: 'cs1',
      }),
      onOpenChangesAvailable: false,
    })
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    expect(card.textContent).toContain('失败')
    expect(card.textContent).toContain('子运行失败原因')
    expect(
      withinCard(card)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(['测试失败', '缺少输入']))
    const changes = withinCard(card).getByRole('button', { name: '查看改动（+3 −1）' })
    expect(changes.hasAttribute('disabled')).toBe(true)
  })

  it('renders every terminal status and omits zero usage', () => {
    for (const [status, label] of [
      ['completed', '完成'],
      ['aborted', '已停止'],
      ['needs_input', '需要输入'],
      ['limit_reached', '达到限额'],
    ] as const) {
      setup({
        completed: completed({ status }),
        changes: [],
        withChildRun: false,
      })
      const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
      expect(card.textContent).toContain(label)
      expect(card.textContent).not.toContain('tokens')
      cleanup()
    }
  })

  it('collapses again and shows loading and empty child inspection states', async () => {
    const user = userEvent.setup()
    setup({ changes: [], inspectionState: 'loading' })
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    const toggle = withinCard(card).getByRole('button', { name: /检查登录流程/ })
    await user.click(toggle)
    expect(withinCard(card).getByRole('status').textContent).toBe('正在读取运行检查器…')
    await user.click(toggle)
    expect(withinCard(card).queryByRole('status')).toBeNull()
    cleanup()

    setup({ changes: [], inspectionState: 'empty' })
    const empty = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    await user.click(withinCard(empty).getByRole('button', { name: /检查登录流程/ }))
    expect(withinCard(empty).getByText('没有运行记录。')).toBeTruthy()
  })

  it('falls back to the built-in name and hides changes when there are none', () => {
    setup({ agentId: 'builtin.coder', changes: [] })
    const card = screen.getByRole('article', { name: '委派任务：检查登录流程' })
    expect(card.textContent).toContain('编程助手')
    expect(withinCard(card).queryByRole('button', { name: /查看改动/ })).toBeNull()
  })
})

function withinCard(card: HTMLElement) {
  return within(card)
}
