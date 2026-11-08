// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type PlanView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
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

function Harness({ open = true }: { readonly open?: boolean }) {
  const [panel, setPanel] = useState<SessionPanel>('diff')
  return (
    <SessionSidePanel
      sessionId="s1"
      view={view}
      panel={panel}
      selectedPlanId={plan.planId}
      onPanelChange={setPanel}
      open={open}
    />
  )
}

const wrap = (ui: ReactNode) => {
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    awaitingTurn: {},
    views: { s1: view },
    changes: { s1: changes },
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
  it('switches between diff, session brief, and the full plan', async () => {
    const user = userEvent.setup()
    wrap(<Harness />)
    const panel = screen.getByRole('complementary', { name: '会话信息' })

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
    const panel = screen.getByRole('complementary', { name: '会话信息' })
    expect(panel.className).toContain('transition-[width,transform,opacity]')
    expect(panel.className).toContain('duration-200')
    expect(panel.className).toContain('w-[304px]')
    expect(panel.className).toContain('translate-x-0')
    expect(panel.className).toContain('opacity-100')
    expect(panel.getAttribute('aria-hidden')).toBe('false')
  })

  it('opens the inspector as the fourth side panel tab', async () => {
    const user = userEvent.setup()
    wrap(<Harness />)
    const panel = screen.getByRole('complementary', { name: '会话信息' })
    await user.click(within(panel).getByRole('tab', { name: '检查器' }))
    expect(within(panel).getByRole('tab', { name: '检查器' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(within(panel).getByText('没有运行记录。')).toBeTruthy()
  })

  it('collapses to zero width and removes itself from the accessible tree', () => {
    wrap(<Harness open={false} />)
    const panel = screen.getByRole('complementary', { hidden: true })
    expect(panel.className).toContain('w-0')
    expect(panel.className).toContain('opacity-0')
    expect(panel.className).toContain('pointer-events-none')
    expect(panel.className).toContain('translate-x-full')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(panel.hasAttribute('inert')).toBe(true)
  })
})
