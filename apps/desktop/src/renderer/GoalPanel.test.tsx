// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { EventEnvelope } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { GoalPanel, reasonText } from './GoalPanel.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const model = { providerId: 'fake', modelId: 'judge' }
const runLimits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const goalLimits = { maxTurns: 20, maxDurationMs: 3_600_000 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

const ev = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
  ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope

const BASE = [
  ev(1, 'session.created', {
    projectId: 'p1',
    projectPath: '/w',
    workspacePath: '/w',
    title: 'x',
  }),
  ev(2, 'run.created', {
    agent: { id: 'a', version: 1 },
    model: { providerId: 'fake', modelId: 'main' },
    mode: 'interactive',
    limits: runLimits,
  }),
  ev(3, 'goal.created', { goalId: 'g1', condition: '测试全部通过', limits: goalLimits }),
  ev(4, 'message.user', { messageId: 'u1', content: text('测试全部通过') }),
]

const activeGoal = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
    ev(7, 'goal.evaluated', {
      goalId: 'g1',
      verdict: 'met',
      reason: '测试全部通过',
      evidence: [
        { kind: 'tool', ref: 'tool:t1', note: '跑过测试' },
        { kind: 'file', ref: 'file:src/a.ts' },
      ],
      model,
    }),
    ev(8, 'turn.completed', { durationMs: 10 }),
  ])

const pausedGoal = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'goal.paused', { goalId: 'g1', reason: 'judge_error', detail: 'invalid_output' }),
  ])

const pausedBudgetGoal = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'goal.paused', { goalId: 'g1', reason: 'user' }),
  ])

const endedGoal = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
    ev(7, 'turn.completed', { durationMs: 10 }),
    ev(8, 'goal.ended', { goalId: 'g1', reason: 'met', turns: 1, durationMs: 9_000 }),
  ])

const twoEndedGoals = () =>
  reduceSessionEvents(endedGoal(), [
    ev(9, 'goal.created', {
      goalId: 'g2',
      condition: '第二个目标',
      limits: goalLimits,
    }),
    ev(10, 'message.user', { messageId: 'u2', content: text('第二个目标') }),
    ev(11, 'turn.started', {}, 't2'),
    ev(12, 'turn.completed', { durationMs: 10 }, 't2'),
    ev(13, 'goal.ended', { goalId: 'g2', reason: 'user', turns: 1, durationMs: 3_000 }, 't2'),
  ])

function wrap(
  view: ReturnType<typeof activeGoal> | undefined,
  status: 'idle' | 'running' | 'waiting_approval' | 'waiting_input' = 'idle',
  actions: {
    pauseGoal?: (sessionId: string) => Promise<{ ok: boolean; code?: string }>
    resumeGoal?: (sessionId: string) => Promise<{ ok: boolean; code?: string }>
    clearGoal?: (sessionId: string) => Promise<{ ok: boolean; code?: string }>
    updateGoalCondition?: (
      sessionId: string,
      condition: string,
    ) => Promise<{ ok: boolean; code?: string }>
  } = {},
) {
  const pauseGoal = actions.pauseGoal ?? vi.fn(async () => ({ ok: true as const }))
  const resumeGoal = actions.resumeGoal ?? vi.fn(async () => ({ ok: true as const }))
  const clearGoal = actions.clearGoal ?? vi.fn(async () => ({ ok: true as const }))
  const updateGoalCondition =
    actions.updateGoalCondition ?? vi.fn(async () => ({ ok: true as const }))
  const store = createStore<Record<string, unknown>>(() => ({
    pauseGoal,
    resumeGoal,
    clearGoal,
    updateGoalCondition,
    settings: {
      locale: 'zh-CN',
      providers: [
        {
          id: 'fake',
          kind: 'openai',
          displayName: '评测供应商',
          baseUrl: 'https://example.com',
          models: [
            {
              id: 'judge',
              displayName: '判定模型',
              contextWindow: 100_000,
              maxOutputTokens: 8_000,
              supportsTools: true,
              supportsParallelToolCalls: true,
              supportsReasoning: false,
            },
          ],
        },
      ],
    },
  })) as unknown as SessionStore
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <GoalPanel
          sessionId="s1"
          view={view}
          status={status}
          active
          selectedPlanId={undefined}
          selectedChangeSetId={undefined}
          selectedRunId={undefined}
          onOpenPanel={() => {}}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { pauseGoal, resumeGoal, clearGoal, updateGoalCondition, rendered }
}

describe('reasonText', () => {
  it('picks the pause and end reason keys, and none for an active goal', () => {
    const t = (key: string) => key
    expect(reasonText(pausedGoal().goals.g1!, t)).toBe('goal.pause.judge_error')
    expect(reasonText(pausedBudgetGoal().goals.g1!, t)).toBe('goal.pause.user')
    expect(reasonText(endedGoal().goals.g1!, t)).toBe('goal.end.met')
    expect(reasonText(activeGoal().goals.g1!, t)).toBeUndefined()
  })
})

describe('GoalPanel', () => {
  it('shows an empty state with usage hint when there are no goals', () => {
    wrap(createSessionView('s1'))
    expect(screen.getByText('还没有目标。')).toBeTruthy()
    expect(screen.getByText(/用 `\/goal <条件>` 新建目标/)).toBeTruthy()
  })

  it('shows the empty state when the view is missing', () => {
    wrap(undefined)
    expect(screen.getByText('还没有目标。')).toBeTruthy()
  })

  it('shows condition, status, budget and the judgment timeline', () => {
    wrap(activeGoal())
    const region = screen.getByRole('region', { name: '判定记录' })
    expect(screen.getAllByText('测试全部通过').length).toBeGreaterThan(0)
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText(/1 \/ 20 轮/)).toBeTruthy()
    expect(within(region).getByText('已达成')).toBeTruthy()
    // 判定模型显示供应商与模型的名称，不露原始 id。
    expect(within(region).getByText(/评测供应商 · 判定模型/)).toBeTruthy()
    expect(within(region).getByText('测试全部通过')).toBeTruthy()
    expect(within(region).getByText(/工具 · tool:t1/)).toBeTruthy()
    expect(within(region).getByText(/文件 · file:src\/a.ts/)).toBeTruthy()
  })

  it('pauses and clears an active goal after confirmation', async () => {
    const user = userEvent.setup()
    const { pauseGoal, clearGoal } = wrap(activeGoal())
    await user.click(screen.getByRole('button', { name: '暂停' }))
    expect(pauseGoal).toHaveBeenCalledWith('s1')
    await user.click(screen.getByRole('button', { name: '清除目标' }))
    expect(clearGoal).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: '确认清除' }))
    expect(clearGoal).toHaveBeenCalledWith('s1')
  })

  it('edits the condition from the panel', async () => {
    const user = userEvent.setup()
    const { updateGoalCondition } = wrap(activeGoal())
    await user.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    await user.clear(input)
    await user.type(input, '面板改的条件')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(updateGoalCondition).toHaveBeenCalledWith('s1', '面板改的条件')
  })

  it('rejects empty or unchanged panel conditions and cancels on Escape', async () => {
    const user = userEvent.setup()
    const { updateGoalCondition } = wrap(activeGoal())
    await user.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('条件不能为空')).toBeTruthy()
    expect(updateGoalCondition).not.toHaveBeenCalled()

    await user.type(input, '测试全部通过')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull())
    expect(updateGoalCondition).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '改条件' }))
    await user.type(screen.getByRole('textbox', { name: '完成条件' }), '临时')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull()
    expect(updateGoalCondition).not.toHaveBeenCalled()
  })

  it('does not save the panel condition while an IME composition is active', async () => {
    const user = userEvent.setup()
    const { updateGoalCondition } = wrap(activeGoal())
    await user.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    await user.clear(input)
    await user.type(input, '组字中')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('textbox', { name: '完成条件' })).toBeTruthy()
    expect(updateGoalCondition).not.toHaveBeenCalled()
  })

  it('cancels a panel condition edit without saving', async () => {
    const user = userEvent.setup()
    const { updateGoalCondition } = wrap(activeGoal())
    await user.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    await user.clear(input)
    await user.type(input, '不要保存')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull()
    expect(updateGoalCondition).not.toHaveBeenCalled()
    expect(screen.getAllByText('测试全部通过').length).toBeGreaterThan(0)
  })

  it('surfaces a failed panel condition update', async () => {
    const user = userEvent.setup()
    wrap(activeGoal(), 'idle', {
      updateGoalCondition: vi.fn(async () => ({ ok: false, code: 'goal.plan_pending' })),
    })
    await user.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    await user.clear(input)
    await user.type(input, '面板失败')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请先批准或取消待审计划，再设目标')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '完成条件' })).toBeTruthy()
  })

  it('disables resume while running and enables it when idle', async () => {
    const user = userEvent.setup()
    wrap(pausedBudgetGoal(), 'running')
    const resume = screen.getByRole('button', { name: '继续' })
    expect(resume).toHaveProperty('disabled', true)
    expect(resume.getAttribute('title')).toBe('本轮结束后才能继续。')

    cleanup()
    const idle = wrap(pausedBudgetGoal(), 'idle')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(idle.resumeGoal).toHaveBeenCalledWith('s1')
  })

  it('localizes machine pause details and shows the evidence disclaimer', () => {
    wrap(pausedGoal())
    expect(screen.getByText('判定结果无法解析。')).toBeTruthy()
    expect(screen.getByText(/判定只依据应用内的对话/)).toBeTruthy()
    expect(screen.queryByText(/用 `\/goal <条件>` 新建目标/)).toBeNull()
  })

  it('shows the latest ended goal with judgments instead of a thin empty state', () => {
    wrap(endedGoal())
    expect(screen.getByRole('region', { name: '判定记录' })).toBeTruthy()
    expect(screen.getByText('目标已达成')).toBeTruthy()
    expect(screen.getByText('1 轮 · 活动 0:09')).toBeTruthy()
    expect(screen.getByText(/判定只依据应用内的对话/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: '历史目标' })).toBeNull()
  })

  it('lists older ended goals under history when more than one exists', () => {
    wrap(twoEndedGoals())
    expect(screen.getByText('第二个目标')).toBeTruthy()
    expect(screen.getByRole('region', { name: '历史目标' })).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: '历史目标' })).getByText('测试全部通过'),
    ).toBeTruthy()
  })

  it('expands a past goal to read its judgments', async () => {
    const user = userEvent.setup()
    wrap(twoEndedGoals())
    const history = screen.getByRole('region', { name: '历史目标' })
    expect(within(history).queryByText('还没有判定。')).toBeNull()
    const row = within(history).getByRole('button', { name: /测试全部通过/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')

    await user.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(within(history).getByText('还没有判定。')).toBeTruthy()
    expect(within(history).getByText(/判定只依据应用内的对话/)).toBeTruthy()

    await user.click(row)
    expect(within(history).queryByText('还没有判定。')).toBeNull()
  })

  it('keeps past goals under an open goal and ignores unknown detail codes', () => {
    const openWithHistory = reduceSessionEvents(endedGoal(), [
      ev(9, 'goal.created', {
        goalId: 'g2',
        condition: '下一个目标',
        limits: goalLimits,
      }),
      ev(10, 'message.user', { messageId: 'u2', content: text('下一个目标') }),
      ev(11, 'goal.paused', {
        goalId: 'g2',
        reason: 'judge_error',
        detail: 'provider.offline',
      }),
    ])
    wrap(openWithHistory)
    expect(screen.getByText('下一个目标')).toBeTruthy()
    expect(screen.getByRole('region', { name: '历史目标' })).toBeTruthy()
    expect(screen.queryByText('provider.offline')).toBeNull()
  })

  it('shows an error notice when an action fails', async () => {
    const user = userEvent.setup()
    wrap(activeGoal(), 'idle', {
      clearGoal: vi.fn(async () => ({ ok: false, code: 'goal.exists' })),
    })
    await user.click(screen.getByRole('button', { name: '清除目标' }))
    await user.click(await screen.findByRole('button', { name: '确认清除' }))
    expect(await screen.findByText('这个会话已有目标，请先暂停或清除')).toBeTruthy()
  })
})
