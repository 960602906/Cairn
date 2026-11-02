import { describe, expect, it, vi } from 'vitest'
import { RpcError, type EventEnvelope, type SessionSummary } from '@nexus/protocol'
import type { MainApi } from './api.js'
import { createSessionStore } from './session-store.js'

type Handler = (params: never) => unknown

function fakeApi(handlers: Record<string, Handler> = {}) {
  const listeners = new Set<(data: { sessionId: string; events: EventEnvelope[] }) => void>()
  const calls: [string, unknown][] = []
  const api = {
    ready: () => Promise.resolve(),
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      const handler = handlers[method]
      return handler ? handler(params as never) : {}
    }),
    on: (
      _name: string,
      listener: (data: { sessionId: string; events: EventEnvelope[] }) => void,
    ) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as MainApi
  const emit = (sessionId: string, events: EventEnvelope[]) =>
    listeners.forEach((l) => l({ sessionId, events }))
  return { api, calls, emit, listeners }
}

const summary = (sessionId: string, status: SessionSummary['status'] = 'idle'): SessionSummary => ({
  sessionId,
  title: sessionId,
  projectPath: '/work',
  status,
  createdAt: 1,
  updatedAt: 1,
})

const ev = (
  sessionId: string,
  seq: number,
  type: string,
  payload: object,
  header: object = {},
): EventEnvelope =>
  ({ v: 1, sessionId, runId: 'r1', ts: seq, seq, type, payload, ...header }) as EventEnvelope

const created = (sessionId: string) =>
  ev(sessionId, 1, 'session.created', {
    projectId: 'p1',
    projectPath: '/work',
    workspacePath: '/work',
    title: '',
  })
const user = (sessionId: string, seq: number, text: string) =>
  ev(sessionId, seq, 'message.user', { messageId: `m${seq}`, content: [{ type: 'text', text }] })
const thinking = (sessionId: string, seq: number) => [
  ev(sessionId, seq, 'run.created', {
    agent: { id: 'a', version: 1 },
    model: { providerId: 'p', modelId: 'm' },
    mode: 'interactive',
    limits: { maxStepsPerTurn: 1, maxTurnDurationMs: 1, maxConsecutiveToolErrors: 1 },
  }),
  ev(sessionId, seq + 1, 'run.state.changed', { from: 'idle', to: 'thinking' }),
]

describe('session list', () => {
  it('loads sessions and records failures as error codes', async () => {
    let fail: unknown
    const { api } = fakeApi({
      'session.list': () => {
        if (fail) throw fail
        return { sessions: [summary('s1'), summary('s2')] }
      },
    })
    const store = createSessionStore(api)
    await store.getState().refreshSessions()
    expect(store.getState().sessions.map((s) => s.sessionId)).toEqual(['s1', 's2'])

    fail = new RpcError('rpc.timeout', { timeoutMs: 1 })
    await store.getState().refreshSessions()
    expect(store.getState().error).toEqual({ code: 'rpc.timeout', params: { timeoutMs: 1 } })
    expect(store.getState().sessions).toHaveLength(2)
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()

    fail = new Error('boom')
    await store.getState().refreshSessions()
    expect(store.getState().error).toEqual({ code: 'unknown' })
  })

  it('creates a session, refreshes the list and selects it', async () => {
    const { api, calls } = fakeApi({
      'session.create': () => ({ sessionId: 's1' }),
      'session.list': () => ({ sessions: [summary('s1')] }),
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
    })
    const store = createSessionStore(api)
    await expect(store.getState().createSession('/work', 'Demo')).resolves.toBe('s1')
    await store.getState().createSession('/work')
    expect(calls.filter(([m]) => m === 'session.create').map(([, p]) => p)).toEqual([
      { projectPath: '/work', title: 'Demo' },
      { projectPath: '/work' },
    ])
    expect(store.getState().activeSessionId).toBe('s1')
    expect(store.getState().views['s1']?.info?.projectPath).toBe('/work')
    expect(calls).toContainEqual(['session.subscribe', { sessionId: 's1', afterSeq: 0 }])
  })

  it('returns undefined when creating fails', async () => {
    const { api } = fakeApi({
      'session.create': () => {
        throw new RpcError('rpc.invalid_params')
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().createSession('demo')).resolves.toBeUndefined()
    expect(store.getState().error?.code).toBe('rpc.invalid_params')
  })
})

describe('subscription', () => {
  it('replays persisted events, then applies live events without duplicates', async () => {
    const { api, emit } = fakeApi({
      'session.list': () => ({ sessions: [summary('s1'), summary('s2')] }),
      'session.subscribe': () => ({ events: [created('s1'), user('s1', 2, 'hi')], lastSeq: 2 }),
    })
    const store = createSessionStore(api)
    await store.getState().refreshSessions()
    await store.getState().selectSession('s1')
    expect(store.getState().views['s1']?.messages).toHaveLength(1)

    // 补发与实时重叠：seq 2 再次到达不重复
    emit('s1', [user('s1', 2, 'hi'), ...thinking('s1', 3)])
    emit('s1', [ev('s1', 5, 'message.assistant.delta', { messageId: 'a1', text: 'he' })])
    emit('s2', [user('s2', 9, 'other')])
    const view = store.getState().views['s1']!
    expect(view.messages).toHaveLength(1)
    expect(Object.values(view.live).map((m) => m.text)).toEqual(['he'])
    expect(store.getState().views['s2']).toBeUndefined()
    expect(store.getState().sessions.map((s) => s.status)).toEqual(['running', 'idle'])

    // 刷新列表时，已订阅会话保留本地状态
    await store.getState().refreshSessions()
    expect(store.getState().sessions.map((s) => s.status)).toEqual(['running', 'idle'])
  })

  it('applies live events that arrive before the backfill after it', async () => {
    let emitLive = () => {}
    const { api, emit } = fakeApi({
      'session.subscribe': () => {
        emitLive()
        return { events: [created('s1'), user('s1', 2, 'hi')], lastSeq: 2 }
      },
    })
    emitLive = () => emit('s1', [user('s1', 3, 'live')])
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(store.getState().views['s1']?.messages.map((m) => m.seq)).toEqual([2, 3])
  })

  it('unsubscribes when switching and resumes from lastSeq when switching back', async () => {
    const { api, calls, emit } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: sessionId === 's1' ? [created('s1')] : [],
        lastSeq: 1,
      }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    await store.getState().selectSession('s1')
    await store.getState().selectSession('s2')
    expect(store.getState().views['s2']?.lastSeq).toBe(0)
    // 已切走的会话不再接收事件
    emit('s1', [user('s1', 2, 'late')])
    expect(store.getState().views['s1']?.messages).toEqual([])

    await store.getState().selectSession('s1')
    await store.getState().selectSession(undefined)
    expect(calls.filter(([m]) => m.endsWith('subscribe'))).toEqual([
      ['session.subscribe', { sessionId: 's1', afterSeq: 0 }],
      ['session.unsubscribe', { sessionId: 's1' }],
      ['session.subscribe', { sessionId: 's2', afterSeq: 0 }],
      ['session.unsubscribe', { sessionId: 's2' }],
      ['session.subscribe', { sessionId: 's1', afterSeq: 1 }],
      ['session.unsubscribe', { sessionId: 's1' }],
    ])
    expect(store.getState().activeSessionId).toBeUndefined()
  })

  it('drops a subscription that finishes after another session was selected', async () => {
    let resolveFirst!: () => void
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) =>
        sessionId === 's1'
          ? new Promise((resolve) => (resolveFirst = () => resolve({ events: [], lastSeq: 0 })))
          : { events: [], lastSeq: 0 },
    })
    const store = createSessionStore(api)
    const first = store.getState().selectSession('s1')
    await vi.waitFor(() => expect(resolveFirst).toBeDefined())
    await store.getState().selectSession('s2')
    resolveFirst()
    await first
    expect(store.getState().activeSessionId).toBe('s2')
    expect(calls.filter(([m]) => m === 'session.unsubscribe')).toHaveLength(2)
  })

  it('keeps the selection when subscribing fails', async () => {
    const { api } = fakeApi({
      'session.subscribe': () => {
        throw new RpcError('rpc.closed')
      },
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(store.getState().activeSessionId).toBe('s1')
    expect(store.getState().error?.code).toBe('rpc.closed')
  })
})

describe('commands', () => {
  it('sends trimmed prompts and aborts the active session', async () => {
    let busy = false
    const { api, calls } = fakeApi({
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
      'session.prompt': () => {
        if (busy) throw new RpcError('run.busy', { sessionId: 's1' })
        return { messageId: 'm1' }
      },
    })
    const store = createSessionStore(api)
    expect(await store.getState().sendPrompt('ignored without a session')).toBe(false)
    await store.getState().abort()
    await store.getState().selectSession('s1')
    expect(await store.getState().sendPrompt('   ')).toBe(false)
    expect(await store.getState().sendPrompt('  hello  ')).toBe(true)
    await store.getState().abort()
    expect(calls.filter(([m]) => m === 'session.prompt' || m === 'session.abort')).toEqual([
      ['session.prompt', { sessionId: 's1', content: [{ type: 'text', text: 'hello' }] }],
      ['session.abort', { sessionId: 's1' }],
    ])

    busy = true
    expect(await store.getState().sendPrompt('again')).toBe(false)
    expect(store.getState().error?.code).toBe('run.busy')
  })

  it('stops listening after dispose', async () => {
    const { api, listeners } = fakeApi()
    const store = createSessionStore(api)
    expect(listeners.size).toBe(1)
    store.getState().dispose()
    expect(listeners.size).toBe(0)
  })
})
