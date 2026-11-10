// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type DelegationView, type PlanView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { ChangeSetSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { inspectionKey, type SessionStore } from './session-store.js'
import { SessionSidePanel, type SessionPanel } from './SessionSidePanel.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const plan: PlanView = {
  planId: 'pl1',
  content: {
    goal: '修复登录',
    files: ['src/login.ts'],
    steps: [{ id: 'read', title: '查看登录流程' }],
    risks: '',
    verification: '测试通过',
    markdown: '# 修复登录\n\n查看登录流程',
  },
  steps: [{ id: 'read', title: '查看登录流程', status: 'pending' }],
  status: 'proposed',
  seq: 4,
  runId: 'r1',
  turnId: 't1',
}

const view = {
  ...createSessionView('s1'),
  plans: [plan],
  brief: { content: '目标：修复登录', editedBy: 'user' as const },
}

const changes = [
  {
    changeId: 'c1',
    path: 'src/login.ts',
    kind: 'modify' as const,
    status: 'pending' as const,
    turnId: 't1',
    hunks: [],
    added: 2,
    removed: 1,
    createdAt: 1,
  },
]

const delegation: DelegationView = {
  childRunId: 'child1',
  parentRunId: 'r1',
  agent: { id: 'builtin.coder', version: 2 },
  task: '补全登录测试',
  workspace: 'isolated',
  workspacePath: '/tmp/ws',
  budget: undefined,
  turnId: 't1',
  createdAt: 1,
  completed: {
    status: 'completed',
    summary: '完成',
    usage: undefined,
    changeSetId: 'cs1',
    issues: undefined,
  },
}

function Harness({
  open: initialOpen = true,
  selectedChangeSetId: initialChangeSetId,
  showPlan = true,
  delegations = [],
  onClose,
}: {
  readonly open?: boolean
  readonly selectedChangeSetId?: string | undefined
  readonly showPlan?: boolean
  readonly delegations?: readonly DelegationView[]
  readonly onClose?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(initialOpen)
  const [panel, setPanel] = useState<SessionPanel>('diff')
  const [selectedChangeSetId, setSelectedChangeSetId] = useState(initialChangeSetId)
  return (
    <SessionSidePanel
      sessionId="s1"
      view={showPlan ? { ...view, delegations } : { ...view, plans: [], delegations }}
      panel={panel}
      selectedPlanId={plan.planId}
      selectedChangeSetId={selectedChangeSetId}
      onSelectChangeSet={setSelectedChangeSetId}
      onPanelChange={setPanel}
      open={open}
      {...(onClose === undefined
        ? {}
        : {
            onClose: () => {
              setOpen(false)
              onClose()
            },
          })}
    />
  )
}

const changeSetSummary: ChangeSetSummary = {
  changeSetId: 'cs1',
  runId: 'child1',
  parentRunId: 'r1',
  status: 'pending' as const,
  createdAt: 10,
  baseCreatedAt: 5,
  files: 1,
  conflicts: 0,
  added: 2,
  removed: 1,
}

const changeSetDetail = {
  changeSetId: 'cs1',
  sessionId: 's1',
  runId: 'child1',
  parentRunId: 'r1',
  baseCommit: 'a'.repeat(40),
  baseCreatedAt: 5,
  status: 'pending' as const,
  createdAt: 10,
  conflicts: 0,
  files: [
    {
      path: 'src/a.ts',
      status: 'pending' as const,
      kind: 'modified' as const,
      added: 2,
      removed: 1,
      binary: false,
      large: false,
    },
  ],
}

const wrap = (
  ui: ReactNode,
  {
    changeSets = [],
    details = {},
    loading = false,
  }: {
    readonly changeSets?: readonly (typeof changeSetSummary)[]
    readonly details?: Readonly<Record<string, typeof changeSetDetail>>
    readonly loading?: boolean
  } = {},
) => {
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    awaitingTurn: {},
    views: { s1: view },
    changes: { s1: changes },
    changeSets: { s1: changeSets },
    changeSetsLoading: { s1: loading },
    changeSetDetails: details,
    changeSetLoading: {},
    changeSetErrors: {},
    loadChangeSet: vi.fn(async () => changeSetDetail),
    applyChangeSet: vi.fn(async () => changeSetDetail),
    rejectChangeSet: vi.fn(async () => changeSetDetail),
    resolveChangeSetConflict: vi.fn(async () => changeSetDetail),
    restoreCheckpoint: vi.fn(async () => ({ checkpointId: 'c', files: [] })),
    approvePlan: vi.fn(),
    replan: vi.fn(),
    abandonPlan: vi.fn(),
    updateBrief: vi.fn(async () => true),
    agents: [],
    inspections: {
      [inspectionKey('s1')]: {
        loading: false,
        result: {
          tree: { sessionId: 's1', rootRunId: '', generatedAt: 1, runs: [] },
          snapshots: [],
          settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
        },
        error: undefined,
      },
    },
    inspectRun: vi.fn(),
  })) as unknown as SessionStore
  return render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )
}

afterEach(cleanup)

describe('SessionSidePanel', () => {
  it('is a modal dialog in overlay mode with a Tab loop', async () => {
    const user = userEvent.setup()
    wrap(<Harness onClose={vi.fn()} />)
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(panel.getAttribute('aria-modal')).toBe('true')

    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getAttribute('aria-hidden') !== 'true')
    focusable[0]?.focus()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(focusable.at(-1))
    await user.tab()
    expect(document.activeElement).toBe(focusable[0])
  })

  it('returns focus to the trigger after closing the overlay', async () => {
    const user = userEvent.setup()
    function FocusHarness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开面板
          </button>
          <SessionSidePanel
            sessionId="s1"
            view={view}
            panel="diff"
            selectedPlanId={plan.planId}
            onPanelChange={() => {}}
            open={open}
            onClose={() => setOpen(false)}
          />
        </>
      )
    }
    wrap(<FocusHarness />)
    const trigger = screen.getByRole('button', { name: '打开面板' })
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await user.click(within(panel).getByRole('button', { name: '关闭会话信息' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '会话信息' })).toBeNull(),
    )
    expect(document.activeElement).toBe(trigger)
  })

  it('switches between diff, session brief, and the full plan', async () => {
    const user = userEvent.setup()
    wrap(<Harness />)
    const panel = screen.getByRole('dialog', { name: '会话信息' })

    expect(within(panel).getByRole('region', { name: '本会话的改动' })).toBeTruthy()
    await user.click(within(panel).getByRole('tab', { name: '会话要点' }))
    expect(within(panel).getByText('目标：修复登录')).toBeTruthy()

    await user.click(within(panel).getByRole('tab', { name: '计划' }))
    expect(within(panel).getByText('修复登录')).toBeTruthy()
    expect(within(panel).getByText('未开始')).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: '批准执行' })).toBeNull()
  })

  it('animates the width, opacity, and slide while open', () => {
    wrap(<Harness />)
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(panel.className).toContain('transition-[width,transform,opacity]')
    expect(panel.className).toContain('duration-200')
    expect(panel.className).toContain('w-[348px]')
    expect(panel.className).toContain('translate-x-0')
    expect(panel.className).toContain('opacity-100')
    expect(panel.getAttribute('aria-hidden')).toBe('false')
  })

  it('opens the inspector as the fourth side panel tab', async () => {
    const user = userEvent.setup()
    wrap(<Harness />)
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await user.click(within(panel).getByRole('tab', { name: '检查器' }))
    expect(within(panel).getByRole('tab', { name: '检查器' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(within(panel).getByText('没有运行记录。')).toBeTruthy()
  })

  it('lists change sets and opens the review, then returns to the list (M4-10)', async () => {
    const user = userEvent.setup()
    wrap(<Harness delegations={[delegation]} />, {
      changeSets: [changeSetSummary],
      details: { cs1: changeSetDetail },
    })
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    const list = within(panel).getByRole('list', { name: '改动集列表' })
    expect(within(list).getByText('1 个文件')).toBeTruthy()
    expect(within(list).getByText('补全登录测试')).toBeTruthy()
    await user.click(within(list).getByRole('button', { name: /补全登录测试/ }))
    expect(within(panel).getByRole('region', { name: '改动集审阅' })).toBeTruthy()
    expect(within(panel).getByText('补全登录测试')).toBeTruthy()
    expect(within(panel).getByText('src/a.ts')).toBeTruthy()
    await user.click(within(panel).getByRole('button', { name: '返回改动集列表' }))
    expect(within(panel).getByRole('list', { name: '改动集列表' })).toBeTruthy()
  })

  it('shows loading and empty change set states', async () => {
    const user = userEvent.setup()
    wrap(<Harness />, { loading: true })
    let panel = screen.getByRole('dialog', { name: '会话信息' })
    await user.click(within(panel).getByRole('radio', { name: '改动集' }))
    expect(within(panel).getByRole('status').textContent).toContain('正在读取改动集')
    cleanup()

    wrap(<Harness />)
    panel = screen.getByRole('dialog', { name: '会话信息' })
    await user.click(within(panel).getByRole('radio', { name: '改动集' }))
    expect(within(panel).getByText(/还没有改动集/)).toBeTruthy()
  })

  it('renders applied, rejected, and conflicting change set summaries', () => {
    wrap(<Harness />, {
      changeSets: [
        {
          ...changeSetSummary,
          changeSetId: 'cs-applied',
          status: 'applied' as const,
          conflicts: 2,
        },
        { ...changeSetSummary, changeSetId: 'cs-rejected', status: 'rejected' as const },
        changeSetSummary,
      ],
    })
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    const list = within(panel).getByRole('list', { name: '改动集列表' })
    expect(within(list).getByText('已合并')).toBeTruthy()
    expect(within(list).getByText('已拒绝')).toBeTruthy()
    expect(within(list).getByText('待审阅')).toBeTruthy()
    expect(within(list).getByText('2 个冲突')).toBeTruthy()
  })

  it('opens a change set selected outside the list with its delegation', () => {
    wrap(<Harness selectedChangeSetId="cs1" delegations={[delegation]} />, {
      details: { cs1: changeSetDetail },
    })
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(within(panel).getByRole('region', { name: '改动集审阅' })).toBeTruthy()
    expect(within(panel).getByText('补全登录测试')).toBeTruthy()
  })

  it('closes the panel and renders an empty plan state', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    wrap(<Harness showPlan={false} onClose={onClose} />)
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await user.click(within(panel).getByRole('tab', { name: '计划' }))
    expect(within(panel).getByText('还没有计划。')).toBeTruthy()
    await user.click(within(panel).getByRole('button', { name: '关闭会话信息' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('collapses to zero width and removes itself from the accessible tree', () => {
    wrap(<Harness open={false} />)
    const panel = screen.getByRole('dialog', { hidden: true })
    expect(panel.className).toContain('w-0')
    expect(panel.className).toContain('opacity-0')
    expect(panel.className).toContain('pointer-events-none')
    expect(panel.className).toContain('translate-x-full')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(panel.hasAttribute('inert')).toBe(true)
  })
})
