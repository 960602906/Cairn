// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { EventEnvelope } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { formatGoalDuration, goalBarPhase, GoalBar, useGoalElapsed } from './GoalBar.js'

const i18n = createI18n('zh-CN')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const model = { providerId: 'fake', modelId: 'fake-1' }
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
    model,
    mode: 'interactive',
    limits: runLimits,
  }),
  ev(3, 'goal.created', { goalId: 'g1', condition: '测试全部通过', limits: goalLimits }),
  ev(4, 'message.user', { messageId: 'u1', content: text('测试全部通过') }),
]

const runningView = () =>
  reduceSessionEvents(createSessionView('s1'), [...BASE, ev(5, 'turn.started', {})])
const judgedView = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
    ev(7, 'turn.completed', { durationMs: 10 }),
  ])
const continuingView = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('还没完成'), model }),
    ev(7, 'goal.evaluated', {
      goalId: 'g1',
      verdict: 'not_met',
      reason: '还差测试',
      evidence: [],
      model,
    }),
    ev(8, 'turn.completed', { durationMs: 10 }),
  ])
const pausedView = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'goal.paused', { goalId: 'g1', reason: 'user' }),
  ])
const metView = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
    ev(7, 'goal.evaluated', { goalId: 'g1', verdict: 'met', reason: '达成', evidence: [], model }),
    ev(8, 'turn.completed', { durationMs: 10 }),
  ])
const endedView = () =>
  reduceSessionEvents(createSessionView('s1'), [
    ...BASE,
    ev(5, 'turn.started', {}),
    ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
    ev(7, 'turn.completed', { durationMs: 10 }),
    ev(8, 'goal.ended', { goalId: 'g1', reason: 'met', turns: 1, durationMs: 9_000 }),
  ])

function wrap(
  view: ReturnType<typeof runningView>,
  status: SessionStatusLike = 'idle',
  onOpen = vi.fn(),
  returnFocus?: () => void,
  actions: {
    pauseGoal?: () => Promise<{ ok: boolean; code?: string }>
    resumeGoal?: () => Promise<{ ok: boolean; code?: string }>
    clearGoal?: () => Promise<{ ok: boolean; code?: string }>
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
  })) as unknown as SessionStore
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <GoalBar view={view} status={status} onOpen={onOpen} returnFocus={returnFocus} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { pauseGoal, resumeGoal, clearGoal, updateGoalCondition, rendered }
}

type SessionStatusLike = 'idle' | 'running' | 'waiting_approval' | 'waiting_input'

describe('formatGoalDuration', () => {
  it('formats below an hour as m:ss and above as Nh MMm so 1m and 1h differ', () => {
    expect(formatGoalDuration(0)).toBe('0:00')
    expect(formatGoalDuration(5_000)).toBe('0:05')
    expect(formatGoalDuration(60_000)).toBe('1:00')
    expect(formatGoalDuration(754_000)).toBe('12:34')
    expect(formatGoalDuration(3_600_000)).toBe('1h 00m')
    expect(formatGoalDuration(3_661_000)).toBe('1h 01m')
    expect(formatGoalDuration(7_200_000)).toBe('2h 00m')
    expect(formatGoalDuration(-5)).toBe('0:00')
  })
})

describe('goalBarPhase', () => {
  it('distinguishes running, waiting, judging, continuing, active and paused', () => {
    expect(goalBarPhase(runningView(), runningView().goals.g1!, 'running')).toBe('running')
    expect(goalBarPhase(runningView(), runningView().goals.g1!, 'waiting_approval')).toBe(
      'waitingApproval',
    )
    expect(goalBarPhase(runningView(), runningView().goals.g1!, 'waiting_input')).toBe(
      'waitingInput',
    )
    expect(goalBarPhase(judgedView(), judgedView().goals.g1!, 'idle')).toBe('judging')
    expect(goalBarPhase(continuingView(), continuingView().goals.g1!, 'idle')).toBe('continuing')
    expect(goalBarPhase(metView(), metView().goals.g1!, 'idle')).toBe('active')
    expect(goalBarPhase(pausedView(), pausedView().goals.g1!, 'idle')).toBe('paused')
    expect(goalBarPhase(pausedView(), pausedView().goals.g1!, 'running')).toBe('pausedRunning')
  })

  it('returns undefined for an ended goal', () => {
    expect(goalBarPhase(endedView(), endedView().goals.g1!, 'idle')).toBeUndefined()
  })
})

describe('useGoalElapsed', () => {
  it('returns 0 without a goal and the frozen active time for a paused goal', () => {
    const { result: none } = renderHook(() => useGoalElapsed(undefined))
    expect(none.current).toBe(0)

    const paused = pausedView().goals.g1!
    const { result: frozen } = renderHook(() => useGoalElapsed(paused))
    expect(frozen.current).toBe(paused.activeMs)
  })

  it('adds elapsed time while a goal is active', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const goal = runningView().goals.g1!
    const { result } = renderHook(() => useGoalElapsed(goal))
    const initial = result.current
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current).toBe(initial + 5_000)
  })

  it('stops the timer when the document is hidden', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const original =
      Object.getOwnPropertyDescriptor(document, 'hidden') ??
      Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      const goal = runningView().goals.g1!
      const { result } = renderHook(() => useGoalElapsed(goal))
      const initial = result.current
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(result.current).toBe(initial)
    } finally {
      if (original !== undefined) Object.defineProperty(document, 'hidden', original)
      else delete (document as { hidden?: boolean }).hidden
    }
  })

  it('reacts to visibility changes by stopping and starting the timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const original =
      Object.getOwnPropertyDescriptor(document, 'hidden') ??
      Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    try {
      const goal = runningView().goals.g1!
      const { result } = renderHook(() => useGoalElapsed(goal))
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const afterHide = result.current
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(result.current).toBe(afterHide)
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const afterShow = result.current
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(result.current).toBeGreaterThan(afterShow)
    } finally {
      if (original !== undefined) Object.defineProperty(document, 'hidden', original)
      else delete (document as { hidden?: boolean }).hidden
    }
  })
})

describe('GoalBar', () => {
  it('shows a short running status and elapsed time, and pauses via the store', () => {
    const { pauseGoal } = wrap(runningView(), 'running')
    expect(screen.getByText('测试全部通过')).toBeTruthy()
    expect(screen.getAllByText('进行中').length).toBeGreaterThan(0)
    expect(screen.queryByText(/第 \d+ \/ \d+ 轮/)).toBeNull()
    expect(screen.getByLabelText(/^已运行 /)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
    expect(pauseGoal).toHaveBeenCalledWith('s1')
  })

  it('freezes the elapsed time when the goal is paused', () => {
    wrap(pausedView())
    expect(screen.getByLabelText('已运行 0:00')).toBeTruthy()
  })

  it('shows judging and continuing states', () => {
    wrap(judgedView(), 'idle')
    expect(screen.getAllByText('判定中').length).toBeGreaterThan(0)

    cleanup()
    wrap(continuingView(), 'idle')
    expect(screen.getAllByText('准备继续').length).toBeGreaterThan(0)
  })

  it('shows a short pause label and disables resume while a turn is running', () => {
    wrap(pausedView(), 'running')
    expect(screen.getAllByText('本轮结束后暂停').length).toBeGreaterThan(0)
    const resume = screen.getByRole('button', { name: '继续目标' })
    expect(resume).toHaveProperty('disabled', true)
    expect(resume.getAttribute('title')).toBe('本轮结束后才能继续。')
  })

  it('opens the goal panel from the condition', () => {
    const onOpen = vi.fn()
    wrap(pausedView(), 'idle', onOpen)
    fireEvent.click(screen.getByRole('button', { name: '测试全部通过' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders nothing without an open goal', () => {
    const { rendered } = wrap(createSessionView('s1'))
    expect(rendered.container.firstChild).toBeNull()
  })

  it('shows the active state when idle and already judged', () => {
    wrap(metView(), 'idle')
    expect(screen.getAllByText('进行中').length).toBeGreaterThan(0)
  })

  it('resumes a paused goal from the bar', () => {
    const { resumeGoal } = wrap(pausedView(), 'idle')
    fireEvent.click(screen.getByRole('button', { name: '继续目标' }))
    expect(resumeGoal).toHaveBeenCalledWith('s1')
  })

  it('hands focus back after pausing and resuming', async () => {
    const returnFocus = vi.fn()
    const { pauseGoal } = wrap(runningView(), 'running', vi.fn(), returnFocus)
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
    await waitFor(() => expect(pauseGoal).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(returnFocus).toHaveBeenCalledTimes(1))

    cleanup()
    const resumed = wrap(pausedView(), 'idle', vi.fn(), returnFocus)
    fireEvent.click(screen.getByRole('button', { name: '继续目标' }))
    await waitFor(() => expect(resumed.resumeGoal).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(returnFocus).toHaveBeenCalledTimes(2))
  })

  it('shows waiting copy instead of running while approval is pending', () => {
    wrap(runningView(), 'waiting_approval')
    expect(screen.getAllByText('等待审批').length).toBeGreaterThan(0)

    cleanup()
    wrap(runningView(), 'waiting_input')
    expect(screen.getAllByText('等待回答').length).toBeGreaterThan(0)
  })

  it('surfaces a pause failure instead of swallowing it', async () => {
    const pauseGoal = vi.fn(async () => ({ ok: false as const, code: 'goal.plan_pending' }))
    const returnFocus = vi.fn()
    wrap(runningView(), 'running', vi.fn(), returnFocus, { pauseGoal })
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
    expect(await screen.findByText('请先批准或取消待审计划，再设目标')).toBeTruthy()
    expect(returnFocus).not.toHaveBeenCalled()
  })

  it('edits the condition inline and saves on Enter', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '新的条件' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(updateGoalCondition).toHaveBeenCalledWith('s1', '新的条件'))
  })

  it('cancels condition edit on Escape', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '不要保存' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(updateGoalCondition).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull()
  })

  it('rejects an empty or unchanged condition without calling the store', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('条件不能为空')).toBeTruthy()
    expect(updateGoalCondition).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '测试全部通过' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull())
    expect(updateGoalCondition).not.toHaveBeenCalled()
  })

  it('surfaces a failed condition update', async () => {
    const updateGoalCondition = vi.fn(async () => ({
      ok: false as const,
      code: 'goal.plan_pending',
    }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '失败的条件' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('请先批准或取消待审计划，再设目标')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '完成条件' })).toBeTruthy()
  })

  it('saves a changed condition on blur and cancels when it is empty or unchanged', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    let input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull())
    expect(updateGoalCondition).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '完成条件' })).toBeNull())
    expect(updateGoalCondition).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '失焦保存' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateGoalCondition).toHaveBeenCalledWith('s1', '失焦保存'))
  })

  it('does not save while an IME composition is active', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '拼音' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(updateGoalCondition).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '完成条件' })).toBeTruthy()
  })

  it('does not take focus back when saving on blur', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    const returnFocus = vi.fn()
    wrap(pausedView(), 'idle', vi.fn(), returnFocus, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '失焦保存' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateGoalCondition).toHaveBeenCalledWith('s1', '失焦保存'))
    expect(returnFocus).not.toHaveBeenCalled()
  })

  it('takes focus back after saving on Enter', async () => {
    const updateGoalCondition = vi.fn(async () => ({ ok: true as const }))
    const returnFocus = vi.fn()
    wrap(pausedView(), 'idle', vi.fn(), returnFocus, { updateGoalCondition })
    fireEvent.click(screen.getByRole('button', { name: '改条件' }))
    const input = screen.getByRole('textbox', { name: '完成条件' })
    fireEvent.change(input, { target: { value: '回车保存' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(updateGoalCondition).toHaveBeenCalledWith('s1', '回车保存'))
    await waitFor(() => expect(returnFocus).toHaveBeenCalledTimes(1))
  })

  it('clears the goal after confirmation', async () => {
    const clearGoal = vi.fn(async () => ({ ok: true as const }))
    wrap(pausedView(), 'idle', vi.fn(), undefined, { clearGoal })
    fireEvent.click(screen.getByRole('button', { name: '删除目标' }))
    expect(clearGoal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认清除' }))
    await waitFor(() => expect(clearGoal).toHaveBeenCalledWith('s1'))
  })
})
