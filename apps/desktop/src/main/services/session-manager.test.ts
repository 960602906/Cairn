import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope, UnsequencedEvent } from '@nexus/protocol'
import { createMemoryStorage, type Storage } from '@nexus/storage'
import { createSessionEventService, type SessionEventService } from './event-service.js'
import type {
  HostExit,
  HostHandle,
  HostInit,
  HostState,
  HostSupervisor,
} from './host-supervisor.js'
import {
  createSessionManager,
  type RunDefaults,
  type SessionManagerOptions,
} from './session-manager.js'

const defaults: RunDefaults = {
  agent: { id: 'default', version: 1 },
  model: { providerId: 'fake', modelId: 'fake-1' },
  mode: 'interactive',
  limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
}

interface FakeHost extends HostHandle {
  readonly init: HostInit
  readonly prompts: string[]
  crash(): void
}

function fakeHandle(init: HostInit, stopsCleanly = true): FakeHost {
  let state: HostState = 'running'
  let resolveExited!: (exit: HostExit) => void
  const exited = new Promise<HostExit>((resolve) => (resolveExited = resolve))
  const prompts: string[] = []
  const end = (exit: HostExit) => {
    if (state === 'stopped' || state === 'crashed') return
    state = exit.reason
    resolveExited(exit)
  }
  return {
    init,
    prompts,
    sessionId: init.sessionId,
    runId: init.runId,
    pid: 1,
    state: () => state,
    prompt: vi.fn(async ({ messageId }) => {
      prompts.push(messageId)
    }),
    abort: vi.fn(async () => undefined),
    stop: vi.fn(() => {
      if (state === 'running') state = 'stopping'
      if (stopsCleanly) queueMicrotask(() => end({ reason: 'stopped' }))
      return exited
    }),
    exited,
    crash: () => end({ reason: 'crashed', error: { code: 'host.exited' } }),
  }
}

/** 假监督器：`autoStart` 为 false 时由测试调用 `release` 完成启动。 */
function fakeSupervisor(autoStart = true) {
  const hosts: FakeHost[] = []
  const pending: { init: HostInit; resolve: () => void; reject: (e: unknown) => void }[] = []
  const supervisor: HostSupervisor = {
    startHost: vi.fn((init: HostInit) => {
      const create = () => {
        const host = fakeHandle(init)
        hosts.push(host)
        return host
      }
      if (autoStart) return Promise.resolve(create())
      return new Promise<HostHandle>((resolve, reject) => {
        pending.push({ init, resolve: () => resolve(create()), reject })
      })
    }),
  }
  return { supervisor, hosts, pending }
}

let storage: Storage
let service: SessionEventService
let published: EventEnvelope[]
let clock: number

function setup(supervisor: HostSupervisor, extra: Partial<SessionManagerOptions> = {}) {
  clock = 1_000
  storage = createMemoryStorage({ now: () => clock })
  service = createSessionEventService({ storage })
  published = []
  service.subscribe((_id, events) => published.push(...events))
  let id = 0
  const onError = vi.fn()
  const manager = createSessionManager({
    storage,
    events: service,
    supervisor,
    runDefaults: defaults,
    createId: () => `id${++id}`,
    now: () => clock,
    onError,
    ...extra,
  })
  return { manager, onError }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

/** 模拟宿主发出的事件。 */
function hostEmits(sessionId: string, runId: string, ...events: [string, object, object?][]) {
  service.publish(
    events.map(
      ([type, payload, header]) =>
        ({ v: 1, sessionId, runId, ts: clock, type, payload, ...header }) as UnsequencedEvent,
    ),
  )
}

/** 宿主开始一轮：创建运行（首次）并进入 thinking。 */
function startTurn(sessionId: string, runId: string, turnId: string, created = true) {
  hostEmits(
    sessionId,
    runId,
    ...(created ? [['run.created', defaults] as [string, object]] : []),
    ['turn.started', {}, { turnId }],
    ['run.state.changed', { from: created ? 'idle' : 'completed', to: 'thinking' }],
  )
}

function finishTurn(sessionId: string, runId: string, turnId: string) {
  hostEmits(
    sessionId,
    runId,
    ['run.state.changed', { from: 'thinking', to: 'completed' }],
    ['turn.completed', { durationMs: 5 }, { turnId }],
  )
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const types = () => published.map((e) => e.type)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('create and list', () => {
  it('creates sessions under one project per path', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const a = manager.create({ projectPath: '/work/demo', title: 'A' })
    const b = manager.create({ projectPath: '/work/demo' })
    expect(storage.projects.list()).toHaveLength(1)
    expect(storage.projects.list()[0]).toMatchObject({ name: 'demo', path: '/work/demo' })
    expect(published.filter((e) => e.type === 'session.created').map((e) => e.sessionId)).toEqual([
      a.sessionId,
      b.sessionId,
    ])
    expect(published[0]).toMatchObject({
      runId: a.sessionId,
      payload: { projectPath: '/work/demo', workspacePath: '/work/demo', title: 'A' },
    })

    const { sessions } = manager.list({})
    expect(sessions.map((s) => [s.title, s.status, s.projectPath])).toEqual([
      ['A', 'idle', '/work/demo'],
      ['', 'idle', '/work/demo'],
    ])
    storage.sessions.archive(a.sessionId)
    expect(manager.list({}).sessions).toHaveLength(1)
    expect(manager.list({ includeArchived: true }).sessions).toHaveLength(2)
  })

  it('records the selected or default model and uses it for new runs', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const chat = { providerId: 'deepseek', modelId: 'deepseek-chat' }
    const reasoner = { providerId: 'deepseek', modelId: 'deepseek-reasoner' }
    const configured = [chat, reasoner]
    let defaultModel: typeof chat | undefined = chat
    const { manager } = setup(supervisor, {
      models: {
        defaultModel: () => defaultModel,
        has: (m) => configured.some((c) => c.modelId === m.modelId),
      },
    })
    const a = manager.create({ projectPath: '/work/a' })
    const b = manager.create({ projectPath: '/work/b', model: reasoner })
    defaultModel = undefined
    const c = manager.create({ projectPath: '/work/c' })

    expect(storage.sessions.get(a.sessionId)?.model).toEqual(chat)
    expect(storage.sessions.get(b.sessionId)?.model).toEqual(reasoner)
    expect(storage.sessions.get(c.sessionId)).not.toHaveProperty('model')
    expect(published.find((e) => e.sessionId === b.sessionId)?.payload).toMatchObject({
      model: reasoner,
    })
    const listed = manager.list({}).sessions
    expect(listed.find((s) => s.sessionId === a.sessionId)?.model).toEqual(chat)
    expect(listed.find((s) => s.sessionId === c.sessionId)).not.toHaveProperty('model')

    manager.prompt({ sessionId: b.sessionId, content: text('hi') })
    manager.prompt({ sessionId: c.sessionId, content: text('hi') })
    await flush()
    expect(hosts.find((h) => h.sessionId === b.sessionId)?.init.model).toEqual(reasoner)
    expect(hosts.find((h) => h.sessionId === c.sessionId)?.init.model).toEqual(defaults.model)

    expect(() =>
      manager.create({
        projectPath: '/work/d',
        model: { providerId: 'deepseek', modelId: 'missing' },
      }),
    ).toThrow(expect.objectContaining({ code: 'session.unknown_model' }))
  })

  it('rejects relative project paths', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    expect(() => manager.create({ projectPath: 'demo' })).toThrow(
      expect.objectContaining({ code: 'rpc.invalid_params' }),
    )
  })
})

describe('prompt', () => {
  it('persists the user message, starts a host and forwards the prompt', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor)
    const { sessionId } = manager.create({ projectPath: '/work' })

    const { messageId } = manager.prompt({ sessionId, content: text('hi') })
    const user = published.find((e) => e.type === 'message.user')
    expect(user).toMatchObject({ runId: 'id3', payload: { messageId, content: text('hi') } })
    await flush()
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.init).toMatchObject({
      sessionId,
      runId: 'id3',
      workspacePath: '/work',
      ...defaults,
      history: [],
    })
    expect(hosts[0]?.init.resume).toBeUndefined()
    expect(hosts[0]?.prompts).toEqual([messageId])
    expect(manager.activeSessions()).toEqual([sessionId])

    // 一轮进行中不接受新输入
    expect(() => manager.prompt({ sessionId, content: text('again') })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    startTurn(sessionId, 'id3', 't1')
    expect(() => manager.prompt({ sessionId, content: text('again') })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    expect(manager.list({}).sessions[0]?.status).toBe('running')
    finishTurn(sessionId, 'id3', 't1')

    // 同一个宿主、同一个运行继续
    const second = manager.prompt({ sessionId, content: text('next') })
    await flush()
    expect(supervisor.startHost).toHaveBeenCalledTimes(1)
    expect(hosts[0]?.prompts).toEqual([messageId, second.messageId])
    expect(published.filter((e) => e.type === 'message.user').map((e) => e.runId)).toEqual([
      'id3',
      'id3',
    ])
  })

  it('restarts a stopped host with the conversation history and the run configuration', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 1_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    const custom = { ...defaults, model: { providerId: 'other', modelId: 'm' } }
    hostEmits(
      sessionId,
      'id3',
      ['run.created', custom],
      ['turn.started', {}, { turnId: 't1' }],
      ['run.state.changed', { from: 'idle', to: 'thinking' }],
    )
    finishTurn(sessionId, 'id3', 't1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hosts[0]?.state()).toBe('stopped')
    expect(manager.activeSessions()).toEqual([])

    manager.prompt({ sessionId, content: text('back') })
    await flush()
    expect(hosts[1]?.init).toMatchObject({
      runId: 'id3',
      model: custom.model,
      history: [{ role: 'user', content: text('hi') }],
      resume: { state: 'completed' },
    })
  })

  it('rejects unknown sessions and prompts while queued or starting', async () => {
    const { supervisor, pending } = fakeSupervisor(false)
    const { manager } = setup(supervisor, { maxConcurrent: 1 })
    expect(() => manager.prompt({ sessionId: 'nope', content: text('x') })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
    const a = manager.create({ projectPath: '/a' })
    const b = manager.create({ projectPath: '/b' })
    manager.prompt({ sessionId: a.sessionId, content: text('x') })
    manager.prompt({ sessionId: b.sessionId, content: text('y') })
    expect(pending).toHaveLength(1)
    for (const { sessionId } of [a, b]) {
      expect(() => manager.prompt({ sessionId, content: text('z') })).toThrow(
        expect.objectContaining({ code: 'run.busy' }),
      )
    }
    expect(manager.list({}).sessions.map((s) => s.status)).toEqual(['running', 'running'])
  })

  it('stops waiting for a turn when the host rejects the prompt', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager, onError } = setup(supervisor, { idleTimeoutMs: 1_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    startTurn(sessionId, 'id3', 't1')
    finishTurn(sessionId, 'id3', 't1')
    vi.mocked(hosts[0]!.prompt).mockRejectedValueOnce(new Error('busy'))
    manager.prompt({ sessionId, content: text('again') })
    await flush()
    expect(onError).toHaveBeenCalledWith(new Error('busy'))
    // 回到空闲，可以继续输入，也会被回收
    manager.prompt({ sessionId, content: text('third') })
    await flush()
    expect(hosts[0]?.prompts).toHaveLength(2)
  })
})

describe('scheduling', () => {
  it('queues sessions beyond the concurrency limit and starts them as hosts exit', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { maxConcurrent: 2 })
    const ids = ['/a', '/b', '/c'].map((p) => manager.create({ projectPath: p }).sessionId)
    for (const sessionId of ids) manager.prompt({ sessionId, content: text('go') })
    await flush()
    expect(manager.activeSessions()).toEqual(ids.slice(0, 2))
    expect(manager.queuedSessions()).toEqual([ids[2]])
    // 都在运行一轮，没有可回收的宿主
    for (const [i, sessionId] of ids.slice(0, 2).entries()) {
      startTurn(sessionId!, hosts[i]!.runId, `t${i}`)
    }
    expect(hosts.every((h) => h.state() === 'running')).toBe(true)

    hosts[0]?.crash()
    await flush()
    expect(manager.activeSessions()).toEqual([ids[1], ids[2]])
    expect(manager.queuedSessions()).toEqual([])
    expect(hosts[2]?.prompts).toHaveLength(1)
  })

  it('reclaims an idle host when sessions are waiting', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { maxConcurrent: 1 })
    const a = manager.create({ projectPath: '/a' }).sessionId
    const b = manager.create({ projectPath: '/b' }).sessionId
    manager.prompt({ sessionId: a, content: text('go') })
    await flush()
    startTurn(a, hosts[0]!.runId, 't1')
    manager.prompt({ sessionId: b, content: text('go') })
    await flush()
    expect(manager.queuedSessions()).toEqual([b])

    finishTurn(a, hosts[0]!.runId, 't1')
    await flush()
    expect(hosts[0]?.stop).toHaveBeenCalledTimes(1)
    expect(manager.activeSessions()).toEqual([b])
  })

  it('reclaims hosts that stay idle', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 10_000 })
    const { sessionId } = manager.create({ projectPath: '/a' })
    manager.prompt({ sessionId, content: text('go') })
    await flush()
    startTurn(sessionId, hosts[0]!.runId, 't1')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(hosts[0]?.stop).not.toHaveBeenCalled()

    finishTurn(sessionId, hosts[0]!.runId, 't1')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(hosts[0]?.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(hosts[0]?.stop).toHaveBeenCalledTimes(1)
    expect(manager.activeSessions()).toEqual([])
  })

  it('waits for a stopping host before starting the same session again', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 1_000 })
    const { sessionId } = manager.create({ projectPath: '/a' })
    manager.prompt({ sessionId, content: text('go') })
    await flush()
    startTurn(sessionId, hosts[0]!.runId, 't1')
    finishTurn(sessionId, hosts[0]!.runId, 't1')
    // 停止尚未完成时再次输入
    vi.mocked(hosts[0]!.stop).mockImplementationOnce(() => hosts[0]!.exited)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hosts[0]?.state()).toBe('running')
    const stopping = hosts[0]!
    ;(stopping as { state: () => HostState }).state = () => 'stopping'
    manager.prompt({ sessionId, content: text('again') })
    await flush()
    expect(hosts).toHaveLength(1)
    expect(manager.queuedSessions()).toEqual([sessionId])

    stopping.crash()
    await flush()
    expect(hosts).toHaveLength(2)
    expect(manager.queuedSessions()).toEqual([])
  })

  it('releases the slot when a host fails to start', async () => {
    const { supervisor, pending } = fakeSupervisor(false)
    const { manager, onError } = setup(supervisor, { maxConcurrent: 1 })
    const a = manager.create({ projectPath: '/a' }).sessionId
    const b = manager.create({ projectPath: '/b' }).sessionId
    manager.prompt({ sessionId: a, content: text('go') })
    manager.prompt({ sessionId: b, content: text('go') })
    pending[0]?.reject(new Error('start failed'))
    await flush()
    expect(onError).toHaveBeenCalledWith(new Error('start failed'))
    expect(manager.activeSessions()).toEqual([b])
    expect(pending[1]?.init.sessionId).toBe(b)
  })
})

describe('abort', () => {
  it('drops a queued prompt, cancels a starting one and forwards to a running host', async () => {
    const { supervisor, pending, hosts } = fakeSupervisor(false)
    const { manager } = setup(supervisor, { maxConcurrent: 1 })
    const a = manager.create({ projectPath: '/a' }).sessionId
    const b = manager.create({ projectPath: '/b' }).sessionId
    await expect(manager.abort({ sessionId: a })).resolves.toEqual({})

    manager.prompt({ sessionId: a, content: text('go') })
    manager.prompt({ sessionId: b, content: text('go') })
    await manager.abort({ sessionId: b })
    expect(manager.queuedSessions()).toEqual([])

    await manager.abort({ sessionId: a })
    pending[0]?.resolve()
    await flush()
    expect(hosts[0]?.prompts).toEqual([])

    await manager.abort({ sessionId: a })
    expect(hosts[0]?.abort).toHaveBeenCalledWith('user')
    await expect(manager.abort({ sessionId: 'nope' })).rejects.toMatchObject({
      code: 'storage.not_found',
    })
  })
})

describe('interruption', () => {
  it('marks runs left running by a crashed host as interrupted before the next prompt', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor)
    const { sessionId } = manager.create({ projectPath: '/a' })
    manager.prompt({ sessionId, content: text('go') })
    await flush()
    startTurn(sessionId, 'id3', 't1')
    hosts[0]?.crash()
    await flush()

    published = []
    manager.prompt({ sessionId, content: text('retry') })
    expect(published.map((e) => [e.type, e.runId, e.payload])).toEqual([
      ['turn.aborted', 'id3', { reason: 'shutdown' }],
      ['run.state.changed', 'id3', { from: 'thinking', to: 'interrupted', reason: 'host_lost' }],
      ['message.user', 'id3', expect.anything()],
    ])
    await flush()
    expect(hosts[1]?.init.runId).toBe('id3')
  })

  it('marks unfinished runs as interrupted at startup', () => {
    const { manager, onError } = setup(fakeSupervisor().supervisor)
    const a = manager.create({ projectPath: '/a' }).sessionId
    const b = manager.create({ projectPath: '/b' }).sessionId
    startTurn(a, 'r1', 't1')
    hostEmits(a, 'r1', ['run.state.changed', { from: 'thinking', to: 'aborting' }])
    hostEmits(
      a,
      'child',
      ['run.created', defaults, { parentRunId: 'r1' }],
      ['run.state.changed', { from: 'idle', to: 'thinking' }, { parentRunId: 'r1' }],
    )
    startTurn(b, 'r2', 't2')
    finishTurn(b, 'r2', 't2')
    storage.sessions.archive(a)

    published = []
    // 新的管理器（模拟重启）从数据库读取状态
    const restarted = createSessionManager({
      storage,
      events: service,
      supervisor: fakeSupervisor().supervisor,
      runDefaults: defaults,
      onError,
    })
    expect(restarted.recoverInterrupted()).toBe(2)
    expect(published.map((e) => [e.type, e.runId, e.parentRunId])).toEqual([
      ['turn.aborted', 'r1', undefined],
      ['run.state.changed', 'r1', undefined],
      ['run.state.changed', 'child', 'r1'],
    ])
    expect(restarted.recoverInterrupted()).toBe(0)
    void restarted.shutdown()
  })

  it('reports sessions it cannot mark', () => {
    const { manager, onError } = setup(fakeSupervisor().supervisor)
    const a = manager.create({ projectPath: '/a' }).sessionId
    startTurn(a, 'r1', 't1')
    vi.spyOn(service, 'publish').mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(manager.recoverInterrupted()).toBe(0)
    expect(onError).toHaveBeenCalledWith(new Error('db closed'))
  })
})

describe('shutdown', () => {
  it('stops every host, clears the queue and rejects new work', async () => {
    const { supervisor, pending, hosts } = fakeSupervisor(false)
    const { manager } = setup(supervisor, { maxConcurrent: 2 })
    const ids = ['/a', '/b', '/c'].map((p) => manager.create({ projectPath: p }).sessionId)
    for (const sessionId of ids) manager.prompt({ sessionId, content: text('go') })
    pending[0]?.resolve()
    await flush()

    const done = manager.shutdown()
    expect(manager.queuedSessions()).toEqual([])
    expect(hosts[0]?.stop).toHaveBeenCalled()
    // 启动中的宿主在启动完成后停止
    pending[1]?.resolve()
    await flush()
    expect(hosts[1]?.stop).toHaveBeenCalled()
    await done
    expect(manager.activeSessions()).toEqual([])
    expect(supervisor.startHost).toHaveBeenCalledTimes(2)

    expect(() => manager.prompt({ sessionId: ids[0]!, content: text('x') })).toThrow(
      expect.objectContaining({ code: 'run.disposed' }),
    )
    expect(() => manager.create({ projectPath: '/d' })).toThrow(
      expect.objectContaining({ code: 'run.disposed' }),
    )
    expect(types()).not.toContain('session.crashed')
  })
})
