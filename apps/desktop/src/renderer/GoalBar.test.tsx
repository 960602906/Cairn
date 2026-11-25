// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
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
) {
  const pauseGoal = vi.fn(async () => ({ ok: true as const }))
  const resumeGoal = vi.fn(async () => ({ ok: true as const }))
  const store = createStore<Record<string, unknown>>(() => ({
    pauseGoal,
    resumeGoal,
  })) as unknown as SessionStore
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <GoalBar view={view} status={status} onOpen={onOpen} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { pauseGoal, resumeGoal, rendered }
}

type SessionStatusLike = 'idle' | 'running' | 'waiting_approval' | 'waiting_input'

describe('formatGoalDuration', () => {
  it('formats below an hour as m:ss and above as h:mm', () => {
    expect(formatGoalDuration(0)).toBe('0:00')
    expect(formatGoalDuration(5_000)).toBe('0:05')
    expect(formatGoalDuration(60_000)).toBe('1:00')
    expect(formatGoalDuration(754_000)).toBe('12:34')
    expect(formatGoalDuration(3_600_000)).toBe('1:00')
    expect(formatGoalDuration(3_661_000)).toBe('1:01')
    expect(formatGoalDuration(-5)).toBe('0:00')
  })
})

describe('goalBarPhase', () => {
  it('distinguishes running, judging, continuing, active and paused', () => {
    expect(goalBarPhase(runningView(), runningView().goals.g1!, true)).toBe('running')
    expect(goalBarPhase(judgedView(), judgedView().goals.g1!, false)).toBe('judging')
    expect(goalBarPhase(continuingView(), continuingView().goals.g1!, false)).toBe('continuing')
    expect(goalBarPhase(metView(), metView().goals.g1!, false)).toBe('active')
    expect(goalBarPhase(pausedView(), pausedView().goals.g1!, false)).toBe('paused')
    expect(goalBarPhase(pausedView(), pausedView().goals.g1!, true)).toBe('pausedRunning')
  })

  it('returns undefined for an ended goal', () => {
    expect(goalBarPhase(endedView(), endedView().goals.g1!, false)).toBeUndefined()
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
  it('shows the running turn and timer, and pauses via the store', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { pauseGoal } = wrap(runningView(), 'running')
    expect(screen.getByText('测试全部通过')).toBeTruthy()
    expect(screen.getAllByText('第 1 / 20 轮').length).toBeGreaterThan(0)
    expect(screen.getByText('· 0:00')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText('· 0:05')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
    expect(pauseGoal).toHaveBeenCalledWith('s1')
  })

  it('shows judging and continuing states without a timer refresh problem', () => {
    wrap(judgedView(), 'idle')
    expect(screen.getAllByText('判定中…').length).toBeGreaterThan(0)

    cleanup()
    wrap(continuingView(), 'idle')
    expect(screen.getAllByText('准备继续…').length).toBeGreaterThan(0)
  })

  it('shows a pause reason and disables resume while a turn is running', () => {
    wrap(pausedView(), 'running')
    expect(screen.getAllByText('本轮结束后暂停：你暂停了目标').length).toBeGreaterThan(0)
    const resume = screen.getByRole('button', { name: '继续目标' })
    expect(resume).toHaveProperty('disabled', true)
    expect(resume.getAttribute('title')).toBe('本轮结束后才能继续。')
  })

  it('opens the goal panel from the condition and the open button', () => {
    const onOpen = vi.fn()
    const { rendered } = wrap(pausedView(), 'idle', onOpen)
    fireEvent.click(screen.getByRole('button', { name: '测试全部通过' }))
    fireEvent.click(screen.getByRole('button', { name: '查看目标' }))
    expect(onOpen).toHaveBeenCalledTimes(2)
    rendered.unmount()
  })

  it('renders nothing without an open goal', () => {
    const { rendered } = wrap(createSessionView('s1'))
    expect(rendered.container.firstChild).toBeNull()
  })

  it('shows the active state when idle and already judged', () => {
    wrap(metView(), 'idle')
    expect(screen.getAllByText('目标进行中').length).toBeGreaterThan(0)
  })

  it('resumes a paused goal from the bar', () => {
    const { resumeGoal } = wrap(pausedView(), 'idle')
    fireEvent.click(screen.getByRole('button', { name: '继续目标' }))
    expect(resumeGoal).toHaveBeenCalledWith('s1')
  })
})
