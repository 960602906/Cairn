import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import {
  createEndpoint,
  MainForRenderer,
  RendererForMain,
  type EventEnvelope,
  type RunInspectResult,
  type RpcChannel,
  type SandboxStatus,
  type UpdateStatus,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import type { CredentialCommands } from './credential-store.js'
import { createSessionEventService, type SessionEventService } from './event-service.js'
import type { ProjectCommands } from './project-service.js'
import type { SkillCommands } from './skill-service.js'
import type { McpCommands } from './mcp-service.js'
import type { AgentCommands } from './agent-service.js'
import type { DiagnosticsCommands } from './diagnostics-service.js'
import type { TrialCommands } from './trial-service.js'
import {
  coalesceDeltas,
  createRendererGateway,
  type ActivityCommands,
  type ApprovalCommands,
  type ChangeCommands,
  type ChangeSetCommands,
  type CheckpointCommands,
  type CommandCommands,
  type InspectCommands,
  type RendererGateway,
  type SandboxCommands,
  type SessionCommands,
  type UpdateCommands,
  type PermissionCommands,
  type ProviderCommands,
  type SettingsCommands,
} from './renderer-gateway.js'

/** 一对内存通道（异步投递，结构化克隆）；记录界面一侧收到的原始消息。 */
function channelPair() {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()]
  const toRenderer: unknown[] = []
  const make = (self: 0 | 1): RpcChannel => ({
    post(message) {
      const copy = structuredClone(message)
      queueMicrotask(() => {
        if (self === 0) toRenderer.push(copy)
        listeners[self === 0 ? 1 : 0].forEach((l) => l(copy))
      })
    },
    onMessage(listener) {
      listeners[self].add(listener)
      return () => listeners[self].delete(listener)
    },
  })
  return { main: make(0), renderer: make(1), toRenderer }
}

const base = { v: 1 as const, runId: 'run-1', ts: 5 }
const user = (sessionId: string, id: string): UnsequencedEvent => ({
  ...base,
  sessionId,
  type: 'message.user',
  payload: { messageId: id, content: [{ type: 'text', text: id }] },
})
const delta = (sessionId: string, id: string, text: string): UnsequencedEvent => ({
  ...base,
  sessionId,
  type: 'message.assistant.delta',
  payload: { messageId: id, text },
})
const completed = (sessionId: string, id: string, text: string): UnsequencedEvent => ({
  ...base,
  sessionId,
  type: 'message.assistant.completed',
  payload: {
    messageId: id,
    content: [{ type: 'text', text }],
    model: { providerId: 'fake', modelId: 'fake-1' },
  },
})

const CP = 'a'.repeat(40)
const PROJECT = { projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }
const CP_BEFORE = 'b'.repeat(40)
const CHANGE_SET = {
  changeSetId: 'cs1',
  sessionId: 's1',
  runId: 'run-child',
  baseCommit: CP,
  status: 'pending' as const,
  createdAt: 1,
  files: [],
  conflicts: 0,
}

let service: SessionEventService
let gateway: RendererGateway
let commands: SessionCommands
let projects: ProjectCommands
let settings: SettingsCommands
let credentials: CredentialCommands
let providers: ProviderCommands
let permissions: PermissionCommands
let changes: ChangeCommands
let checkpoints: CheckpointCommands
let changeSets: ChangeSetCommands
let approvals: ApprovalCommands
let skills: SkillCommands
let agents: AgentCommands
let trials: TrialCommands
let diagnostics: DiagnosticsCommands
let sandbox: SandboxCommands
let update: UpdateCommands
let inspect: InspectCommands
let activity: ActivityCommands
let backgroundCommands: CommandCommands
const approvalListeners = new Set<(sessionId: string) => void>()
const activityListeners = new Set<() => void>()
const commandListeners = new Set<(commandId: string) => void>()
const updateListeners = new Set<(status: UpdateStatus) => void>()

const INSPECT_RESULT: RunInspectResult = {
  tree: {
    sessionId: 's1',
    rootRunId: 'r1',
    generatedAt: 1,
    runs: [],
  },
  snapshots: [],
  settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
}

const ACTIVITY_RESULT = {
  approvals: [],
  running: [],
  completed: [],
  counts: { approvals: 0, running: 0 },
}

const APP_INFO = {
  schemaVersion: 1 as const,
  version: '0.1.0',
  channel: 'beta' as const,
  commit: 'unknown',
  buildTime: '',
  electronVersion: '45.2.1',
  nodeVersion: '24.11.0',
  name: 'Cairn',
  appId: 'com.cairn.desktop',
  copyright: 'Copyright © 2026 Cairn contributors',
  packaged: false,
  databaseSchemaVersion: 17,
}

function setup(eventsOverride?: Partial<SessionEventService>) {
  const storage = createMemoryStorage({ now: () => 1 })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  for (const id of ['s1', 's2']) {
    storage.sessions.create({ sessionId: id, projectId: 'p1', workspacePath: '/work', title: '' })
  }
  service = createSessionEventService({ storage })
  commands = {
    create: vi.fn(() => ({ sessionId: 'new' })),
    list: vi.fn(() => ({ sessions: [] })),
    prompt: vi.fn(() => ({ messageId: 'm1' })),
    abort: vi.fn(() => ({})),
    rename: vi.fn(() => ({})),
    archive: vi.fn(() => ({})),
    setModel: vi.fn(() => ({})),
    compact: vi.fn(() => ({ compacted: false })),
    updateBrief: vi.fn(() => ({})),
    approvePlan: vi.fn(() => ({ messageId: 'm1' })),
    replan: vi.fn(() => ({ messageId: 'm1' })),
    abandonPlan: vi.fn(() => ({})),
    setAgent: vi.fn(() => ({})),
  }
  projects = {
    list: vi.fn(() => ({ projects: [PROJECT] })),
    open: vi.fn(async () => ({ project: PROJECT })),
    update: vi.fn(() => PROJECT),
    remove: vi.fn(() => ({})),
  }
  settings = {
    get: vi.fn(() => ({ locale: 'zh-CN' as const, providers: [] })),
    update: vi.fn((patch) => ({ locale: patch.locale ?? ('zh-CN' as const), providers: [] })),
    shell: vi.fn(async () => ({ detected: 'bash', options: ['auto' as const] })),
  }
  credentials = {
    set: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({ deleted: true })),
    status: vi.fn(async () => ({ configured: true, available: true })),
  }
  providers = {
    test: vi.fn(async () => ({ ok: true as const, latencyMs: 12 })),
    models: vi.fn(async () => ({ ok: true as const, models: [{ id: 'm1' }] })),
  }
  permissions = {
    list: vi.fn(() => ({ rules: [] })),
    add: vi.fn(({ rule, projectId }) => ({
      rule,
      ...(projectId ? { projectId } : {}),
      createdAt: 1,
    })),
    delete: vi.fn(() => ({})),
  }
  changes = {
    list: vi.fn(() => ({ changes: [] })),
    revert: vi.fn(async () => ({ changes: [] })),
    revertHunk: vi.fn(async () => ({ changes: [] })),
    content: vi.fn(async () => ({ after: { kind: 'text' as const, text: 'x' } })),
  }
  checkpoints = {
    list: vi.fn(() => ({ checkpoints: [] })),
    preview: vi.fn(async () => ({ before: CP_BEFORE, files: [] })),
    restore: vi.fn(async () => ({
      before: CP_BEFORE,
      files: [{ path: 'a.txt', status: 'modified' as const }],
    })),
  }
  changeSets = {
    list: vi.fn(() => ({ changeSets: [] })),
    get: vi.fn(() => ({ changeSet: CHANGE_SET })),
    apply: vi.fn(async () => ({ changeSet: CHANGE_SET, applied: [], conflicts: [] })),
    reject: vi.fn(async () => ({ changeSet: CHANGE_SET })),
    resolveConflict: vi.fn(async () => ({ changeSet: CHANGE_SET })),
  }
  skills = {
    list: vi.fn(() => ({ skills: [] })),
    get: vi.fn(),
    pickSource: vi.fn(async () => ({
      source: { kind: 'directory' as const, path: '/tmp/demo' },
    })),
    install: vi.fn(() => ({
      installed: false,
      skill: {
        name: 'demo',
        description: 'A sample skill.',
        sha256: 'a'.repeat(64),
        source: 'user' as const,
        enabled: true,
        pinned: false,
        tokens: { index: 5, pinned: 12 },
        shadowed: false,
        hasScripts: false,
        files: [],
        markdown: '---\n',
        body: '',
      },
    })),
    installFromUrl: vi.fn(async () => ({
      installed: true,
      skill: {
        name: 'demo',
        description: 'A sample skill.',
        sha256: 'a'.repeat(64),
        source: 'user' as const,
        enabled: true,
        pinned: false,
        tokens: { index: 5, pinned: 12 },
        shadowed: false,
        hasScripts: false,
        files: [],
        markdown: '# demo',
        body: 'demo',
      },
    })),
    uninstall: vi.fn(() => ({})),
    setEnabled: vi.fn(),
  }
  approvalListeners.clear()
  commandListeners.clear()
  const agentDetail = {
    agentId: 'user.x',
    source: 'user' as const,
    archived: false,
    validation: { ok: true, errors: [], warnings: [] },
  }
  agents = {
    list: vi.fn(() => ({ agents: [] })),
    get: vi.fn(() => agentDetail),
    saveDraft: vi.fn(() => agentDetail),
    publish: vi.fn(() => agentDetail),
    duplicate: vi.fn(() => agentDetail),
    archive: vi.fn(() => agentDetail),
    unarchive: vi.fn(() => agentDetail),
    delete: vi.fn(() => ({})),
    versions: vi.fn(() => ({ versions: [] })),
    diff: vi.fn(() => ({ fields: [], instructions: { from: '', to: '' } })),
    export: vi.fn(() => ({ markdown: '---\n---\n' })),
    import: vi.fn(() => agentDetail),
    effectiveConfig: vi.fn(() => ({
      agentId: 'user.x',
      source: 'published' as const,
      version: 1,
      systemPrompt: 'prompt',
      tools: [],
      skills: [],
      permissionRules: [],
      budget: {
        contextWindow: 128_000,
        reserveOutputTokens: 4_096,
        systemPromptTokens: 1,
        toolsTokens: 0,
        skillsTokens: 0,
        historyTokens: 0,
      },
    })),
  }
  trials = {
    start: vi.fn(() => ({
      sessionId: 'trial-1',
      agent: { id: 'user.x', draftHash: 'hash' },
      draftHash: 'hash',
      useAgentPermissions: false,
    })),
    restart: vi.fn(() => ({
      sessionId: 'trial-2',
      agent: { id: 'user.x', draftHash: 'hash' },
      draftHash: 'hash',
      useAgentPermissions: false,
    })),
    clear: vi.fn(() => ({ cleared: 0 })),
    list: vi.fn(() => ({ trials: [] })),
  }
  approvals = {
    pending: vi.fn(() => ({ approvals: [] })),
    resolve: vi.fn(() => ({})),
    subscribe: vi.fn((listener: (sessionId: string) => void) => {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    }),
  }
  diagnostics = {
    summary: vi.fn(() => ({
      appVersion: '0.0.0',
      electronVersion: '0.0.0',
      build: APP_INFO,
      platform: process.platform,
      arch: process.arch,
      logs: { mainLogLines: 0, hostLogLines: 0 },
      settings: { providersCount: 0, mcpServersCount: 0, hasAuxiliaryModel: false },
      exportItems: ['manifest.json'],
    })),
    export: vi.fn(() => ({ cancelled: true })),
    showInFolder: vi.fn(() => ({ shown: true })),
  }
  const sandboxStatus: SandboxStatus = {
    platform: 'win32',
    mechanism: 'restricted-token',
    policy: { profile: 'workspace-write', network: 'none' },
    unavailable: 'deny',
    capability: {
      available: true,
      supported: true,
      mechanism: 'restricted-token',
      networkIsolated: false,
      checks: { restrictedToken: true, lowIntegrity: true, jobObject: true, appContainer: false },
    },
  }
  sandbox = {
    status: vi.fn(() => sandboxStatus),
  }
  const updateStatus: UpdateStatus = {
    phase: 'idle',
    currentVersion: '0.1.0',
    channel: 'beta',
    enabled: true,
    autoCheck: true,
    source: 'https://updates.example/cairn/',
    signatureVerified: false,
    requiresRestart: false,
  }
  update = {
    status: vi.fn(() => updateStatus),
    check: vi.fn(async () => updateStatus),
    download: vi.fn(async () => updateStatus),
    install: vi.fn(async () => updateStatus),
    cancel: vi.fn(async () => updateStatus),
    subscribe: vi.fn((listener: (status: UpdateStatus) => void) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    }),
  }
  inspect = {
    inspect: vi.fn(() => INSPECT_RESULT),
  }
  activity = {
    list: vi.fn(() => ACTIVITY_RESULT),
    resolve: vi.fn(() => ({})),
    subscribe: vi.fn((listener: () => void) => {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    }),
  }
  backgroundCommands = {
    list: vi.fn(() => ({ commands: [] })),
    output: vi.fn(() => {
      throw new Error('not used')
    }),
    stop: vi.fn(() => {
      throw new Error('not used')
    }),
    subscribe: vi.fn((listener: (commandId: string) => void) => {
      commandListeners.add(listener)
      return () => commandListeners.delete(listener)
    }),
  }
  gateway = createRendererGateway({
    appInfo: { info: () => APP_INFO },
    events: { ...service, ...eventsOverride },
    commands,
    projects,
    files: {
      list: vi.fn(async () => ({ entries: [], truncated: false })),
      create: vi.fn(async () => ({ path: '' })),
      rename: vi.fn(async () => ({ path: '' })),
      delete: vi.fn(async () => ({})),
      reveal: vi.fn(async () => ({})),
    },
    settings,
    credentials,
    providers,
    permissions,
    changes,
    checkpoints,
    hub: {
      skills: vi.fn(async () => ({ items: [] })),
      mcp: vi.fn(async () => ({ items: [] })),
    },
    changeSets,
    approvals,
    skills,
    mcp: {} as unknown as McpCommands,
    agents,
    trials,
    diagnostics,
    sandbox,
    update,
    inspect,
    activity,
    backgroundCommands,
    mcpStatus: () => () => undefined,
  })
  return connectRenderer()
}

function connectRenderer() {
  const pair = channelPair()
  const connection = gateway.connect(pair.main)
  const client = createEndpoint(pair.renderer, { local: RendererForMain, remote: MainForRenderer })
  const pushed: EventEnvelope[][] = []
  client.on('session.events', ({ events }) => pushed.push(events))
  return { connection, client, pushed, toRenderer: pair.toRenderer }
}

const seqs = (events: readonly EventEnvelope[]) => events.map((e) => e.seq)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  gateway?.close()
  vi.useRealTimers()
})

describe('coalesceDeltas', () => {
  const at = (event: UnsequencedEvent, seq: number) => ({ ...event, seq }) as EventEnvelope

  it('merges adjacent deltas of the same message and keeps the last seq', () => {
    const merged = coalesceDeltas([
      at(delta('s1', 'a', 'Hel'), 2),
      at(delta('s1', 'a', 'lo'), 3),
      at(delta('s1', 'b', '!'), 4),
      at(user('s1', 'u'), 5),
      at(delta('s1', 'b', '?'), 6),
    ])
    expect(merged.map((e) => [e.type, e.seq, (e.payload as { text?: string }).text])).toEqual([
      ['message.assistant.delta', 3, 'Hello'],
      ['message.assistant.delta', 4, '!'],
      ['message.user', 5, undefined],
      ['message.assistant.delta', 6, '?'],
    ])
  })

  it('keeps reasoning, other runs and other tool streams apart', () => {
    const reasoning = {
      ...base,
      sessionId: 's1',
      type: 'message.reasoning.delta',
      payload: { messageId: 'a', text: 'r' },
    } as UnsequencedEvent
    const out = (stream: 'stdout' | 'stderr', text: string, toolCallId = 't1') =>
      ({
        ...base,
        sessionId: 's1',
        type: 'tool.output.delta',
        payload: { toolCallId, stream, text },
      }) as UnsequencedEvent
    const merged = coalesceDeltas([
      at(delta('s1', 'a', 'x'), 1),
      at(reasoning, 2),
      at({ ...delta('s1', 'a', 'y'), runId: 'run-2' } as UnsequencedEvent, 3),
      at(out('stdout', 'a'), 4),
      at(out('stdout', 'b'), 5),
      at(out('stderr', 'c'), 6),
      at(out('stderr', 'd', 't2'), 7),
      at(
        {
          ...base,
          sessionId: 's1',
          type: 'command.output.delta',
          payload: { commandId: 'c1', stream: 'stdout', text: 'a' },
        } as UnsequencedEvent,
        8,
      ),
      at(
        {
          ...base,
          sessionId: 's1',
          type: 'command.output.delta',
          payload: { commandId: 'c1', stream: 'stdout', text: 'b' },
        } as UnsequencedEvent,
        9,
      ),
      at(
        {
          ...base,
          sessionId: 's1',
          type: 'command.output.delta',
          payload: { commandId: 'c1', stream: 'stderr', text: 'c' },
        } as UnsequencedEvent,
        10,
      ),
    ])
    expect(seqs(merged)).toEqual([1, 2, 3, 5, 6, 7, 9, 10])
    // 非增量事件从不合并
    expect(seqs(coalesceDeltas([at(user('s1', 'a'), 1), at(user('s1', 'b'), 2)]))).toEqual([1, 2])
    expect((merged[3]!.payload as { text: string }).text).toBe('ab')
    expect((merged[6]!.payload as { text: string }).text).toBe('ab')
  })
})

describe('createRendererGateway: subscribe', () => {
  it('backfills persisted events, then streams live events without duplicates', async () => {
    const { client, pushed } = setup()
    service.publish([user('s1', 'u1'), delta('s1', 'a1', 'skipped'), user('s1', 'u2')])

    const result = await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    expect(seqs(result.events)).toEqual([1, 3])
    expect(result.lastSeq).toBe(3)

    await vi.advanceTimersByTimeAsync(0)
    service.publish([completed('s1', 'a1', 'Hi'), user('s1', 'u3')])
    await vi.advanceTimersByTimeAsync(0)
    expect(pushed.map(seqs)).toEqual([[4, 5]])

    const view = reduceSessionEvents(createSessionView('s1'), [...result.events, ...pushed.flat()])
    expect(view.messages.map((m) => m.messageId)).toEqual(['u1', 'u2', 'a1', 'u3'])
  })

  it('resumes after afterSeq and reports it when nothing is newer', async () => {
    const { client } = setup()
    service.publish([user('s1', 'u1'), user('s1', 'u2')])
    const resumed = await client.request('session.subscribe', { sessionId: 's1', afterSeq: 1 })
    expect(seqs(resumed.events)).toEqual([2])
    const empty = await client.request('session.subscribe', { sessionId: 's1', afterSeq: 7 })
    expect(empty).toEqual({ events: [], lastSeq: 7 })
  })

  it('holds events published before the response until the response is sent', async () => {
    let publishNext = false
    const { client, toRenderer } = setup({
      readAfter: (sessionId, afterSeq, limit) => {
        const result = service.readAfter(sessionId, afterSeq, limit)
        // 在处理函数返回之后、响应发出之前发布新事件
        if (publishNext) queueMicrotask(() => service.publish([user('s1', 'late')]))
        return result
      },
    })
    service.publish([user('s1', 'u1')])
    publishNext = true
    const result = await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    expect(seqs(result.events)).toEqual([1])
    await vi.advanceTimersByTimeAsync(0)

    const kinds = toRenderer
      .map((m) => m as { kind: string; name?: string })
      .filter((m) => m.kind === 'response' || m.kind === 'event')
      .map((m) => m.name ?? m.kind)
    expect(kinds).toEqual(['response', 'session.events'])
  })

  it('stops after unsubscribe and only delivers subscribed sessions', async () => {
    const { client, pushed, connection } = setup()
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)
    service.publish([user('s2', 'other')])
    await vi.advanceTimersByTimeAsync(100)
    expect(pushed).toEqual([])
    expect(connection.subscriptions()).toEqual(['s1'])

    await client.request('session.unsubscribe', { sessionId: 's1' })
    service.publish([user('s1', 'after')])
    await vi.advanceTimersByTimeAsync(100)
    expect(pushed).toEqual([])
    expect(connection.subscriptions()).toEqual([])
  })

  it('replaces a previous subscription of the same session (window reload)', async () => {
    const { client, pushed } = setup()
    service.publish([user('s1', 'u1'), user('s1', 'u2')])
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 2 })
    const again = await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    expect(seqs(again.events)).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(0)
    service.publish([user('s1', 'u3')])
    await vi.advanceTimersByTimeAsync(0)
    expect(pushed.map(seqs)).toEqual([[3]])
  })
})

describe('createRendererGateway: frames', () => {
  it('merges deltas into one push per frame', async () => {
    const { client, pushed } = setup()
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)

    service.publish([delta('s1', 'a', 'Hel')])
    service.publish([delta('s1', 'a', 'lo')])
    await vi.advanceTimersByTimeAsync(20)
    expect(pushed).toEqual([])
    service.publish([delta('s1', 'a', '!')])
    await vi.advanceTimersByTimeAsync(20)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.map((e) => [e.seq, (e.payload as { text: string }).text])).toEqual([
      [3, 'Hello!'],
    ])
  })

  it('pushes persisted events immediately together with pending deltas', async () => {
    const { client, pushed } = setup()
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)

    service.publish([delta('s1', 'a', 'Hi')])
    service.publish([completed('s1', 'a', 'Hi')])
    await vi.advanceTimersByTimeAsync(0)
    expect(pushed.map(seqs)).toEqual([[1, 2]])
    await vi.advanceTimersByTimeAsync(100)
    expect(pushed).toHaveLength(1)
  })
})

describe('createRendererGateway: commands and lifecycle', () => {
  it('delegates validated commands to the session manager', async () => {
    const { client } = setup()
    await expect(client.request('session.create', { projectPath: '/work' })).resolves.toEqual({
      sessionId: 'new',
    })
    await expect(client.request('session.list', {})).resolves.toEqual({ sessions: [] })
    await expect(
      client.request('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: 'hi' }],
      }),
    ).resolves.toEqual({ messageId: 'm1' })
    await expect(client.request('session.abort', { sessionId: 's1' })).resolves.toEqual({})
    expect(commands.create).toHaveBeenCalledWith({ projectPath: '/work' })
    expect(commands.abort).toHaveBeenCalledWith({ sessionId: 's1' })
    await expect(
      client.request('session.rename', { sessionId: 's1', title: 'New name' }),
    ).resolves.toEqual({})
    await expect(client.request('session.archive', { sessionId: 's2' })).resolves.toEqual({})
    expect(commands.rename).toHaveBeenCalledWith({ sessionId: 's1', title: 'New name' })
    expect(commands.archive).toHaveBeenCalledWith({ sessionId: 's2' })
    const model = { providerId: 'p', modelId: 'm' }
    await expect(client.request('session.setModel', { sessionId: 's1', model })).resolves.toEqual(
      {},
    )
    expect(commands.setModel).toHaveBeenCalledWith({ sessionId: 's1', model })
  })

  it('delegates credential requests; no request returns the key', async () => {
    const { client } = setup()
    await expect(
      client.request('credentials.set', { ref: 'deepseek', secret: 'secret-key-value' }),
    ).resolves.toEqual({})
    await expect(client.request('credentials.status', { ref: 'deepseek' })).resolves.toEqual({
      configured: true,
      available: true,
    })
    await expect(client.request('credentials.delete', { ref: 'deepseek' })).resolves.toEqual({
      deleted: true,
    })
    expect(credentials.set).toHaveBeenCalledWith({ ref: 'deepseek', secret: 'secret-key-value' })
    await expect(
      client.request('credentials.set', { ref: 'bad ref', secret: 'x' }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
  })

  it('delegates change requests to the change service', async () => {
    const { client } = setup()
    await expect(client.request('changes.list', { sessionId: 's1' })).resolves.toEqual({
      changes: [],
    })
    await expect(
      client.request('changes.revert', { sessionId: 's1', changeIds: ['c1'] }),
    ).resolves.toEqual({ changes: [] })
    expect(changes.revert).toHaveBeenCalledWith({ sessionId: 's1', changeIds: ['c1'] })
    await expect(
      client.request('changes.revertHunk', { sessionId: 's1', changeId: 'c1', hunkIndex: 0 }),
    ).resolves.toEqual({ changes: [] })
    expect(changes.revertHunk).toHaveBeenCalledWith({
      sessionId: 's1',
      changeId: 'c1',
      hunkIndex: 0,
    })
    await expect(
      client.request('changes.revertHunk', { sessionId: 's1', changeId: 'c1', hunkIndex: -1 }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
    await expect(
      client.request('changes.revert', { sessionId: 's1', changeIds: [] }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
    await expect(
      client.request('changes.content', { sessionId: 's1', changeId: 'c1' }),
    ).resolves.toEqual({ after: { kind: 'text', text: 'x' } })
    expect(changes.content).toHaveBeenCalledWith({ sessionId: 's1', changeId: 'c1' })
  })

  it('delegates skill requests to the skill service', async () => {
    const { client } = setup()
    const summary = {
      name: 'demo',
      description: 'A sample skill.',
      sha256: 'a'.repeat(64),
      source: 'user' as const,
      enabled: false,
      pinned: true,
      tokens: { index: 5, pinned: 12 },
      shadowed: false,
      hasScripts: false,
      files: [],
    }
    vi.mocked(skills.get).mockReturnValue({ ...summary, markdown: '---\n', body: 'body' })
    vi.mocked(skills.setEnabled).mockReturnValue(summary)
    await expect(client.request('skill.list', {})).resolves.toEqual({ skills: [] })
    await expect(client.request('skill.pickSource', { kind: 'zip' })).resolves.toEqual({
      source: { kind: 'directory', path: '/tmp/demo' },
    })
    expect(skills.pickSource).toHaveBeenCalledWith({ kind: 'zip' })
    await expect(
      client.request('skill.get', { name: 'demo', source: 'user' }),
    ).resolves.toMatchObject({ name: 'demo', body: 'body' })
    await expect(
      client.request('skill.install', {
        source: { kind: 'directory', path: '/tmp/demo' },
      }),
    ).resolves.toMatchObject({ installed: false })
    await expect(client.request('skill.uninstall', { name: 'demo' })).resolves.toEqual({})
    await expect(
      client.request('skill.setEnabled', {
        name: 'demo',
        source: 'user',
        enabled: false,
        pinned: true,
      }),
    ).resolves.toEqual(summary)
    expect(skills.list).toHaveBeenCalledWith({})
    await expect(
      client.request('skill.setEnabled', { name: 'demo', source: 'project' }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
  })

  it('delegates checkpoint requests to the checkpoint service', async () => {
    const { client } = setup()
    await expect(client.request('checkpoint.list', { sessionId: 's1' })).resolves.toEqual({
      checkpoints: [],
    })
    await expect(
      client.request('checkpoint.preview', { sessionId: 's1', checkpointId: CP }),
    ).resolves.toEqual({ before: CP_BEFORE, files: [] })
    await expect(
      client.request('checkpoint.restore', { sessionId: 's1', checkpointId: CP }),
    ).resolves.toEqual({ before: CP_BEFORE, files: [{ path: 'a.txt', status: 'modified' }] })
    expect(checkpoints.restore).toHaveBeenCalledWith({ sessionId: 's1', checkpointId: CP })
    // 检查点 id 只接受完整的提交 id
    await expect(
      client.request('checkpoint.restore', { sessionId: 's1', checkpointId: 'HEAD' }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
  })

  it('delegates change set requests to the change set service', async () => {
    const { client } = setup()
    await expect(client.request('changeset.list', { sessionId: 's1' })).resolves.toEqual({
      changeSets: [],
    })
    await expect(
      client.request('changeset.get', { sessionId: 's1', changeSetId: 'cs1' }),
    ).resolves.toEqual({ changeSet: CHANGE_SET })
    const apply = { sessionId: 's1', changeSetId: 'cs1', paths: ['a.txt'] }
    await expect(client.request('changeset.apply', apply)).resolves.toEqual({
      changeSet: CHANGE_SET,
      applied: [],
      conflicts: [],
    })
    expect(changeSets.apply).toHaveBeenCalledWith(apply)
    await expect(
      client.request('changeset.reject', { sessionId: 's1', changeSetId: 'cs1' }),
    ).resolves.toEqual({ changeSet: CHANGE_SET })
    const conflict = {
      sessionId: 's1',
      changeSetId: 'cs1',
      path: 'a.txt',
      resolution: 'manual' as const,
    }
    await expect(client.request('changeset.resolveConflict', conflict)).resolves.toEqual({
      changeSet: CHANGE_SET,
    })
    expect(changeSets.resolveConflict).toHaveBeenCalledWith(conflict)
  })

  it('delegates approval requests to the approval service', async () => {
    const { client } = setup()
    await expect(client.request('approval.pending', { sessionId: 's1' })).resolves.toEqual({
      approvals: [],
    })
    const params = { sessionId: 's1', approvalId: 'a1', decision: 'deny' as const, feedback: 'no' }
    await expect(client.request('approval.resolve', params)).resolves.toEqual({})
    expect(approvals.resolve).toHaveBeenCalledWith(params)
    await expect(
      client.request('approval.resolve', { ...params, feedback: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })
  })

  it('delegates activity requests and pushes change/open events', async () => {
    const { client } = setup()
    await expect(client.request('activity.list', {})).resolves.toEqual(ACTIVITY_RESULT)
    const params = {
      approvalId: 'a1',
      decision: 'allow_session' as const,
      feedback: 'ok',
    }
    await expect(client.request('activity.resolve', params)).resolves.toEqual({})
    expect(activity.resolve).toHaveBeenCalledWith(params)
    await expect(
      client.request('activity.resolve', { ...params, feedback: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'rpc.invalid_params' })

    const changed: number[] = []
    const opened: string[] = []
    client.on('activity.changed', () => changed.push(1))
    client.on('activity.open', ({ sessionId }) => opened.push(sessionId))
    activityListeners.forEach((listener) => listener())
    gateway.openActivitySession('s2')
    await vi.advanceTimersByTimeAsync(0)
    expect(changed).toHaveLength(1)
    expect(opened).toEqual(['s2'])
  })

  it('notifies subscribed windows when pending approvals change, after queued events', async () => {
    const { client, pushed } = setup()
    const order: string[] = []
    client.on('session.events', () => order.push('events'))
    client.on('approval.changed', ({ sessionId }) => order.push(`changed:${sessionId}`))
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)
    service.publish([delta('s1', 'a1', 'x')])
    approvalListeners.forEach((l) => l('s2'))
    approvalListeners.forEach((l) => l('s1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['events', 'changed:s1'])
    expect(pushed).toHaveLength(1)
    gateway.close()
    expect(approvalListeners.size).toBe(0)
  })

  it('serves background command requests and change pushes (M4-14)', async () => {
    const { client } = setup()
    const command = {
      commandId: 'cmd1',
      sessionId: 's1',
      runId: 'r1',
      command: 'npm run dev',
      cwd: '/work',
      startedAt: 1,
      status: 'running' as const,
    }
    vi.mocked(backgroundCommands.list).mockReturnValue({ commands: [command] })
    vi.mocked(backgroundCommands.output).mockReturnValue({
      command,
      chunks: [{ stream: 'stdout', text: 'ready' }],
      omittedChars: 0,
    })
    vi.mocked(backgroundCommands.stop).mockReturnValue({ ...command, status: 'stopping' })
    await expect(client.request('command.list', {})).resolves.toEqual({ commands: [command] })
    await expect(client.request('command.output', { commandId: 'cmd1' })).resolves.toMatchObject({
      chunks: [{ stream: 'stdout', text: 'ready' }],
    })
    await expect(client.request('command.stop', { commandId: 'cmd1' })).resolves.toMatchObject({
      status: 'stopping',
    })
    const changed: string[] = []
    client.on('command.changed', ({ commandId }) => changed.push(commandId))
    commandListeners.forEach((listener) => listener('cmd1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(changed).toEqual(['cmd1'])
  })

  it('delegates project requests to the project service', async () => {
    const { client } = setup()
    await expect(client.request('project.list', {})).resolves.toEqual({ projects: [PROJECT] })
    await expect(client.request('project.open', {})).resolves.toEqual({ project: PROJECT })
    await expect(
      client.request('project.update', { projectId: 'p1', readAgentsMd: false }),
    ).resolves.toEqual(PROJECT)
    await expect(client.request('project.remove', { projectId: 'p1' })).resolves.toEqual({})
    expect(projects.open).toHaveBeenCalledOnce()
    expect(projects.update).toHaveBeenCalledOnce()
    expect(projects.remove).toHaveBeenCalledOnce()
  })

  it('delegates agent requests and session.setAgent (M3-11)', async () => {
    const { client } = setup()
    await expect(client.request('agent.list', {})).resolves.toEqual({ agents: [] })
    await expect(client.request('agent.get', { agentId: 'user.x' })).resolves.toMatchObject({
      agentId: 'user.x',
    })
    await expect(client.request('agent.publish', { agentId: 'user.x' })).resolves.toMatchObject({
      agentId: 'user.x',
    })
    await expect(client.request('agent.delete', { agentId: 'user.x' })).resolves.toEqual({})
    const config = await client.request('agent.effectiveConfig', {
      agentId: 'user.x',
      sessionId: 's1',
    })
    expect(config.agentId).toBe('user.x')
    await expect(
      client.request('session.setAgent', {
        sessionId: 's1',
        agent: { id: 'user.x', version: 1 },
      }),
    ).resolves.toEqual({})
    expect(commands.setAgent).toHaveBeenCalledWith({
      sessionId: 's1',
      agent: { id: 'user.x', version: 1 },
    })
  })

  it('delegates run.inspect requests to the inspect service (M4-04)', async () => {
    const { client } = setup()
    await expect(client.request('run.inspect', { sessionId: 's1' })).resolves.toEqual(
      INSPECT_RESULT,
    )
    await expect(client.request('run.inspect', { sessionId: 's1', runId: 'r1' })).resolves.toEqual(
      INSPECT_RESULT,
    )
    expect(inspect.inspect).toHaveBeenNthCalledWith(1, { sessionId: 's1' })
    expect(inspect.inspect).toHaveBeenNthCalledWith(2, { sessionId: 's1', runId: 'r1' })
  })

  it('delegates settings requests to the settings service', async () => {
    const { client } = setup()
    await expect(client.request('settings.get', {})).resolves.toEqual({
      locale: 'zh-CN',
      providers: [],
    })
    await expect(client.request('settings.update', { locale: 'en-US' })).resolves.toEqual({
      locale: 'en-US',
      providers: [],
    })
    expect(settings.update).toHaveBeenCalledWith({ locale: 'en-US' })
    await expect(client.request('settings.shell', {})).resolves.toEqual({
      detected: 'bash',
      options: ['auto'],
    })
  })

  it('delegates sandbox.status to the sandbox service (M5-05)', async () => {
    const { client } = setup()
    const status = await client.request('sandbox.status', {})
    expect(status).toEqual({
      platform: 'win32',
      mechanism: 'restricted-token',
      policy: { profile: 'workspace-write', network: 'none' },
      unavailable: 'deny',
      capability: {
        available: true,
        supported: true,
        mechanism: 'restricted-token',
        networkIsolated: false,
        checks: { restrictedToken: true, lowIntegrity: true, jobObject: true, appContainer: false },
      },
    })
    expect(sandbox.status).toHaveBeenCalledWith({})
  })

  it('delegates update commands and pushes status changes (M5-06)', async () => {
    const { client } = setup()
    const pushed: UpdateStatus[] = []
    client.on('update.status', (status) => pushed.push(status))

    const status = await client.request('update.status', {})
    expect(status.phase).toBe('idle')
    await expect(client.request('update.check', { force: true })).resolves.toMatchObject({
      phase: 'idle',
    })
    await expect(client.request('update.download', {})).resolves.toMatchObject({ phase: 'idle' })
    await expect(client.request('update.install', {})).resolves.toMatchObject({ phase: 'idle' })
    await expect(client.request('update.cancel', {})).resolves.toMatchObject({ phase: 'idle' })
    expect(update.check).toHaveBeenCalledWith({ force: true })

    const changed = { ...status, phase: 'available' as const, availableVersion: '0.1.1' }
    for (const listener of updateListeners) listener(changed)
    await vi.advanceTimersByTimeAsync(0)
    expect(pushed).toEqual([changed])
  })

  it('delegates provider requests to the provider service (M2-10)', async () => {
    const { client } = setup()
    const provider = {
      id: 'p',
      kind: 'openai' as const,
      displayName: 'P',
      baseUrl: 'https://example.com/v1',
      models: [],
    }
    await expect(client.request('provider.test', { provider, modelId: 'm' })).resolves.toEqual({
      ok: true,
      latencyMs: 12,
    })
    await expect(client.request('provider.models', { provider })).resolves.toEqual({
      ok: true,
      models: [{ id: 'm1' }],
    })
    expect(providers.test).toHaveBeenCalledWith({ provider, modelId: 'm' })
  })

  it('delegates permission rule requests to the permission service (M2-11)', async () => {
    const { client } = setup()
    const rule = {
      id: 'r1',
      scope: 'project' as const,
      effect: 'allow' as const,
      match: { tool: 'run_command', command: ['npm test'] },
      source: 'user' as const,
    }
    await expect(client.request('permissions.list', {})).resolves.toEqual({ rules: [] })
    await expect(client.request('permissions.add', { rule, projectId: 'p1' })).resolves.toEqual({
      rule,
      projectId: 'p1',
      createdAt: 1,
    })
    await expect(client.request('permissions.delete', { ruleId: 'r1' })).resolves.toEqual({})
    expect(permissions.delete).toHaveBeenCalledWith({ ruleId: 'r1' })
  })

  it('rejects invalid requests before they reach the session manager', async () => {
    setup()
    const pair = channelPair()
    gateway.connect(pair.main)
    const raw: unknown[] = []
    pair.renderer.onMessage((m) => raw.push(m))
    pair.renderer.post({ kind: 'hello', protocolVersion: 1, ack: false })
    pair.renderer.post({ kind: 'request', id: 'x', method: 'session.create', params: {} })
    pair.renderer.post({ kind: 'request', id: 'y', method: 'fs.read', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(raw).toContainEqual(
      expect.objectContaining({
        id: 'x',
        ok: false,
        error: expect.objectContaining({ code: 'rpc.invalid_params' }),
      }),
    )
    expect(raw).toContainEqual(
      expect.objectContaining({
        id: 'y',
        ok: false,
        error: expect.objectContaining({ code: 'rpc.method_not_found' }),
      }),
    )
    expect(commands.create).not.toHaveBeenCalled()
  })

  it('closing a connection drops its subscriptions and pending frames', async () => {
    const { client, pushed, connection } = setup()
    const other = connectRenderer()
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await other.client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)

    service.publish([delta('s1', 'a', 'x')])
    connection.close()
    connection.close()
    await vi.advanceTimersByTimeAsync(100)
    expect(pushed).toEqual([])
    expect(other.pushed.map(seqs)).toEqual([[1]])
    expect(connection.subscriptions()).toEqual([])
    await expect(connection.ready).resolves.toBeUndefined()
  })

  it('closing the gateway stops all connections', async () => {
    const { client, pushed } = setup()
    await client.request('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    await vi.advanceTimersByTimeAsync(0)
    gateway.close()
    service.publish([user('s1', 'u1')])
    await vi.advanceTimersByTimeAsync(100)
    expect(pushed).toEqual([])
  })

  it('passes protocol errors to the handler', async () => {
    setup()
    const onProtocolError = vi.fn()
    const g = createRendererGateway({
      appInfo: { info: () => APP_INFO },
      events: service,
      commands,
      projects,
      files: {
        list: async () => ({ entries: [], truncated: false }),
        create: async () => ({ path: '' }),
        rename: async () => ({ path: '' }),
        delete: async () => ({}),
        reveal: async () => ({}),
      },
      settings,
      credentials,
      providers,
      permissions,
      changes,
      checkpoints,
      hub: {
        skills: vi.fn(async () => ({ items: [] })),
        mcp: vi.fn(async () => ({ items: [] })),
      },
      changeSets,
      approvals,
      skills,
      mcp: {} as unknown as McpCommands,
      agents,
      trials,
      diagnostics,
      sandbox,
      update,
      inspect: {} as unknown as InspectCommands,
      activity: { subscribe: () => () => undefined } as unknown as ActivityCommands,
      backgroundCommands,
      mcpStatus: () => () => undefined,
      onProtocolError,
    })
    const pair = channelPair()
    g.connect(pair.main)
    pair.renderer.post({ nonsense: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(onProtocolError).toHaveBeenCalled()
    g.close()
  })
})
