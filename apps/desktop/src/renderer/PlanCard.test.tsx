// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type PlanView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import { createStore } from 'zustand/vanilla'
import {
  PlanDetails,
  PlanProgress,
  PlanSummaryCard,
  planDocument,
  planInProgress,
  planPreview,
} from './PlanCard.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const plan: PlanView = {
  planId: 'pl1',
  content: {
    goal: '读代码',
    files: ['src/a.ts'],
    steps: [{ id: 'read', title: '读 src/a.ts' }],
    risks: '可能漏掉入口',
    verification: '单测通过',
    markdown: '1. 读代码',
  },
  steps: [{ id: 'read', title: '读 src/a.ts', status: 'pending' }],
  status: 'proposed',
  seq: 1,
  runId: 'r1',
  turnId: 't1',
}

const makeStore = (overrides: Record<string, unknown> = {}) =>
  createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    awaitingTurn: {},
    views: { s1: createSessionView('s1') },
    approvePlan: vi.fn(async () => true),
    replan: vi.fn(async () => true),
    abandonPlan: vi.fn(async () => true),
    ...overrides,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('plan documents', () => {
  it('uses markdown or builds a fallback document and preview', () => {
    expect(planDocument(plan)).toBe('1. 读代码')
    expect(planPreview(plan)).toBe('1. 读代码')

    const fallback = {
      ...plan,
      content: { ...plan.content, markdown: '', risks: '', verification: '' },
    }
    expect(planDocument(fallback)).toContain('## Steps')
    expect(planDocument(fallback)).toContain('None')
    expect(planPreview(fallback)).toContain('## Files')
  })
})

describe('PlanSummaryCard', () => {
  it('copies, downloads, opens, approves, replans, and abandons', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const store = makeStore()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:plan'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    wrap(<PlanSummaryCard plan={plan} onOpen={onOpen} />, store)

    expect(screen.getByText('读代码')).toBeTruthy()
    expect(screen.getByText('1. 读代码')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '复制计划' }))
    expect(writeText).toHaveBeenCalledWith('1. 读代码')
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '下载计划' }))
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: '查看完整计划：读代码' }))
    expect(onOpen).toHaveBeenCalledWith('pl1')
    await user.click(screen.getByRole('button', { name: '在右侧打开计划' }))
    expect(onOpen).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: '批准执行' }))
    expect(store.getState().approvePlan).toHaveBeenCalledWith('pl1')

    await user.click(screen.getByRole('button', { name: '重新规划' }))
    const submit = screen.getByRole('button', { name: '按说明重新规划' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: '重新规划' }), '换个做法')
    await user.click(submit)
    expect(store.getState().replan).toHaveBeenCalledWith('pl1', '换个做法')

    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '放弃' }))
    expect(store.getState().abandonPlan).toHaveBeenCalledWith('pl1')
  })

  it('keeps the copy label when the clipboard fails', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
      configurable: true,
    })
    wrap(<PlanSummaryCard plan={plan} onOpen={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '复制计划' }))
    expect(screen.getByRole('button', { name: '复制计划' })).toBeTruthy()
  })

  it('disables review actions while running and hides them after approval', () => {
    const busy = makeStore({ awaitingTurn: { s1: true } })
    const view = wrap(<PlanSummaryCard plan={plan} onOpen={vi.fn()} />, busy)
    expect((screen.getByRole('button', { name: '批准执行' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '重新规划' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '放弃' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()

    wrap(<PlanSummaryCard plan={{ ...plan, status: 'approved' }} onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '批准执行' })).toBeNull()
  })
})

describe('PlanDetails', () => {
  it('shows the complete plan without review controls', () => {
    wrap(<PlanDetails plan={plan} />)
    const card = screen.getByRole('article', { name: '计划' })
    expect(within(card).getByText('读代码')).toBeTruthy()
    expect(within(card).getByText('src/a.ts')).toBeTruthy()
    expect(within(card).getByText('未开始')).toBeTruthy()
    expect(within(card).getByText('可能漏掉入口')).toBeTruthy()
    expect(within(card).getByText('单测通过')).toBeTruthy()
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('marks each step with its status and note', () => {
    wrap(
      <PlanDetails
        plan={{
          ...plan,
          steps: [
            { id: 'a', title: '读入口', status: 'done', note: '入口在 main.ts' },
            { id: 'b', title: '改实现', status: 'in_progress' },
            { id: 'c', title: '补文档', status: 'skipped' },
            { id: 'd', title: '跑测试', status: 'pending' },
          ],
        }}
      />,
    )
    const card = screen.getByRole('article', { name: '计划' })
    for (const label of ['已完成', '进行中', '已跳过', '未开始']) {
      expect(within(card).getByText(label)).toBeTruthy()
    }
    expect(within(card).getByText('说明：入口在 main.ts')).toBeTruthy()
    expect(card.querySelector('.text-ok')).toBeTruthy()
    expect(card.querySelector('.text-accent')).toBeTruthy()
  })

  it('renders empty sections and approved or rejected status', () => {
    const empty = {
      ...plan,
      content: {
        goal: '只看一下',
        files: [],
        steps: [{ id: 'read', title: '读代码' }],
        risks: '',
        verification: '',
        markdown: '',
      },
    }
    const view = wrap(<PlanDetails plan={empty} />)
    expect(screen.getAllByText('无')).toHaveLength(3)
    view.unmount()

    wrap(<PlanDetails plan={{ ...empty, status: 'approved' }} />)
    expect(screen.getByText('已批准，正在执行')).toBeTruthy()
    cleanup()

    wrap(<PlanDetails plan={{ ...empty, status: 'rejected', feedback: '先补充测试' }} />)
    expect(screen.getByText('已要求重新规划')).toBeTruthy()
    expect(screen.getByText('说明：先补充测试')).toBeTruthy()
    cleanup()

    wrap(<PlanDetails plan={{ ...empty, status: 'rejected' }} />)
    expect(screen.getByText('已放弃')).toBeTruthy()
  })
})

describe('PlanProgress', () => {
  const running: PlanView = {
    ...plan,
    status: 'approved',
    steps: [
      { id: 'a', title: '读入口', status: 'done' },
      { id: 'b', title: '改实现', status: 'in_progress' },
      { id: 'c', title: '跑测试', status: 'pending' },
      { id: 'd', title: '补文档', status: 'skipped' },
    ],
  }

  it('knows whether a plan still has work left', () => {
    expect(planInProgress(running)).toBe(true)
    expect(
      planInProgress({ ...running, steps: [{ id: 'a', title: '读入口', status: 'done' }] }),
    ).toBe(false)
  })

  it('lists the steps with a count, collapses to the current step, and opens the full plan', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    wrap(<PlanProgress plan={running} onOpen={onOpen} />)
    const card = screen.getByRole('region', { name: '计划进度' })
    expect(within(card).getByText('2 / 4')).toBeTruthy()
    expect(within(card).getAllByRole('listitem')).toHaveLength(4)
    expect(within(card).getByText('进行中')).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: '收起计划步骤' }))
    expect(within(card).queryByRole('listitem')).toBeNull()
    // 收起后标题行显示当前步骤。
    expect(within(card).getByText('改实现')).toBeTruthy()
    await user.click(within(card).getByRole('button', { name: '改实现' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.click(within(card).getByRole('button', { name: '展开计划步骤' }))
    expect(within(card).getAllByRole('listitem')).toHaveLength(4)
  })

  it('falls back to the next pending step, then to the goal, when collapsed', async () => {
    const user = userEvent.setup()
    const view = wrap(
      <PlanProgress
        plan={{ ...running, steps: [{ id: 'c', title: '跑测试', status: 'pending' }] }}
        onOpen={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: '收起计划步骤' }))
    expect(screen.getByText('跑测试')).toBeTruthy()
    view.unmount()

    wrap(
      <PlanProgress
        plan={{ ...running, steps: [{ id: 'a', title: '读入口', status: 'done' }] }}
        onOpen={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: '收起计划步骤' }))
    expect(screen.getByText('读代码')).toBeTruthy()
  })
})
