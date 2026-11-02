import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  PROTOCOL_VERSION,
  type EventEnvelope,
  type RpcChannel,
  type UnsequencedEvent,
} from '@nexus/protocol'
import { createMemoryStorage } from '@nexus/storage'
import { createSessionEventService, type SessionEventService } from './event-service.js'
import type { HostProcess } from './host-process.js'
import {
  createHostSupervisor,
  type HostInit,
  type HostSupervisorOptions,
} from './host-supervisor.js'

function channelPair(): [RpcChannel, RpcChannel] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()]
  const make = (self: 0 | 1): RpcChannel => ({
    post(message) {
      const copy = structuredClone(message)
      queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((l) => l(copy)))
    },
    onMessage(listener) {
      listeners[self].add(listener)
      return () => listeners[self].delete(listener)
    },
  })
  return [make(0), make(1)]
}

interface FakeHostBehavior {
  /** 不回应握手（模拟启动卡住）。 */
  silent?: boolean
  initFails?: boolean
  /** 心跳不回应（模拟卡死）。 */
  hangHeartbeat?: () => boolean
  /** 收到 host.shutdown 后不退出。 */
  ignoreShutdown?: boolean
}

/** 内存中的假宿主：真实的协议端点 + 可控的进程退出。 */
function fakeHost(behavior: FakeHostBehavior = {}) {
  const [mainSide, hostSide] = channelPair()
  const exitListeners: ((code: number) => void)[] = []
  let alive = true
  const exit = (code: number) => {
    if (!alive) return
    alive = false
    exitListeners.forEach((l) => l(code))
  }
  const proc: HostProcess = {
    channel: mainSide,
    pid: 4242,
    kill: vi.fn(() => exit(-1)),
    onExit: (l) => exitListeners.push(l),
  }
  const calls: string[] = []
  const host = behavior.silent
    ? undefined
    : createEndpoint(hostSide, { local: HostForMain, remote: MainForHost })
  host?.handle('host.init', () => {
    calls.push('init')
    if (behavior.initFails) throw new Error('bad init')
    return {}
  })
  host?.handle('host.prompt', ({ messageId }) => {
    calls.push(`prompt:${messageId}`)
    return {}
  })
  host?.handle('host.abort', ({ reason }) => {
    calls.push(`abort:${reason}`)
    return {}
  })
  host?.handle('host.heartbeat', () => {
    calls.push('heartbeat')
    return behavior.hangHeartbeat?.() ? new Promise<never>(() => {}) : { ts: 1 }
  })
  host?.handle('host.shutdown', () => {
    calls.push('shutdown')
    if (!behavior.ignoreShutdown) queueMicrotask(() => exit(0))
    return {}
  })
  const emit = (event: UnsequencedEvent) => host?.emit('host.event', { event })
  return { proc, calls, exit, emit, isAlive: () => alive }
}

const init: HostInit = {
  sessionId: 's1',
  runId: 'r1',
  workspacePath: '/work',
  agent: { id: 'default', version: 1 },
  model: { providerId: 'fake', modelId: 'fake-1' },
  mode: 'interactive',
  limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
  history: [],
}

let service: SessionEventService
let published: EventEnvelope[]

function setup(host: ReturnType<typeof fakeHost>, extra: Partial<HostSupervisorOptions> = {}) {
  const storage = createMemoryStorage({ now: () => 1 })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: '/work', title: '' })
  service = createSessionEventService({ storage })
  published = []
  service.subscribe((_id, events) => published.push(...events))
  const onError = vi.fn()
  const supervisor = createHostSupervisor({
    spawn: () => host.proc,
    events: service,
    now: () => 99,
    onError,
    ...extra,
  })
  return { supervisor, onError, storage }
}

const crashes = () =>
  published.filter((e) => e.type === 'session.crashed').map((e) => e.payload as unknown)

const userEvent = (sessionId: string): UnsequencedEvent => ({
  v: 1,
  sessionId,
  runId: 'r1',
  ts: 5,
  type: 'message.user',
  payload: { messageId: 'm1', content: [{ type: 'text', text: 'hi' }] },
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('startHost', () => {
  it('handshakes, initializes and forwards host events to the event service', async () => {
    const host = fakeHost()
    const { supervisor, onError } = setup(host)
    const handle = await supervisor.startHost(init)
    expect(handle.state()).toBe('running')
    expect(handle.pid).toBe(4242)
    expect(host.calls).toEqual(['init'])

    host.emit(userEvent('s1'))
    host.emit(userEvent('other'))
    await vi.advanceTimersByTimeAsync(0)
    expect(published.map((e) => [e.type, e.seq])).toEqual([['message.user', 1]])
    expect(onError).toHaveBeenCalledTimes(1)

    await handle.prompt({ messageId: 'm1', content: [{ type: 'text', text: 'hi' }] })
    await handle.abort('user')
    expect(host.calls).toEqual(['init', 'prompt:m1', 'abort:user'])
  })

  it('records host.start_failed when the process cannot be created', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host, {
      spawn: () => {
        throw new Error('ENOENT')
      },
    })
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([{ error: { code: 'host.start_failed' } }])
  })

  it('records host.start_failed when the handshake times out and kills the process', async () => {
    const host = fakeHost({ silent: true })
    const { supervisor } = setup(host, { startTimeoutMs: 1_000 })
    const starting = supervisor.startHost(init)
    const assertion = expect(starting).rejects.toMatchObject({ code: 'host.start_failed' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(host.proc.kill).toHaveBeenCalled()
    expect(crashes()).toEqual([
      { error: { code: 'host.start_failed', params: { cause: 'rpc.timeout' } } },
    ])
  })

  it('records host.start_failed when host.init fails', async () => {
    const host = fakeHost({ initFails: true })
    const { supervisor } = setup(host)
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([
      { error: { code: 'host.start_failed', params: { cause: 'rpc.internal' } } },
    ])
    expect(host.isAlive()).toBe(false)
  })

  it('records the exit code when the process dies during startup', async () => {
    const host = fakeHost({ silent: true })
    const { supervisor } = setup(host)
    const starting = supervisor.startHost(init)
    host.exit(3)
    await expect(starting).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([{ error: { code: 'host.start_failed', params: { exitCode: 3 } } }])
  })

  it('reports a failure to record the crash', async () => {
    const host = fakeHost()
    const { supervisor, onError } = setup(host, {
      spawn: () => {
        throw new Error('ENOENT')
      },
      events: {
        publish: () => {
          throw new Error('db closed')
        },
      },
    })
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['ENOENT', 'db closed'])
  })
})

describe('crash detection', () => {
  it('records host.exited when the process exits unexpectedly', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    const handle = await supervisor.startHost(init)
    host.exit(139)
    await expect(handle.exited).resolves.toEqual({
      reason: 'crashed',
      error: { code: 'host.exited', params: { exitCode: 139 } },
    })
    expect(handle.state()).toBe('crashed')
    expect(crashes()).toEqual([{ error: { code: 'host.exited', params: { exitCode: 139 } } }])
    // 崩溃后不再转发宿主事件
    host.emit(userEvent('s1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(published.filter((e) => e.type === 'message.user')).toEqual([])
  })

  it('sends heartbeats and kills a host that stops answering', async () => {
    let hang = false
    const host = fakeHost({ hangHeartbeat: () => hang })
    const { supervisor } = setup(host, { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 500 })
    const handle = await supervisor.startHost(init)

    await vi.advanceTimersByTimeAsync(2_100)
    expect(host.calls.filter((c) => c === 'heartbeat')).toHaveLength(2)
    expect(handle.state()).toBe('running')

    hang = true
    await vi.advanceTimersByTimeAsync(1_600)
    expect(handle.state()).toBe('crashed')
    expect(host.proc.kill).toHaveBeenCalled()
    expect(crashes()).toEqual([{ error: { code: 'host.unresponsive' } }])
    // 只记录一次
    host.exit(-1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(crashes()).toHaveLength(1)
  })
})

describe('stop', () => {
  it('asks the host to shut down without recording a crash', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    const handle = await supervisor.startHost(init)
    const stopped = handle.stop()
    expect(handle.stop()).toBe(stopped)
    await vi.advanceTimersByTimeAsync(0)
    await expect(stopped).resolves.toEqual({ reason: 'stopped' })
    expect(host.calls).toContain('shutdown')
    expect(handle.state()).toBe('stopped')
    expect(crashes()).toEqual([])
    // 已停止后再调用 stop 直接返回结果
    await expect(handle.stop()).resolves.toEqual({ reason: 'stopped' })
  })

  it('kills a host that does not exit in time', async () => {
    const host = fakeHost({ ignoreShutdown: true })
    const { supervisor } = setup(host, { shutdownTimeoutMs: 300 })
    const handle = await supervisor.startHost(init)
    const stopped = handle.stop()
    await vi.advanceTimersByTimeAsync(300)
    await expect(stopped).resolves.toEqual({ reason: 'stopped' })
    expect(host.proc.kill).toHaveBeenCalled()
    expect(crashes()).toEqual([])
  })

  it('returns the crash result when stopping a crashed host', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    const handle = await supervisor.startHost(init)
    host.exit(1)
    await expect(handle.stop()).resolves.toMatchObject({ reason: 'crashed' })
  })

  it('rejects requests after the host is gone', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    const handle = await supervisor.startHost(init)
    host.exit(1)
    await expect(handle.abort('user')).rejects.toMatchObject({ code: 'rpc.closed' })
  })
})

describe('protocol', () => {
  it('uses the shared protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
  })
})
