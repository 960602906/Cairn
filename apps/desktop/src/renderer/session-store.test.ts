import { describe, expect, it, vi } from 'vitest'
import {
  RpcError,
  type AgentDraftInput,
  type EventEnvelope,
  type SessionSummary,
} from '@cairn/protocol'
import type { MainApi } from './api.js'
import { createSessionStore, inspectionKey } from './session-store.js'

type Handler = (params: never) => unknown

function fakeApi(handlers: Record<string, Handler> = {}) {
  const listeners = new Set<(data: { sessionId: string; events: EventEnvelope[] }) => void>()
  const channels = new Map<string, Set<(data: never) => void>>()
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
      if (name === 'session.events') {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const set = channels.get(name) ?? new Set()
      set.add(listener as unknown as (data: never) => void)
      channels.set(name, set)
      return () => {
        set.delete(listener as unknown as (data: never) => void)
      }
    },
  } as unknown as MainApi
  const emit = (sessionId: string, events: EventEnvelope[]) =>
    listeners.forEach((l) => l({ sessionId, events }))
  const emitChannel = (name: string, data: unknown) =>
    channels.get(name)?.forEach((listener) => listener(data as never))
  return { api, calls, emit, emitChannel, listeners, channels }
}

describe('agent actions in session store', () => {
  it('manages agents, drafts, publications, and recent list', async () => {
    const calls: { method: string; params: unknown }[] = []
    const fakeApi = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'agent.list') {
          return {
            agents: [
              {
                agentId: 'builtin.coder',
                source: 'builtin',
                version: 1,
                status: 'published',
                hasDraft: false,
                archived: false,
                name: { 'zh-CN': '编程助手' },
                description: { 'zh-CN': '写代码' },
                modelMode: 'inherit',
              },
            ],
          }
        }
        if (method === 'agent.get') {
          return { agentId: 'agent.1', source: 'user', archived: false }
        }
        if (method === 'agent.saveDraft') {
          return {
            agentId: 'agent.1',
            source: 'user',
            archived: false,
            draft: { name: { 'zh-CN': '新助手' } },
          }
        }
        if (method === 'agent.publish') {
          return { agentId: 'agent.1', source: 'user', archived: false, published: { version: 1 } }
        }
        if (method === 'agent.duplicate') {
          return { agentId: 'agent.2', source: 'user', archived: false }
        }
        if (method === 'agent.archive') {
          return { agentId: 'agent.1', source: 'user', archived: true }
        }
        if (method === 'agent.unarchive') {
          return { agentId: 'agent.1', source: 'user', archived: false }
        }
        if (method === 'agent.delete') {
          return {}
        }
        if (method === 'agent.versions') {
          return {
            versions: [
              {
                version: 1,
                publishedAt: 1000,
                name: { 'zh-CN': '编程助手' },
                description: {},
                instructionsBytes: 4,
                usedBySessions: 0,
              },
            ],
          }
        }
        if (method === 'agent.diff') {
          return { fields: [], instructions: { from: 'Run', to: 'Run' } }
        }
        if (method === 'agent.export') {
          return { markdown: '# Agent' }
        }
        if (method === 'agent.import') {
          return { agentId: 'agent.3', source: 'imported', archived: false }
        }
        if (method === 'agent.effectiveConfig') {
          return {
            agentId: 'agent.1',
            source: 'published',
            version: 1,
            systemPrompt: 'Run',
            tools: [],
            skills: [],
            permissionRules: [],
            budget: {
              contextWindow: 128000,
              reserveOutputTokens: 1000,
              systemPromptTokens: 10,
              skillsTokens: 0,
              toolsTokens: 0,
              historyTokens: 0,
            },
          }
        }
        if (method === 'session.setAgent') {
          return {}
        }
        if (method === 'diagnostics.summary') {
          return { appVersion: '1.0.0', exportItems: ['manifest.json'] }
        }
        if (method === 'diagnostics.export') {
          return { path: '/tmp/diag.zip', cancelled: false }
        }
        if (method === 'diagnostics.showInFolder') {
          return {}
        }
        return undefined
      },
      on: () => () => {},
    }

    const { createSessionStore, readRecentAgents } = await import('./session-store.js')
    const store = createSessionStore(fakeApi as unknown as MainApi)

    // Refresh agents
    const agents = await store.getState().refreshAgents()
    expect(agents?.length).toBe(1)
    expect(store.getState().agents[0]?.agentId).toBe('builtin.coder')

    // Get agent
    const detail = await store.getState().getAgent('agent.1')
    expect(detail?.agentId).toBe('agent.1')

    // Save draft
    const saved = await store
      .getState()
      .saveAgentDraft({ id: 'agent.1', instructions: 'Hello' } as unknown as AgentDraftInput)
    expect(saved?.draft?.name['zh-CN']).toBe('新助手')

    // Publish
    const pub = await store.getState().publishAgent('agent.1')
    expect(pub?.published?.version).toBe(1)

    // Duplicate
    const dup = await store.getState().duplicateAgent('builtin.coder')
    expect(dup?.agentId).toBe('agent.2')

    // Archive & Unarchive
    const arc = await store.getState().archiveAgent('agent.1')
    expect(arc?.archived).toBe(true)
    const unarc = await store.getState().unarchiveAgent('agent.1')
    expect(unarc?.archived).toBe(false)

    // Delete
    const del = await store.getState().deleteAgent('agent.1')
    expect(del).toBe(true)

    // Versions & Diff
    const vers = await store.getState().agentVersions('agent.1')
    expect(vers?.length).toBe(1)
    const diff = await store.getState().agentDiff('agent.1', 'draft', 1)
    expect(diff?.instructions.from).toBe(diff?.instructions.to)

    // Export & Import
    const exp = await store.getState().exportAgent('agent.1')
    expect(exp).toBe('# Agent')
    const imp = await store.getState().importAgent('# Draft')
    expect(imp?.agentId).toBe('agent.3')

    // Effective config
    const eff = await store.getState().agentEffectiveConfig('agent.1')
    expect(eff?.budget.contextWindow).toBe(128000)

    // Set session agent updates recent list
    const setOk = await store
      .getState()
      .setSessionAgent('session-1', { id: 'agent.custom', version: 1 })
    expect(setOk).toBe(true)
    expect(store.getState().recentAgents).toContain('agent.custom')

    // Diagnostics actions
    const diagSum = await store.getState().diagnosticsSummary()
    expect(diagSum?.appVersion).toBe('1.0.0')
    const diagExp = await store.getState().exportDiagnostics()
    expect(diagExp?.path).toBe('/tmp/diag.zip')
    const shown = await store.getState().showDiagnosticsInFolder('/tmp/diag.zip')
    expect(shown).toBe(true)

    // readRecentAgents fallback
    const mockStorage = {
      getItem: (key: string) =>
        key === 'cairn.recentAgents' ? JSON.stringify(['a1', 'a2']) : null,
    }
    expect(readRecentAgents(mockStorage as Pick<Storage, 'getItem'>)).toEqual(['a1', 'a2'])
    expect(readRecentAgents({ getItem: () => 'invalid-json' } as Pick<Storage, 'getItem'>)).toEqual(
      [],
    )
  })
})

describe('run inspector in session store', () => {
  it('loads an inspection on demand and caches it by session and run', async () => {
    const result = {
      tree: { sessionId: 's1', rootRunId: 'r1', generatedAt: 1, runs: [] },
      snapshots: [],
      settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
    }
    const { api, calls } = fakeApi({ 'run.inspect': () => result })
    const store = createSessionStore(api)
    expect(await store.getState().inspectRun('s1')).toBe(result)
    expect(calls.at(-1)).toEqual(['run.inspect', { sessionId: 's1' }])
    expect(store.getState().inspections[inspectionKey('s1')]).toEqual({
      loading: false,
      result,
      error: undefined,
    })
    await store.getState().inspectRun('s1', 'child')
    expect(calls.at(-1)).toEqual(['run.inspect', { sessionId: 's1', runId: 'child' }])
  })

  it('stores inspector errors without replacing a previous result', async () => {
    let fail = false
    const result = {
      tree: { sessionId: 's1', rootRunId: 'r1', generatedAt: 1, runs: [] },
      snapshots: [],
      settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
    }
    const { api } = fakeApi({
      'run.inspect': () => {
        if (fail) throw new RpcError('run.not_found')
        return result
      },
    })
    const store = createSessionStore(api)
    await store.getState().inspectRun('s1')
    fail = true
    expect(await store.getState().inspectRun('s1')).toBeUndefined()
    expect(store.getState().inspections[inspectionKey('s1')]).toMatchObject({
      loading: false,
      result,
      error: { code: 'run.not_found' },
    })
    expect(store.getState().error).toBeUndefined()
  })
})

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

  it('reverts one hunk and reloads the list', async () => {
    let reverted = false
    const { api, calls } = fakeApi({
      'changes.revertHunk': () => {
        if (reverted) throw new RpcError('changes.hunk_conflict', { path: 'a.ts' })
        reverted = true
        return { changes: [] }
      },
      'changes.list': () => ({
        changes: [
          change('c1', {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                status: reverted ? 'reverted' : 'pending',
              },
            ],
          }),
        ],
      }),
    })
    const store = createSessionStore(api)
    await expect(store.getState().revertHunk('s1', 'c1', 0)).resolves.toBe(true)
    expect(calls).toContainEqual([
      'changes.revertHunk',
      { sessionId: 's1', changeId: 'c1', hunkIndex: 0 },
    ])
    expect(store.getState().changes['s1']?.[0]?.hunks[0]?.status).toBe('reverted')
    await expect(store.getState().revertHunk('s1', 'c1', 0)).resolves.toBe(false)
    expect(store.getState().error?.code).toBe('changes.hunk_conflict')
  })

  it('sends plan mode only when asked, and forwards plan decisions (M3-05)', async () => {
    const { api, calls } = fakeApi({
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
      'session.prompt': () => ({ messageId: 'm1' }),
      'plan.approve': () => ({ messageId: 'm2' }),
      'plan.replan': () => ({ messageId: 'm3' }),
      'plan.abandon': () => ({}),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(await store.getState().sendPrompt('  计划  ', 'plan')).toBe(true)
    expect(calls.at(-1)).toEqual([
      'session.prompt',
      { sessionId: 's1', content: [{ type: 'text', text: '计划' }], mode: 'plan' },
    ])
    expect(await store.getState().approvePlan('pl1', [{ id: 'read', title: '读' }])).toBe(true)
    expect(calls.at(-1)).toEqual([
      'plan.approve',
      { sessionId: 's1', planId: 'pl1', steps: [{ id: 'read', title: '读' }] },
    ])
    expect(await store.getState().replan('pl2', '换个做法')).toBe(true)
    expect(await store.getState().abandonPlan('pl3')).toBe(true)
    expect(calls.at(-1)).toEqual(['plan.abandon', { sessionId: 's1', planId: 'pl3' }])
  })

  it('treats a missing list from a test double as empty', async () => {
    const { api } = fakeApi()
    const store = createSessionStore(api)
    await store.getState().loadChanges('s1')
    expect(store.getState().changes['s1']).toEqual([])
  })
})

describe('skills (M3-08)', () => {
  const summary = (name = 'demo') => ({
    name,
    description: `${name} description.`,
    sha256: 'a'.repeat(64),
    source: 'user' as const,
    enabled: true,
    pinned: false,
    tokens: { index: 5, pinned: 12 },
    shadowed: false,
    hasScripts: false,
    files: [],
  })

  it('lists, reads, picks, installs, toggles and uninstalls skills', async () => {
    const { api, calls } = fakeApi({
      'skill.list': (params: { projectId?: string }) => ({
        skills: [summary(params.projectId ?? 'global')],
      }),
      'skill.get': () => ({ ...summary(), markdown: '---\n', body: 'body' }),
      'skill.pickSource': () => ({ source: { kind: 'zip', path: '/tmp/demo.zip' } }),
      'skill.install': () => ({ installed: true, skill: summary() }),
      'skill.setEnabled': (input: object) => ({ ...summary(), ...input }),
      'skill.uninstall': () => ({}),
    })
    const store = createSessionStore(api)
    await expect(store.getState().listSkills()).resolves.toEqual([summary('global')])
    await expect(store.getState().listSkills('p1')).resolves.toEqual([summary('p1')])
    await expect(
      store.getState().getSkill({ name: 'demo', source: 'user' }),
    ).resolves.toMatchObject({ body: 'body' })
    await expect(store.getState().pickSkillSource('zip')).resolves.toEqual({
      kind: 'zip',
      path: '/tmp/demo.zip',
    })
    await expect(
      store.getState().installSkill({ kind: 'zip', path: '/tmp/demo.zip' }, true),
    ).resolves.toMatchObject({ installed: true })
    await expect(
      store.getState().setSkillEnabled({ name: 'demo', source: 'user', pinned: true }),
    ).resolves.toMatchObject({ pinned: true })
    await expect(store.getState().uninstallSkill('demo')).resolves.toBe(true)
    expect(calls).toContainEqual([
      'skill.install',
      { source: { kind: 'zip', path: '/tmp/demo.zip' }, confirm: true },
    ])
    expect(calls).toContainEqual([
      'skill.setEnabled',
      { name: 'demo', source: 'user', pinned: true },
    ])
  })

  it('treats a cancelled picker as no source and records failures', async () => {
    const { api } = fakeApi({
      'skill.pickSource': () => ({}),
      'skill.install': () => {
        throw new RpcError('skills.duplicate', { name: 'demo' })
      },
      'skill.uninstall': () => {
        throw new RpcError('skills.not_found', { name: 'demo' })
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().pickSkillSource('directory')).resolves.toBeUndefined()
    await expect(
      store.getState().installSkill({ kind: 'directory', path: '/tmp/demo' }, true),
    ).resolves.toBeUndefined()
    expect(store.getState().error).toEqual({ code: 'skills.duplicate', params: { name: 'demo' } })
    await expect(store.getState().uninstallSkill('demo')).resolves.toBe(false)
    expect(store.getState().error).toEqual({ code: 'skills.not_found', params: { name: 'demo' } })
  })
})

describe('inactive and failing commands', () => {
  it('rejects actions without a selected session', async () => {
    const { api } = fakeApi()
    const store = createSessionStore(api)
    await expect(store.getState().compactSession()).resolves.toBe(false)
    await expect(store.getState().sendPrompt('hello')).resolves.toBe(false)
    await expect(store.getState().sendPrompt('   ')).resolves.toBe(false)
    await expect(store.getState().approvePlan('plan')).resolves.toBe(false)
    await expect(store.getState().replan('plan', 'feedback')).resolves.toBe(false)
    await expect(store.getState().abandonPlan('plan')).resolves.toBe(false)
    await expect(store.getState().resolveApproval('a1', 'allow_once')).resolves.toBe(false)
  })

  it('clears awaiting and returns false when requests fail', async () => {
    const { api } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
      'session.prompt': () => undefined,
      'plan.approve': () => {
        throw new RpcError('run.busy')
      },
      'plan.replan': () => undefined,
      'plan.abandon': () => undefined,
      'approval.pending': () => undefined,
      'settings.get': () => undefined,
      'project.list': () => ({}),
      'project.update': () => undefined,
      'project.remove': () => undefined,
      'provider.models': () => ({ ok: true, models: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')

    await expect(store.getState().sendPrompt('hello')).resolves.toBe(false)
    await expect(store.getState().approvePlan('plan')).resolves.toBe(false)
    await expect(store.getState().replan('plan', 'again')).resolves.toBe(false)
    await expect(store.getState().abandonPlan('plan')).resolves.toBe(false)
    await expect(store.getState().resolveApproval('a1', 'deny', '  ')).resolves.toBe(true)
    await expect(store.getState().loadSettings()).resolves.toBeUndefined()
    await store.getState().refreshProjects()
    await expect(store.getState().updateProject('p1', { name: 'x' })).resolves.toBeUndefined()
    await expect(store.getState().removeProject('p1')).resolves.toBe(false)
    const provider = {
      id: 'p',
      kind: 'openai' as const,
      displayName: 'P',
      baseUrl: 'https://example.com',
      models: [],
    }
    await expect(store.getState().fetchModels(provider)).resolves.toEqual({ ok: true, models: [] })
  })

  it('updates one project without touching the others', async () => {
    const a = {
      projectId: 'p1',
      name: 'A',
      path: '/a',
      createdAt: 1,
      sessionCount: 0,
      readAgentsMd: true,
      enableProjectSkills: false,
    }
    const b = { ...a, projectId: 'p2', name: 'B', path: '/b' }
    const { api } = fakeApi({
      'project.list': () => ({ projects: [a, b] }),
      'project.update': ({ projectId }: { projectId: string }) => ({
        ...(projectId === 'p2' ? b : a),
        name: 'Renamed',
      }),
    })
    const store = createSessionStore(api)
    await store.getState().refreshProjects()
    await store.getState().updateProject('p2', { name: 'Renamed' })
    expect(store.getState().projects.map((project) => project.name)).toEqual(['A', 'Renamed'])
  })
})

describe('activity center', () => {
  const snapshot = {
    approvals: [
      {
        approvalId: 'a1',
        sessionId: 's1',
        sessionTitle: '修复登录',
        runId: 'r1',
        agent: { id: 'builtin.coder', version: 1 },
        toolName: 'run_command',
        toolCategory: 'execute',
        kind: 'tool',
        summary: 'npm install',
        reasonCode: 'permission.ask',
        matchedRuleIds: [],
        requestedAt: 10,
      },
    ],
    running: [],
    completed: [],
    counts: { approvals: 1, running: 0 },
  }

  it('loads snapshots, refreshes on push, resolves approvals, and forwards opens', async () => {
    const { api, calls, emitChannel } = fakeApi({
      'activity.list': () => snapshot,
      'activity.resolve': () => ({}),
    })
    const store = createSessionStore(api)
    await store.getState().refreshActivity()
    expect(store.getState().activity).toEqual(snapshot)
    expect(store.getState().activityLoading).toBe(false)

    emitChannel('activity.changed', {})
    await vi.waitFor(() =>
      expect(calls.filter(([method]) => method === 'activity.list')).toHaveLength(2),
    )

    await expect(store.getState().resolveActivity('a1', 'allow_session', '  ')).resolves.toBe(true)
    expect(calls).toContainEqual([
      'activity.resolve',
      { approvalId: 'a1', decision: 'allow_session' },
    ])

    const opened: string[] = []
    const off = store.getState().onActivityOpen(({ sessionId }) => opened.push(sessionId))
    emitChannel('activity.open', { sessionId: 's1' })
    expect(opened).toEqual(['s1'])
    off()
  })

  it('records activity load failures without clearing a previous snapshot', async () => {
    const { api } = fakeApi({
      'activity.list': () => {
        throw new RpcError('activity.failed')
      },
    })
    const store = createSessionStore(api)
    await store.getState().refreshActivity()
    expect(store.getState().activity).toBeUndefined()
    expect(store.getState().activityLoading).toBe(false)
    expect(store.getState().activityError?.code).toBe('activity.failed')
  })
})
