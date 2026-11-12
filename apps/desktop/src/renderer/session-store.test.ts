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

  it('sends / skills and @ agents with the prompt', async () => {
    const { api, calls } = fakeApi({
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
      'session.prompt': () => ({ messageId: 'm1' }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(
      await store.getState().sendPrompt('/review @审查员 看 @a.ts', 'normal', {
        skills: ['review'],
        agents: [{ agentId: 'user.review', name: '审查员' }],
        agentNames: ['审查员'],
      }),
    ).toBe(true)
    expect(calls.filter(([method]) => method === 'session.prompt')).toEqual([
      [
        'session.prompt',
        {
          sessionId: 's1',
          content: [{ type: 'text', text: '/review @审查员 看 @a.ts' }],
          mentions: [{ path: 'a.ts' }],
          skills: [{ name: 'review' }],
          agents: [{ agentId: 'user.review', name: '审查员' }],
        },
      ],
    ])

    // 不点名时不带 skills / agents 字段；计划模式仍然只多带 mode
    await store.getState().sendPrompt('hello', 'plan', { skills: [], agents: [] })
    expect(calls.filter(([method]) => method === 'session.prompt').at(-1)).toEqual([
      'session.prompt',
      {
        sessionId: 's1',
        content: [{ type: 'text', text: 'hello' }],
        mode: 'plan',
      },
    ])

    // 协议只收 5 个 Agent，多出来的丢掉而不是让整条消息失败
    const manyAgents = Array.from({ length: 6 }, (_, index) => ({
      agentId: `user.a${index}`,
      name: `A${index}`,
    }))
    await store.getState().sendPrompt('hi', 'normal', { agents: manyAgents })
    const sent = calls.filter(([method]) => method === 'session.prompt').at(-1)?.[1] as {
      agents: unknown[]
    }
    expect(sent.agents).toHaveLength(5)
  })

  it('resolves which paths exist, without failing the reply', async () => {
    const { api } = fakeApi({
      'session.subscribe': () => ({ events: [], lastSeq: 0 }),
      'fs.exists': (params: { paths: string[] }) => ({
        existing: params.paths.filter((path) => path === 'a.ts'),
      }),
    })
    const store = createSessionStore(api)
    expect(await store.getState().pathsExist('p1', [])).toEqual(new Set())
    expect(await store.getState().pathsExist('p1', ['a.ts', 'b.ts'])).toEqual(new Set(['a.ts']))

    const failing = createSessionStore(
      fakeApi({ 'fs.exists': () => Promise.reject(new RpcError('fs.failed')) }).api,
    )
    expect(await failing.getState().pathsExist('p1', ['a.ts'])).toEqual(new Set())
  })

  it('sends version and other optional fields only when given', async () => {
    const { api, calls } = fakeApi({
      'agent.get': () => ({ agentId: 'a', source: 'user', archived: false }),
      'agent.export': () => ({ markdown: '# a' }),
      'agent.effectiveConfig': () => ({}),
      'fs.search': () => ({ entries: [], truncated: false }),
      'activity.resolve': () => ({}),
      'changeset.apply': () => ({}),
      'changeset.reject': () => ({}),
      'provider.models': () => ({ models: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().getAgent('a', 2)
    await store.getState().exportAgent('a', 2)
    await store.getState().agentEffectiveConfig('a')
    await store.getState().searchFiles({ projectId: 'p1' }, 'q')
    await store.getState().resolveActivity('ap', 'allow_once', ' 收紧 ')
    await store.getState().applyChangeSet('s1', 'cs', ['a.ts'])
    await store.getState().rejectChangeSet('s1', 'cs')
    await store.getState().agentEffectiveConfig('a', 's1')
    await store.getState().fetchModels({ id: 'p' } as never, 'key')
    await store.getState().fetchModels({ id: 'p' } as never)

    const picked = calls.filter(([method]) =>
      [
        'agent.get',
        'agent.export',
        'agent.effectiveConfig',
        'fs.search',
        'activity.resolve',
        'changeset.apply',
        'changeset.reject',
        'provider.models',
      ].includes(method),
    )
    expect(picked).toEqual([
      ['agent.get', { agentId: 'a', version: 2 }],
      ['agent.export', { agentId: 'a', version: 2 }],
      ['agent.effectiveConfig', { agentId: 'a' }],
      ['fs.search', { projectId: 'p1', query: 'q' }],
      ['activity.resolve', { approvalId: 'ap', decision: 'allow_once', feedback: '收紧' }],
      ['changeset.apply', { sessionId: 's1', changeSetId: 'cs', paths: ['a.ts'] }],
      ['changeset.reject', { sessionId: 's1', changeSetId: 'cs' }],
      ['agent.effectiveConfig', { agentId: 'a', sessionId: 's1' }],
      ['provider.models', { provider: { id: 'p' }, secret: 'key' }],
      ['provider.models', { provider: { id: 'p' } }],
    ])
  })

  it('reads delegation targets and tolerates an old main process', async () => {
    const { api } = fakeApi({
      'agent.delegationTargets': ({ sessionId }: { sessionId?: string }) =>
        sessionId === undefined
          ? { enabled: true, agentIds: ['builtin.explorer'] }
          : { enabled: false, agentIds: [] },
    })
    const store = createSessionStore(api)
    await expect(store.getState().delegationTargets()).resolves.toEqual({
      enabled: true,
      agentIds: ['builtin.explorer'],
    })
    await expect(store.getState().delegationTargets('s1')).resolves.toEqual({
      enabled: false,
      agentIds: [],
    })

    // 旧主进程返回 `{}`：不做过滤。
    const old = fakeApi()
    await expect(
      createSessionStore(old.api).getState().delegationTargets('s1'),
    ).resolves.toBeUndefined()
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

describe('trial sessions (M4-12)', () => {
  const started = (
    sessionId: string,
    overrides: Partial<{
      agent: { id: string; draftHash: string }
      draftHash: string
      useAgentPermissions: boolean
    }> = {},
  ) => ({
    sessionId,
    agent: { id: 'user.reviewer', draftHash: `hash-${sessionId}` },
    draftHash: `hash-${sessionId}`,
    useAgentPermissions: false,
    ...overrides,
  })

  it('subscribes a trial beside the active session without mixing events', async () => {
    const { api, calls, emit } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'approval.pending': () => ({ approvals: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')

    const trial = await store.getState().startTrial({
      agentId: 'user.reviewer',
      projectPath: '/work',
      configKey: 'draft-1',
    })
    expect(trial?.sessionId).toBe('t1')
    expect(store.getState().trial).toEqual({
      sessionId: 't1',
      agent: { id: 'user.reviewer', draftHash: 'hash-t1' },
      draftHash: 'hash-t1',
      projectPath: '/work',
      useAgentPermissions: false,
      configKey: 'draft-1',
    })
    expect(calls).toContainEqual(['session.subscribe', { sessionId: 't1', afterSeq: 0 }])
    expect(store.getState().views['t1']?.info?.projectPath).toBe('/work')
    expect(store.getState().activeSessionId).toBe('s1')

    emit('t1', [user('t1', 2, 'trial only')])
    expect(store.getState().views['t1']?.messages).toHaveLength(1)
    expect(store.getState().views['s1']?.messages).toHaveLength(0)

    emit('s1', [user('s1', 2, 'normal')])
    expect(store.getState().views['s1']?.messages).toHaveLength(1)
    expect(store.getState().views['t1']?.messages).toHaveLength(1)
  })

  it('sends prompts, stops the trial, and reports failures', async () => {
    let fail = false
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'approval.pending': () => ({ approvals: [] }),
      'session.prompt': () => {
        if (fail) throw new RpcError('run.busy', { sessionId: 't1' })
        return { messageId: 'm1' }
      },
    })
    const store = createSessionStore(api)
    expect(await store.getState().sendTrialPrompt('ignored')).toBe(false)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })

    expect(await store.getState().sendTrialPrompt('   ')).toBe(false)
    expect(await store.getState().sendTrialPrompt('  hello  ')).toBe(true)
    expect(store.getState().awaitingTurn['t1']).toBe(true)
    expect(calls).toContainEqual([
      'session.prompt',
      { sessionId: 't1', content: [{ type: 'text', text: 'hello' }] },
    ])

    await store.getState().abortTrial()
    expect(store.getState().awaitingTurn['t1']).toBeUndefined()
    expect(calls).toContainEqual(['session.abort', { sessionId: 't1' }])

    fail = true
    expect(await store.getState().sendTrialPrompt('again')).toBe(false)
    expect(store.getState().awaitingTurn['t1']).toBeUndefined()
    expect(store.getState().error?.code).toBe('run.busy')
  })

  it('restarts with a new subscription and keeps the project', async () => {
    let next = started('t2', { useAgentPermissions: true })
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'trial.restart': () => next,
      'approval.pending': () => ({ approvals: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({
      agentId: 'user.reviewer',
      projectPath: '/work',
      configKey: 'draft-1',
    })

    const restarted = await store.getState().restartTrial(undefined, 'draft-2')
    expect(restarted?.sessionId).toBe('t2')
    expect(calls).toContainEqual(['session.unsubscribe', { sessionId: 't1' }])
    expect(calls).toContainEqual(['session.subscribe', { sessionId: 't2', afterSeq: 0 }])
    expect(calls).toContainEqual(['trial.restart', { sessionId: 't1' }])
    expect(store.getState().trial).toMatchObject({
      sessionId: 't2',
      draftHash: 'hash-t2',
      projectPath: '/work',
      useAgentPermissions: true,
      configKey: 'draft-2',
    })

    next = started('t3')
    await store.getState().restartTrial(false)
    expect(calls).toContainEqual(['trial.restart', { sessionId: 't2', useAgentPermissions: false }])
    expect(store.getState().trial?.configKey).toBe('draft-2')
  })

  it('routes trial approvals to the trial session', async () => {
    const pending = [
      {
        approvalId: 'a1',
        sessionId: 't1',
        toolCallId: 'c1',
        tool: 'run_command',
        input: {},
        createdAt: 1,
      },
    ]
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'approval.pending': () => ({ approvals: pending }),
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    expect(store.getState().approvals['t1']).toEqual(pending)

    expect(await store.getState().resolveTrialApproval('a1', 'deny', '  no  ')).toBe(true)
    expect(calls).toContainEqual([
      'approval.resolve',
      { sessionId: 't1', approvalId: 'a1', decision: 'deny', feedback: 'no' },
    ])
    expect(await store.getState().resolveTrialApproval('a1', 'allow_once')).toBe(true)
    expect(calls).toContainEqual([
      'approval.resolve',
      { sessionId: 't1', approvalId: 'a1', decision: 'allow_once' },
    ])
  })

  it('closes, lists, and clears trial history', async () => {
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'trial.list': () => ({
        trials: [
          {
            sessionId: 't1',
            agent: { id: 'user.reviewer', draftHash: 'hash-t1' },
            projectPath: '/work',
            title: '',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      'trial.clear': () => ({ cleared: 2 }),
    })
    const store = createSessionStore(api)
    await store.getState().closeTrial()
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    await store.getState().closeTrial()
    expect(calls).toContainEqual(['session.unsubscribe', { sessionId: 't1' }])
    expect(store.getState().trial).toBeUndefined()
    await store.getState().closeTrial()

    expect(await store.getState().listTrials('user.reviewer')).toHaveLength(1)
    expect(await store.getState().clearTrials('user.reviewer')).toBe(2)
  })

  it('returns undefined when the trial cannot start or subscribe', async () => {
    const failing = fakeApi({
      'trial.start': () => {
        throw new RpcError('agent.not_found', { agentId: 'user.reviewer' })
      },
    })
    const store = createSessionStore(failing.api)
    expect(
      await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' }),
    ).toBeUndefined()
    expect(store.getState().error?.code).toBe('agent.not_found')

    const noSubscribe = fakeApi({
      'trial.start': () => started('t1'),
      'session.subscribe': () => {
        throw new RpcError('rpc.closed')
      },
    })
    const second = createSessionStore(noSubscribe.api)
    expect(
      await second.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' }),
    ).toBeUndefined()
    expect(second.getState().trial).toBeUndefined()
  })

  it('does not restart without an active trial', async () => {
    const { api } = fakeApi()
    const store = createSessionStore(api)
    expect(await store.getState().restartTrial()).toBeUndefined()
    expect(await store.getState().resolveTrialApproval('a1', 'allow_once')).toBe(false)
    await store.getState().abortTrial()
    expect(store.getState().trial).toBeUndefined()
  })

  it('unsubscribes the previous trial when starting another one', async () => {
    let next = 0
    const { api, calls } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started(`t${++next}`),
      'approval.pending': () => ({ approvals: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    expect(calls).toContainEqual(['session.unsubscribe', { sessionId: 't1' }])
    expect(calls).toContainEqual(['session.subscribe', { sessionId: 't2', afterSeq: 0 }])
    expect(store.getState().trial?.sessionId).toBe('t2')
  })

  it('keeps the current trial when a restart fails', async () => {
    const { api } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'trial.restart': () => {
        throw new RpcError('agent.not_found', { agentId: 'user.reviewer' })
      },
      'approval.pending': () => ({ approvals: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    expect(await store.getState().restartTrial()).toBeUndefined()
    expect(store.getState().error?.code).toBe('agent.not_found')
    expect(store.getState().trial?.sessionId).toBe('t1')
  })

  it('clears the trial when its restarted subscription fails', async () => {
    const { api } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => {
        if (sessionId === 't2') throw new RpcError('rpc.closed')
        return { events: [created(sessionId)], lastSeq: 1 }
      },
      'trial.start': () => started('t1'),
      'trial.restart': () => started('t2'),
      'approval.pending': () => ({ approvals: [] }),
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    expect(await store.getState().restartTrial()).toBeUndefined()
    expect(store.getState().trial).toBeUndefined()
  })

  it('keeps awaiting when the trial abort fails', async () => {
    const { api } = fakeApi({
      'session.subscribe': ({ sessionId }: { sessionId: string }) => ({
        events: [created(sessionId)],
        lastSeq: 1,
      }),
      'trial.start': () => started('t1'),
      'approval.pending': () => ({ approvals: [] }),
      'session.prompt': () => ({ messageId: 'm1' }),
      'session.abort': () => {
        throw new RpcError('rpc.closed')
      },
    })
    const store = createSessionStore(api)
    await store.getState().startTrial({ agentId: 'user.reviewer', projectPath: '/work' })
    await store.getState().sendTrialPrompt('hello')
    expect(store.getState().awaitingTurn['t1']).toBe(true)
    await store.getState().abortTrial()
    expect(store.getState().awaitingTurn['t1']).toBe(true)
    expect(store.getState().error?.code).toBe('rpc.closed')
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

describe('updates (M5-07)', () => {
  const idle = {
    phase: 'idle' as const,
    currentVersion: '0.1.0',
    channel: 'beta' as const,
    channelPinned: false,
    enabled: true,
    autoCheck: true,
    signatureVerified: false,
    requiresRestart: false,
  }

  it('loads status and applies every update action result', async () => {
    const available = { ...idle, phase: 'available' as const, availableVersion: '0.1.1' }
    const downloading = {
      ...available,
      phase: 'downloading' as const,
      progress: { percent: 10, transferred: 10, total: 100 },
    }
    const downloaded = {
      ...available,
      phase: 'downloaded' as const,
      requiresRestart: true,
    }
    const { api, calls } = fakeApi({
      'update.status': () => idle,
      'update.check': () => available,
      'update.download': () => downloading,
      'update.install': () => downloaded,
      'update.cancel': () => available,
    })
    const store = createSessionStore(api)

    await expect(store.getState().loadUpdateStatus()).resolves.toEqual(idle)
    expect(store.getState().updateStatus).toEqual(idle)

    await expect(store.getState().checkUpdate()).resolves.toEqual(available)
    await expect(store.getState().checkUpdate(true)).resolves.toEqual(available)
    await expect(store.getState().downloadUpdate()).resolves.toEqual(downloading)
    await expect(store.getState().installUpdate()).resolves.toEqual(downloaded)
    await expect(store.getState().cancelUpdate()).resolves.toEqual(available)
    expect(calls).toEqual([
      ['update.status', {}],
      ['update.check', {}],
      ['update.check', { force: true }],
      ['update.download', {}],
      ['update.install', {}],
      ['update.cancel', {}],
    ])
  })

  it('applies pushed status events', () => {
    const { api, emitChannel } = fakeApi()
    const store = createSessionStore(api)
    const next = { ...idle, phase: 'available' as const, availableVersion: '0.1.1' }
    emitChannel('update.status', next)
    expect(store.getState().updateStatus).toEqual(next)
  })

  it('skips and restores a version through settings', async () => {
    const skipped = {
      ...idle,
      phase: 'skipped' as const,
      availableVersion: '0.1.1',
      skippedVersion: '0.1.1',
    }
    const { api, calls } = fakeApi({
      'settings.update': (patch: object) => ({ ...patch }),
      'update.status': () => skipped,
    })
    const store = createSessionStore(api)
    await expect(store.getState().skipUpdateVersion('0.1.1')).resolves.toBe(true)
    await expect(store.getState().restoreSkippedUpdate()).resolves.toBe(true)
    expect(calls).toEqual([
      ['settings.update', { updateSkippedVersion: '0.1.1' }],
      ['update.status', {}],
      ['settings.update', { updateSkippedVersion: null }],
      ['update.status', {}],
    ])
    expect(store.getState().updateStatus).toEqual(skipped)
  })

  it('reports settings failures and keeps the previous status', async () => {
    const { api } = fakeApi({
      'settings.update': () => {
        throw new RpcError('settings.write_failed')
      },
    })
    const store = createSessionStore(api)
    store.setState({ updateStatus: idle })
    await expect(store.getState().skipUpdateVersion('0.1.1')).resolves.toBe(false)
    expect(store.getState().updateStatus).toEqual(idle)
    expect(store.getState().error).toEqual({ code: 'settings.write_failed' })
    await expect(store.getState().restoreSkippedUpdate()).resolves.toBe(false)
    expect(store.getState().error).toEqual({ code: 'settings.write_failed' })
  })

  it('loads license notices and records failures', async () => {
    let fail = false
    const notices = { available: true, text: 'MIT', truncated: false }
    const { api } = fakeApi({
      'app.licenses': () => {
        if (fail) throw new RpcError('storage.not_found')
        return notices
      },
    })
    const store = createSessionStore(api)
    await expect(store.getState().licenses()).resolves.toEqual(notices)
    fail = true
    await expect(store.getState().licenses()).resolves.toBeUndefined()
    expect(store.getState().error).toEqual({ code: 'storage.not_found' })
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

describe('change sets (M4-10)', () => {
  const summary = (changeSetId = 'cs1', over: object = {}) => ({
    changeSetId,
    runId: 'child1',
    parentRunId: 'r1',
    status: 'pending' as const,
    createdAt: 10,
    baseCreatedAt: 5,
    files: 1,
    conflicts: 0,
    added: 2,
    removed: 1,
    ...over,
  })
  const detail = (changeSetId = 'cs1', over: object = {}) => ({
    changeSetId,
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
    ...over,
  })

  it('loads summaries when subscribing and details on demand', async () => {
    const { api, calls } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
      'changeset.list': () => ({ changeSets: [summary()] }),
      'changeset.get': () => ({ changeSet: detail() }),
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    expect(store.getState().changeSets['s1']?.map((item) => item.changeSetId)).toEqual(['cs1'])
    expect(calls).toContainEqual(['changeset.list', { sessionId: 's1' }])

    await expect(store.getState().loadChangeSet('s1', 'cs1')).resolves.toMatchObject({
      changeSetId: 'cs1',
    })
    expect(store.getState().changeSetDetails['cs1']?.files[0]?.path).toBe('src/a.ts')
    expect(store.getState().changeSetLoading['cs1']).toBe(false)
  })

  it('records change set summary failures and clears the loading flag', async () => {
    const { api } = fakeApi({
      'changeset.list': () => {
        throw new RpcError('changeset.list_failed')
      },
    })
    const store = createSessionStore(api)
    await store.getState().loadChangeSets('s1')
    expect(store.getState().changeSetsLoading['s1']).toBe(false)
    expect(store.getState().error).toEqual({ code: 'changeset.list_failed' })
  })

  it('treats a missing change set list from a test double as empty', async () => {
    const { api } = fakeApi({ 'changeset.list': () => ({}) })
    const store = createSessionStore(api)
    await store.getState().loadChangeSets('s1')
    expect(store.getState().changeSets['s1']).toEqual([])
  })

  it('keeps the latest detail response and records failures without dropping the previous detail', async () => {
    const resolvers: ((value: unknown) => void)[] = []
    let fail = false
    const { api } = fakeApi({
      'changeset.get': () => {
        if (fail) throw new RpcError('changeset.failed')
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })
    const store = createSessionStore(api)
    const first = store.getState().loadChangeSet('s1', 'cs1')
    const second = store.getState().loadChangeSet('s1', 'cs1')
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers[1]!({ changeSet: detail('cs1', { createdAt: 20 }) })
    await second
    resolvers[0]!({ changeSet: detail('cs1', { createdAt: 30 }) })
    await first
    expect(store.getState().changeSetDetails['cs1']?.createdAt).toBe(20)

    fail = true
    await expect(store.getState().loadChangeSet('s1', 'cs1')).resolves.toBeUndefined()
    expect(store.getState().changeSetDetails['cs1']?.createdAt).toBe(20)
    expect(store.getState().changeSetErrors['cs1']).toEqual({ code: 'changeset.failed' })
  })

  it('applies, rejects and resolves conflicts, refreshing summaries and file changes', async () => {
    const { api, calls } = fakeApi({
      'changeset.apply': () => ({
        changeSet: detail('cs1', { status: 'applied', checkpointCommit: 'b'.repeat(40) }),
        applied: ['src/a.ts'],
        conflicts: [],
      }),
      'changeset.reject': () => ({
        changeSet: detail('cs1', { status: 'rejected' }),
      }),
      'changeset.resolveConflict': () => ({
        changeSet: detail('cs1', {
          files: [{ ...detail().files[0]!, status: 'accepted' }],
        }),
      }),
      'changeset.list': () => ({ changeSets: [summary('cs1', { status: 'applied' })] }),
      'changes.list': () => ({ changes: [] }),
    })
    const store = createSessionStore(api)
    await expect(store.getState().applyChangeSet('s1', 'cs1', ['src/a.ts'])).resolves.toMatchObject(
      { status: 'applied' },
    )
    expect(calls).toContainEqual([
      'changeset.apply',
      { sessionId: 's1', changeSetId: 'cs1', paths: ['src/a.ts'] },
    ])
    expect(calls).toContainEqual(['changeset.list', { sessionId: 's1' }])
    expect(calls).toContainEqual(['changes.list', { sessionId: 's1' }])

    await expect(store.getState().applyChangeSet('s1', 'cs1')).resolves.toMatchObject({
      status: 'applied',
    })
    expect(calls).toContainEqual(['changeset.apply', { sessionId: 's1', changeSetId: 'cs1' }])

    await expect(store.getState().rejectChangeSet('s1', 'cs1')).resolves.toMatchObject({
      status: 'rejected',
    })
    expect(calls).toContainEqual(['changeset.reject', { sessionId: 's1', changeSetId: 'cs1' }])

    await expect(
      store.getState().resolveChangeSetConflict('s1', 'cs1', 'src/a.ts', 'take-child'),
    ).resolves.toMatchObject({ changeSetId: 'cs1' })
    expect(calls).toContainEqual([
      'changeset.resolveConflict',
      { sessionId: 's1', changeSetId: 'cs1', path: 'src/a.ts', resolution: 'take-child' },
    ])
    expect(store.getState().changeSetDetails['cs1']?.files[0]?.status).toBe('accepted')
  })

  it('records operation failures and refreshes summaries after change set events', async () => {
    let listCalls = 0
    let detailCalls = 0
    const { api, emit } = fakeApi({
      'session.subscribe': () => ({ events: [created('s1')], lastSeq: 1 }),
      'changeset.list': () => {
        listCalls += 1
        return { changeSets: [summary('cs1', { status: listCalls > 1 ? 'applied' : 'pending' })] }
      },
      'changeset.get': () => {
        detailCalls += 1
        return { changeSet: detail('cs1', { createdAt: detailCalls }) }
      },
      'changeset.apply': () => {
        throw new RpcError('changeset.not_pending')
      },
    })
    const store = createSessionStore(api)
    await store.getState().selectSession('s1')
    await store.getState().loadChangeSet('s1', 'cs1')
    expect(store.getState().changeSetDetails['cs1']?.createdAt).toBe(1)

    emit('s1', [
      ev('s1', 2, 'changeset.applied', {
        changeSetId: 'cs1',
        paths: ['src/a.ts'],
        checkpointCommit: 'b'.repeat(40),
      }),
    ])
    await vi.waitFor(() => expect(store.getState().changeSets['s1']?.[0]?.status).toBe('applied'))
    await vi.waitFor(() => expect(store.getState().changeSetDetails['cs1']?.createdAt).toBe(2))

    await expect(store.getState().applyChangeSet('s1', 'cs1')).resolves.toBeUndefined()
    expect(store.getState().changeSetErrors['cs1']).toEqual({ code: 'changeset.not_pending' })
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

  it('reports compacted, nothing-to-compact, and failure separately', async () => {
    const compactedApi = fakeApi({ 'session.compact': () => ({ compacted: true }) }).api
    const compacted = createSessionStore(compactedApi)
    compacted.setState({ activeSessionId: 's1' })
    await expect(compacted.getState().compactSession()).resolves.toBe(true)

    const emptyApi = fakeApi({ 'session.compact': () => ({ compacted: false }) }).api
    const empty = createSessionStore(emptyApi)
    empty.setState({ activeSessionId: 's1' })
    await expect(empty.getState().compactSession()).resolves.toBe(false)

    const failingApi = fakeApi({
      'session.compact': () => {
        throw new RpcError('run.busy')
      },
    }).api
    const failing = createSessionStore(failingApi)
    failing.setState({ activeSessionId: 's1' })
    await expect(failing.getState().compactSession()).resolves.toBeUndefined()
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

  it('reloads projects after removal so the seeded default project appears immediately', async () => {
    const a = {
      projectId: 'p1',
      name: 'A',
      path: '/a',
      createdAt: 1,
      sessionCount: 0,
    }
    const fallback = {
      projectId: 'default-project',
      name: 'Default Project',
      path: '/app/default-project',
      createdAt: 2,
      sessionCount: 0,
      isDefault: true,
    }
    let removed = false
    const { api } = fakeApi({
      'project.list': () => ({ projects: removed ? [fallback] : [a] }),
      'project.remove': () => {
        removed = true
        return {}
      },
    })
    const store = createSessionStore(api)
    await store.getState().refreshProjects()

    await expect(store.getState().removeProject('p1')).resolves.toBe(true)
    expect(store.getState().projects).toEqual([fallback])
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

  it('loads background commands, their output and refreshes on pushes', async () => {
    const command = {
      commandId: 'cmd1',
      sessionId: 's1',
      runId: 'r1',
      command: 'npm run dev',
      cwd: '/work',
      startedAt: 10,
      status: 'running' as const,
    }
    const output = {
      command,
      chunks: [{ stream: 'stdout' as const, text: 'ready\n' }],
      omittedChars: 0,
    }
    const { api, calls, emitChannel } = fakeApi({
      'command.list': () => ({ commands: [command] }),
      'command.output': () => output,
      'command.stop': () => ({ ...command, status: 'stopping' }),
    })
    const store = createSessionStore(api)
    await store.getState().refreshCommands()
    expect(store.getState().commands).toEqual([command])
    expect(store.getState().commandsLoading).toBe(false)
    await expect(store.getState().loadCommandOutput('cmd1')).resolves.toEqual(output)
    expect(store.getState().commandOutputs.cmd1).toEqual(output)
    await expect(store.getState().stopCommand('cmd1')).resolves.toBe(true)
    expect(calls.filter(([method]) => method === 'command.list')).toHaveLength(2)

    emitChannel('command.changed', { commandId: 'cmd1' })
    await vi.waitFor(() =>
      expect(calls.filter(([method]) => method === 'command.output')).toHaveLength(3),
    )
  })
})
