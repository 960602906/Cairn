import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import {
  createEndpoint,
  MainForRenderer,
  RendererForMain,
  type EventEnvelope,
  type RpcChannel,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import type { CredentialCommands } from './credential-store.js'
import { createSessionEventService, type SessionEventService } from './event-service.js'
import type { ProjectCommands } from './project-service.js'
import {
  coalesceDeltas,
  createRendererGateway,
  type ApprovalCommands,
  type ChangeCommands,
  type CheckpointCommands,
  type RendererGateway,
  type SessionCommands,
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

let service: SessionEventService
let gateway: RendererGateway
let commands: SessionCommands
let projects: ProjectCommands
let settings: SettingsCommands
let credentials: CredentialCommands
let changes: ChangeCommands
let checkpoints: CheckpointCommands
let approvals: ApprovalCommands
const approvalListeners = new Set<(sessionId: string) => void>()

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
  }
  projects = {
    list: vi.fn(() => ({ projects: [PROJECT] })),
    open: vi.fn(async () => ({ project: PROJECT })),
  }
  settings = {
    get: vi.fn(() => ({ locale: 'zh-CN' as const, providers: [] })),
    update: vi.fn((patch) => ({ locale: patch.locale ?? ('zh-CN' as const), providers: [] })),
  }
  credentials = {
    set: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({ deleted: true })),
    status: vi.fn(async () => ({ configured: true, available: true })),
  }
  changes = {
    list: vi.fn(() => ({ changes: [] })),
    revert: vi.fn(async () => ({ changes: [] })),
  }
  checkpoints = {
    list: vi.fn(() => ({ checkpoints: [] })),
    preview: vi.fn(async () => ({ before: CP_BEFORE, files: [] })),
    restore: vi.fn(async () => ({
      before: CP_BEFORE,
      files: [{ path: 'a.txt', status: 'modified' as const }],
    })),
  }
  approvalListeners.clear()
  approvals = {
    pending: vi.fn(() => ({ approvals: [] })),
    resolve: vi.fn(() => ({})),
    subscribe: vi.fn((listener: (sessionId: string) => void) => {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    }),
  }
  gateway = createRendererGateway({
    events: { ...service, ...eventsOverride },
    commands,
    projects,
    settings,
    credentials,
    changes,
    checkpoints,
    approvals,
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
    ])
    expect(seqs(merged)).toEqual([1, 2, 3, 5, 6, 7])
    // 非增量事件从不合并
    expect(seqs(coalesceDeltas([at(user('s1', 'a'), 1), at(user('s1', 'b'), 2)]))).toEqual([1, 2])
    expect((merged[3]!.payload as { text: string }).text).toBe('ab')
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
      client.request('changes.revert', { sessionId: 's1', changeIds: [] }),
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

  it('delegates project requests to the project service', async () => {
    const { client } = setup()
    await expect(client.request('project.list', {})).resolves.toEqual({ projects: [PROJECT] })
    await expect(client.request('project.open', {})).resolves.toEqual({ project: PROJECT })
    expect(projects.open).toHaveBeenCalledOnce()
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
      events: service,
      commands,
      projects,
      settings,
      credentials,
      changes,
      checkpoints,
      approvals,
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
