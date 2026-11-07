import { describe, expect, it, vi } from 'vitest'
import { RpcError, type EventEnvelope, type SessionSummary } from '@cairn/protocol'
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
      name: string,
      listener: (data: { sessionId: string; events: EventEnvelope[] }) => void,
    ) => {
      if (name !== 'session.events') return () => {}
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

  it('renames and archives sessions, deselecting an archived active session (M2-02)', async () => {
    let sessions = [summary('s1'), summary('s2')]
    const { api, calls } = fakeApi({
      'session.list': () => ({ sessions }),
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
      'session.archive': ({ sessionId }: { sessionId: string }) => {
        if (sessionId === 'busy') throw new RpcError('run.busy')
        sessions = sessions.filter((s) => s.sessionId !== sessionId)
        return {}
      },
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    await expect(store.getState().renameSession('s1', 'New')).resolves.toBe(true)
    expect(calls).toContainEqual(['session.rename', { sessionId: 's1', title: 'New' }])

    await expect(store.getState().archiveSession('s2')).resolves.toBe(true)
    expect(store.getState().activeSessionId).toBe('s1')
    await expect(store.getState().archiveSession('s1')).resolves.toBe(true)
    expect(store.getState().activeSessionId).toBeUndefined()
    expect(store.getState().sessions).toEqual([])

    await expect(store.getState().archiveSession('busy')).resolves.toBe(false)
    expect(store.getState().error?.code).toBe('run.busy')
  })

  it('reports a failed rename', async () => {
    const { api } = fakeApi({
      'session.rename': () => {
        throw new RpcError('storage.not_found')
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().renameSession('x', 'y')).resolves.toBe(false)
    expect(store.getState().error?.code).toBe('storage.not_found')
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

  it('updates the list title when the session is renamed, including an automatic title', async () => {
    const { api, emit } = fakeApi({
      'session.list': () => ({ sessions: [summary('s1')] }),
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
    })
    const store = createSessionStore(api)
    await store.getState().refreshSessions()
    await store.getState().selectSession('s1')
    expect(store.getState().sessions[0]?.title).toBe('')
    emit('s1', [ev('s1', 2, 'session.renamed', { title: '整理日志', source: 'auto' })])
    expect(store.getState().views['s1']?.info?.title).toBe('整理日志')
    expect(store.getState().sessions[0]?.title).toBe('整理日志')
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

  it('marks a session as awaiting its turn until the turn starts', async () => {
    let emitStarted = () => {}
    const { api, emit } = fakeApi({
      'session.list': () => ({ sessions: [summary('s1'), summary('s2')] }),
      'session.subscribe': ({ sessionId }: { sessionId: string }) => {
        if (sessionId === 's2') throw new RpcError('rpc.closed')
        return { events: [created('s1')], lastSeq: 1 }
      },
      'session.prompt': () => {
        // turn.started 早于请求响应到达
        emitStarted()
        return { messageId: 'm1' }
      },
    })
    const store = createSessionStore(api)
    await store.getState().refreshSessions()
    await store.getState().selectSession('s1')

    expect(await store.getState().sendPrompt('hi')).toBe(true)
    expect(store.getState().awaitingTurn).toEqual({ s1: true })
    expect(store.getState().sessions.map((s) => s.status)).toEqual(['running', 'idle'])
    emit('s1', [ev('s1', 2, 'session.crashed', { error: { code: 'host.start_failed' } })])
    expect(store.getState().awaitingTurn).toEqual({})
    expect(store.getState().sessions[0]?.status).toBe('crashed')

    emitStarted = () => emit('s1', [ev('s1', 3, 'turn.started', {}, { turnId: 't1' })])
    expect(await store.getState().sendPrompt('again')).toBe(true)
    expect(store.getState().awaitingTurn).toEqual({})

    // 订阅失败、还没有投影的会话只记标记
    await store.getState().selectSession('s2')
    emitStarted = () => {}
    await store.getState().sendPrompt('x')
    expect(store.getState().awaitingTurn).toEqual({ s2: true })
    expect(store.getState().views['s2']).toBeUndefined()
    await store.getState().abort()
    expect(store.getState().awaitingTurn).toEqual({})
  })

  it('stops listening after dispose', async () => {
    const { api, listeners } = fakeApi()
    const store = createSessionStore(api)
    expect(listeners.size).toBe(1)
    store.getState().dispose()
    expect(listeners.size).toBe(0)
  })
})

describe('event log', () => {
  const delta = (seq: number) =>
    ev('s1', seq, 'message.assistant.delta', { messageId: 'a1', text: 'x' })

  it('is not recorded by default', async () => {
    const { api, emit } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    emit('s1', [user('s1', 2, 'hi')])
    expect(store.getState().views.s1?.lastSeq).toBe(2)
    expect(store.getState().eventLog).toEqual({})
  })

  it('keeps the latest received events per session, dropping deltas first', async () => {
    const { api, emit } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
    })
    const store = createSessionStore(api, { eventLogLimit: 3 })
    await store.getState().selectSession('s1')
    expect(store.getState().eventLog.s1?.map((e) => e.seq)).toEqual([1])
    emit('s1', [user('s1', 2, 'hi'), delta(3)])
    emit('s1', [])
    expect(store.getState().eventLog.s1?.map((e) => e.seq)).toEqual([1, 2, 3])
    // 超出时先丢弃最早的增量事件，持久化事件保留
    emit('s1', [delta(4)])
    expect(store.getState().eventLog.s1?.map((e) => e.seq)).toEqual([1, 2, 4])
    emit('s1', [delta(5), delta(6)])
    expect(store.getState().eventLog.s1?.map((e) => e.seq)).toEqual([1, 2, 6])
    // 只剩持久化事件时丢弃最早的
    emit('s1', [user('s1', 7, 'a'), user('s1', 8, 'b')])
    expect(store.getState().eventLog.s1?.map((e) => e.seq)).toEqual([2, 7, 8])
    // 其他会话（未订阅）的事件不记录
    emit('s2', [user('s2', 1, 'other')])
    expect(Object.keys(store.getState().eventLog)).toEqual(['s1'])
  })
})

describe('settings', () => {
  it('saves settings and records failures', async () => {
    let fail = false
    const { api, calls } = fakeApi({
      'settings.update': (patch: { locale: string }) => {
        if (fail) throw new RpcError('settings.write_failed')
        return { locale: patch.locale }
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().updateSettings({ locale: 'en-US' })).resolves.toEqual({
      locale: 'en-US',
    })
    expect(calls).toEqual([['settings.update', { locale: 'en-US' }]])
    expect(store.getState().error).toBeUndefined()

    fail = true
    await expect(store.getState().updateSettings({ locale: 'zh-CN' })).resolves.toBeUndefined()
    expect(store.getState().error).toEqual({ code: 'settings.write_failed' })
  })
})

describe('projects and model settings', () => {
  const project = (projectId: string) => ({
    projectId,
    name: projectId,
    path: `/work/${projectId}`,
    createdAt: 1,
  })

  it('lists projects and puts an opened project first', async () => {
    let picked: ReturnType<typeof project> | undefined = project('b')
    const { api } = fakeApi({
      'project.list': () => ({ projects: [project('a'), project('b')] }),
      'project.open': () => (picked ? { project: picked } : {}),
    })
    const store = createSessionStore(api)
    await store.getState().refreshProjects()
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(['a', 'b'])

    await expect(store.getState().openProject()).resolves.toEqual(project('b'))
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(['b', 'a'])

    picked = undefined
    await expect(store.getState().openProject()).resolves.toBeUndefined()
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(['b', 'a'])
  })

  it('records project dialog failures', async () => {
    const { api } = fakeApi({
      'project.open': () => {
        throw new RpcError('project.invalid_path', { path: 'x' })
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().openProject()).resolves.toBeUndefined()
    expect(store.getState().error).toEqual({
      code: 'project.invalid_path',
      params: { path: 'x' },
    })
  })

  it('loads settings and keeps the latest saved settings', async () => {
    const { api } = fakeApi({
      'settings.get': () => ({ locale: 'zh-CN', providers: [] }),
      'settings.update': (patch: object) => ({ locale: 'zh-CN', providers: [], ...patch }),
    })
    const store = createSessionStore(api)
    expect(store.getState().settings).toBeUndefined()
    await store.getState().loadSettings()
    expect(store.getState().settings).toEqual({ locale: 'zh-CN', providers: [] })
    await store.getState().updateSettings({ defaultModel: { providerId: 'p', modelId: 'm' } })
    expect(store.getState().settings?.defaultModel).toEqual({ providerId: 'p', modelId: 'm' })
  })

  it('saves keys and reads key status without returning secrets', async () => {
    let fail = false
    const { api, calls } = fakeApi({
      'credentials.set': () => {
        if (fail) throw new RpcError('credentials.unavailable')
        return {}
      },
      'credentials.status': () => ({ configured: true, available: true }),
    })
    const store = createSessionStore(api)
    await expect(store.getState().saveCredential('deepseek', 'secret')).resolves.toBe(true)
    await expect(store.getState().credentialStatus('deepseek')).resolves.toEqual({
      configured: true,
      available: true,
    })
    expect(calls).toEqual([
      ['credentials.set', { ref: 'deepseek', secret: 'secret' }],
      ['credentials.status', { ref: 'deepseek' }],
    ])

    fail = true
    await expect(store.getState().saveCredential('deepseek', 'secret')).resolves.toBe(false)
    expect(store.getState().error).toEqual({ code: 'credentials.unavailable' })
  })

  it('reads the shell options (M2-09)', async () => {
    const { api } = fakeApi({
      'settings.shell': () => ({ detected: 'PowerShell 7.5.4', options: ['auto', 'cmd'] }),
    })
    await expect(createSessionStore(api).getState().shellOptions()).resolves.toEqual({
      detected: 'PowerShell 7.5.4',
      options: ['auto', 'cmd'],
    })
  })

  it('lists, adds and deletes permission rules (M2-11)', async () => {
    const rule = {
      id: 'r1',
      scope: 'project' as const,
      effect: 'deny' as const,
      match: { tool: 'read_file', path: ['secrets/**'] },
      source: 'user' as const,
    }
    let fail = false
    const { api, calls } = fakeApi({
      'permissions.list': () => ({ rules: [{ rule, projectId: 'p1', createdAt: 1 }] }),
      'permissions.add': (params) => ({ ...(params as object), createdAt: 2 }),
      'permissions.delete': () => {
        if (fail) throw Object.assign(new Error('x'), { code: 'storage.not_found' })
        return {}
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().permissionRules()).resolves.toEqual([
      { rule, projectId: 'p1', createdAt: 1 },
    ])
    await expect(store.getState().addPermissionRule(rule, 'p1')).resolves.toEqual({
      rule,
      projectId: 'p1',
      createdAt: 2,
    })
    await store.getState().addPermissionRule({ ...rule, scope: 'global' })
    expect(calls.filter(([m]) => m === 'permissions.add').map(([, p]) => p)).toEqual([
      { rule, projectId: 'p1' },
      { rule: { ...rule, scope: 'global' } },
    ])
    await expect(store.getState().deletePermissionRule('r1')).resolves.toBe(true)
    fail = true
    await expect(store.getState().deletePermissionRule('r1')).resolves.toBe(false)
  })
})

describe('file changes (M2-07)', () => {
  const change = (changeId: string, over: object = {}) => ({
    changeId,
    path: 'a.ts',
    kind: 'modify',
    status: 'pending',
    hunks: [],
    added: 1,
    removed: 0,
    createdAt: 1,
    ...over,
  })

  it('loads changes on subscribe and reloads them after file.changed', async () => {
    let changes = [change('c1')]
    const { api, calls, emit } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
      'changes.list': () => ({ changes }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(store.getState().changes['s1']?.map((c) => c.changeId)).toEqual(['c1'])

    changes = [change('c1'), change('c2')]
    emit('s1', [ev('s1', 2, 'message.user', { messageId: 'm', content: [] })])
    await vi.waitFor(() => expect(calls.filter(([m]) => m === 'changes.list')).toHaveLength(1))
    emit('s1', [ev('s1', 3, 'file.changed', { changeId: 'c2', path: 'a.ts', kind: 'modify' })])
    await vi.waitFor(() =>
      expect(store.getState().changes['s1']?.map((c) => c.changeId)).toEqual(['c1', 'c2']),
    )
    // 恢复检查点会把之后的改动标记为已撤销
    changes = [change('c1'), { ...change('c2'), status: 'reverted' }]
    emit('s1', [
      ev('s1', 4, 'checkpoint.restored', {
        checkpointId: 'a'.repeat(40),
        truncateConversation: false,
      }),
    ])
    await vi.waitFor(() => expect(store.getState().changes['s1']?.[1]?.status).toBe('reverted'))
  })

  it('keeps only the latest response and the previous list on failure', async () => {
    const resolvers: ((value: unknown) => void)[] = []
    let fail = false
    const { api } = fakeApi({
      'changes.list': () => {
        if (fail) throw new RpcError('changes.not_found')
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })
    const store = createSessionStore(api)
    const first = store.getState().loadChanges('s1')
    const second = store.getState().loadChanges('s1')
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers[1]!({ changes: [change('new')] })
    await second
    resolvers[0]!({ changes: [change('old')] })
    await first
    expect(store.getState().changes['s1']?.map((c) => c.changeId)).toEqual(['new'])

    fail = true
    await store.getState().loadChanges('s1')
    expect(store.getState().changes['s1']?.map((c) => c.changeId)).toEqual(['new'])
    expect(store.getState().error).toEqual({ code: 'changes.not_found' })
  })

  it('reads change content and reverts files, reloading the list', async () => {
    let reverted = false
    const { api, calls } = fakeApi({
      'changes.content': () => ({ after: { kind: 'text', text: 'x' } }),
      'changes.revert': () => {
        if (reverted) throw new RpcError('changes.conflict', { path: 'a.ts' })
        reverted = true
        return { changes: [] }
      },
      'changes.list': () => ({
        changes: [change('c1', { status: reverted ? 'reverted' : 'pending' })],
      }),
    })
    const store = createSessionStore(api)
    await expect(store.getState().changeContent('s1', 'c1')).resolves.toEqual({
      after: { kind: 'text', text: 'x' },
    })
    await expect(store.getState().revertChanges('s1', ['c1'])).resolves.toBe(true)
    expect(calls).toContainEqual(['changes.revert', { sessionId: 's1', changeIds: ['c1'] }])
    expect(store.getState().changes['s1']?.[0]?.status).toBe('reverted')
    await expect(store.getState().revertChanges('s1', ['c1'])).resolves.toBe(false)
    expect(store.getState().error).toEqual({ code: 'changes.conflict', params: { path: 'a.ts' } })
  })

  it('treats a missing list from a test double as empty', async () => {
    const { api } = fakeApi()
    const store = createSessionStore(api)
    await store.getState().loadChanges('s1')
    expect(store.getState().changes['s1']).toEqual([])
  })
})
