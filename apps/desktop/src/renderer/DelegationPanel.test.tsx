// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type DelegationView, type SessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { RunInspectResult } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { DelegationPanel, pickDelegationRunId } from './DelegationPanel.js'
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
        usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 1, durationMs: 1 },
        turns: [
          {
            turnId: 'ct1',
            startedAt: 1,
            endedAt: 2,
            status: 'completed',
            usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 1, durationMs: 1 },
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
                toolCalls: [
                  { toolCallId: 'tc1', name: 'read_file', status: 'completed', requestedAt: 1 },
                ],
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

function makeView(completedValue: DelegationView['completed']): SessionView {
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
        state: 'idle',
        createdAt: 1,
        turn: undefined,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    },
    delegations: [
      {
        childRunId: 'c1',
        parentRunId: 'r1',
        agent: { id: 'builtin.reviewer', version: 1 },
        task: '检查登录流程',
        workspace: 'isolated',
        workspacePath: '/w/child',
        budget: limits,
        turnId: 't1',
        createdAt: 1,
        completed: completedValue,
      },
    ],
  }
}

type InspectMode = 'result' | 'error'

/** 在子运行 c1 下面再挂一个 c2，用来测运行树里的「打开子运行」。 */
const nestedInspection: RunInspectResult = {
  ...inspection,
  tree: {
    ...inspection.tree,
    runs: [
      inspection.tree.runs[0]!,
      { ...inspection.tree.runs[0]!, runId: 'c2', parentRunId: 'c1', turns: [] },
    ],
  },
}

function setup({
  inspectMode = 'result',
  selectedRunId = 'c1',
  delegationCompleted = completed({
    summary: '看完了',
    usage: { inputTokens: 10, outputTokens: 5 },
    changeSetId: 'cs1',
    issues: ['测试失败'],
  }),
  nested = false,
  result = inspection,
}: {
  readonly inspectMode?: InspectMode
  readonly selectedRunId?: string
  readonly delegationCompleted?: DelegationView['completed']
  readonly nested?: boolean
  readonly result?: RunInspectResult
} = {}) {
  const onOpenPanel = vi.fn()
  const inspectRun = vi.fn(async (sessionId: string, runId: string) => {
    store.setState({
      inspections: {
        [inspectionKey(sessionId, runId)]:
          inspectMode === 'error'
            ? { loading: false, result: undefined, error: { code: 'run.not_found' } }
            : { loading: false, result, error: undefined },
      },
    })
  })
  const store = createStore<Record<string, unknown>>(() => ({
    agents: [],
    inspections: {},
    inspectRun,
  })) as unknown as SessionStore & { setState: (patch: object) => void }
  const base = makeView(delegationCompleted)
  const sessionView: SessionView = nested
    ? {
        ...base,
        delegations: [
          ...base.delegations,
          {
            ...base.delegations[0]!,
            childRunId: 'c2',
            parentRunId: 'c1',
            task: '补测试细节',
            completed: undefined,
          },
        ],
      }
    : base
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <DelegationPanel
          sessionId="s1"
          view={sessionView}
          status="idle"
          active
          selectedPlanId={undefined}
          selectedChangeSetId={undefined}
          selectedRunId={selectedRunId}
          onOpenPanel={onOpenPanel}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { inspectRun, onOpenPanel, store }
}

afterEach(cleanup)

describe('pickDelegationRunId', () => {
  const base = {
    parentRunId: 'r1',
    agent: { id: 'builtin.reviewer', version: 1 },
    task: 't',
    workspace: 'shared' as const,
    workspacePath: undefined,
    budget: undefined,
    turnId: undefined,
    completed: undefined,
  }

  it('returns undefined without delegations', () => {
    expect(pickDelegationRunId(undefined)).toBeUndefined()
    expect(pickDelegationRunId([])).toBeUndefined()
  })

  it('prefers an explicit still-valid run id', () => {
    const list = [
      { ...base, childRunId: 'a', createdAt: 1 },
      { ...base, childRunId: 'b', createdAt: 2 },
    ]
    expect(pickDelegationRunId(list, 'a')).toBe('a')
  })

  it('prefers a running child, otherwise the latest created', () => {
    const list = [
      {
        ...base,
        childRunId: 'old',
        createdAt: 1,
        completed: {
          status: 'completed' as const,
          summary: undefined,
          usage: undefined,
          changeSetId: undefined,
          issues: undefined,
        },
      },
      { ...base, childRunId: 'live', createdAt: 2, completed: undefined },
      {
        ...base,
        childRunId: 'newer-done',
        createdAt: 3,
        completed: {
          status: 'completed' as const,
          summary: undefined,
          usage: undefined,
          changeSetId: undefined,
          issues: undefined,
        },
      },
    ]
    expect(pickDelegationRunId(list)).toBe('live')
    expect(pickDelegationRunId(list.filter((item) => item.childRunId !== 'live'))).toBe(
      'newer-done',
    )
  })
})

describe('DelegationPanel', () => {
  it('shows the delegation summary and its run tree', async () => {
    const user = userEvent.setup()
    const { inspectRun, onOpenPanel } = setup()
    expect(inspectRun).toHaveBeenCalledWith('s1', 'c1')
    const region = screen.getByRole('region', { name: '子 Agent' })
    expect(region.textContent).toContain('builtin.reviewer')
    expect(region.textContent).toContain('检查登录流程')
    expect(region.textContent).toContain('完成')
    expect(region.textContent).toContain('已用 15')
    expect(region.textContent).toContain('看完了')
    expect(region.textContent).toContain('测试失败')
    const tree = await screen.findByRole('list', { name: '运行树' })
    expect(region.textContent).toContain('第 1 轮')
    // 「运行树」标题行下方的滚动区留出顶边距，滚动时文字不贴着分隔线。
    expect(tree.parentElement?.className).toContain('pt-3')
    await user.click(within(tree).getByRole('button', { name: '查看改动' }))
    expect(onOpenPanel).toHaveBeenCalledWith('diff', { changeSetId: 'cs1' })
  })

  it('switches the tree to a nested sub-run', async () => {
    const user = userEvent.setup()
    const { onOpenPanel } = setup({ nested: true, result: nestedInspection })
    const tree = await screen.findByRole('list', { name: '运行树' })
    await user.click(within(tree).getByRole('button', { name: '打开子运行' }))
    expect(onOpenPanel).toHaveBeenCalledWith('delegation', { runId: 'c2' })
  })

  it('shows an empty state without a selected run or delegation', () => {
    setup({ selectedRunId: 'missing' })
    expect(screen.getByText('还没有选择子 Agent。')).toBeTruthy()
  })

  it('shows a load error and retries on demand', async () => {
    const user = userEvent.setup()
    const { inspectRun } = setup({ inspectMode: 'error' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('无法读取子运行过程。')
    // 失败后不自动重试，只有点「重试」才再读一次。
    expect(inspectRun).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(inspectRun).toHaveBeenCalledTimes(2)
  })

  it('opens the change set review from the header', async () => {
    const user = userEvent.setup()
    const { onOpenPanel } = setup()
    await user.click(screen.getByRole('button', { name: '打开改动集审阅' }))
    expect(onOpenPanel).toHaveBeenCalledWith('diff', { changeSetId: 'cs1' })
  })

  it('refreshes the snapshot on demand', async () => {
    const user = userEvent.setup()
    const { inspectRun } = setup()
    await screen.findByRole('list', { name: '运行树' })
    await user.click(screen.getByRole('button', { name: '刷新运行过程' }))
    await waitFor(() => expect(inspectRun).toHaveBeenCalledTimes(2))
  })
})
