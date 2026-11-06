// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { EventEnvelope, SessionSummary } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

type Listener = (data: { sessionId: string; events: EventEnvelope[] }) => void

const summary: SessionSummary = {
  sessionId: 's1',
  title: '调试',
  projectPath: '/work',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}

const ev = (seq: number, type: string, payload: object): EventEnvelope =>
  ({
    v: 1,
    sessionId: 's1',
    runId: 'r1',
    turnId: 't1',
    ts: seq,
    seq,
    type,
    payload,
  }) as EventEnvelope

const HISTORY = [
  ev(1, 'session.created', {
    projectId: 'p1',
    projectPath: '/work',
    workspacePath: '/work',
    title: '调试',
  }),
  ev(2, 'message.user', { messageId: 'm1', content: [{ type: 'text', text: '你好' }] }),
]

function setup({ devTools = true, eventLogLimit = 100 } = {}) {
  const listeners = new Set<Listener>()
  const request = vi.fn(async (method: string) => {
    if (method === 'session.list') return { sessions: [summary] }
    if (method === 'session.subscribe') return { events: HISTORY, lastSeq: 2 }
    return {}
  })
  const api = {
    ready: async () => {},
    request,
    on: (_name: string, listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as MainApi
  const store = createSessionStore(api, { eventLogLimit })
  render(<App i18n={createI18n('zh-CN')} store={store} devTools={devTools} />)
  const emit = (...events: EventEnvelope[]) =>
    act(() => listeners.forEach((l) => l({ sessionId: 's1', events })))
  const open = async () => {
    const [item] = await screen.findAllByRole('listitem')
    await userEvent.click(within(item!).getAllByRole('button')[0]!)
    await waitFor(() => expect(store.getState().views.s1).toBeDefined())
  }
  return { emit, open }
}

const rows = () =>
  within(screen.getByRole('list', { name: '事件查看器' }))
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('code')?.textContent)

describe('EventViewer', () => {
  it('is hidden outside dev mode', async () => {
    setup({ devTools: false })
    expect(await screen.findAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('事件查看器')).toBeNull()
  })

  it('shows nothing until a session is selected', async () => {
    setup()
    await userEvent.click(await screen.findByText('事件查看器'))
    expect(screen.getByText('共 0 条')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '事件查看器' })).toBeNull()
  })

  it('lists received events and hides deltas unless asked', async () => {
    const { emit, open } = setup()
    await open()
    await userEvent.click(screen.getByText('事件查看器'))
    expect(rows()).toEqual(['#1 session.created', '#2 message.user'])

    emit(
      ev(3, 'turn.started', {}),
      ev(4, 'message.assistant.delta', { messageId: 'a1', text: '你' }),
    )
    expect(rows()).toEqual(['#1 session.created', '#2 message.user', '#3 turn.started'])
    expect(screen.getByText('共 3 条')).toBeTruthy()

    await userEvent.click(screen.getByLabelText('显示增量事件'))
    expect(rows()).toEqual([
      '#1 session.created',
      '#2 message.user',
      '#3 turn.started',
      '#4 message.assistant.delta',
    ])
  })

  it('shows the full event when a row is expanded', async () => {
    const { open } = setup()
    await open()
    await userEvent.click(screen.getByText('事件查看器'))
    await userEvent.click(screen.getByText('#2 message.user'))
    const detail = screen.getByText('#2 message.user').closest('details')!
    expect(JSON.parse(detail.querySelector('pre')!.textContent!)).toEqual(HISTORY[1])
    expect(detail.querySelector('time')?.textContent).toMatch(/\d{2}:\d{2}:\d{2}/)
  })
})
