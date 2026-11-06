import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RpcError,
  createEndpoint,
  HostForMain,
  MainForHost,
  PROTOCOL_VERSION,
  type EventEnvelope,
  type RpcChannel,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
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
  const inits: unknown[] = []
  const host = behavior.silent
    ? undefined
    : createEndpoint(hostSide, { local: HostForMain, remote: MainForHost })
  host?.handle('host.init', (params) => {
    calls.push('init')
    inits.push(params)
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
  return { proc, calls, inits, exit, emit, endpoint: host, isAlive: () => alive }
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

describe('changes.record（M1-08b）', () => {
  const change = {
    path: 'a.txt',
    kind: 'create' as const,
    after: '',
    hunks: [],
    added: 0,
    removed: 0,
  }

  it('交给改动服务，会话与运行由宿主确定', async () => {
    const host = fakeHost()
    const recordChange = vi.fn(async () => ({ changeId: 'ch1' }))
    const { supervisor } = setup(host, { recordChange })
    await supervisor.startHost(init)
    await expect(host.endpoint!.request('changes.record', change)).resolves.toEqual({
      changeId: 'ch1',
    })
    expect(recordChange).toHaveBeenCalledWith('s1', 'r1', change)
  })

  it('没有改动服务时报 run.unsupported', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    await supervisor.startHost(init)
    await expect(host.endpoint!.request('changes.record', change)).rejects.toMatchObject({
      code: 'run.unsupported',
    })
  })
})

describe('refreshPermissions（M1-11b）', () => {
  it('重新汇总规则并交给运行中的宿主', async () => {
    const host = fakeHost()
    const updates: unknown[] = []
    host.endpoint!.handle('host.permissions.update', (params) => {
      updates.push(params)
      return {}
    })
    let mode = 'ask'
    const rule = (id: string) => ({
      id,
      scope: 'global' as const,
      effect: 'deny' as const,
      match: {},
      source: 'user' as const,
    })
    const { supervisor } = setup(host, { resolvePermissionRules: () => [rule(mode)] })
    const handle = await supervisor.startHost(init)
    mode = 'auto'
    await handle.refreshPermissions()
    expect(updates).toEqual([{ rules: [rule('auto')] }])
    await handle.stop()
    await handle.refreshPermissions()
    expect(updates).toHaveLength(1)
  })

  it('没有规则来源时什么也不做', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    const handle = await supervisor.startHost(init)
    await expect(handle.refreshPermissions()).resolves.toBeUndefined()
  })
})

describe('host.approval.request（M1-11a）', () => {
  const request = {
    approvalId: 'a1',
    toolCallId: 'c1',
    tool: { name: 'run_command', category: 'execute' as const },
    input: { command: 'npm test' },
    targets: { command: 'npm test' },
    kind: 'tool' as const,
    reasonCode: 'permission.category_default',
    matchedRuleIds: [],
  }

  it('交给审批服务，会话与运行由宿主确定', async () => {
    const host = fakeHost()
    const requestApproval = vi.fn(async () => ({ decision: 'allow_once' as const }))
    const cancelApproval = vi.fn()
    const { supervisor } = setup(host, { requestApproval, cancelApproval })
    await supervisor.startHost(init)
    await expect(
      host.endpoint!.request('host.approval.request', request, { timeoutMs: 0 }),
    ).resolves.toEqual({ decision: 'allow_once' })
    expect(requestApproval).toHaveBeenCalledWith('s1', 'r1', request)
    // 已结束的审批：之后的取消不再转交
    host.endpoint!.emit('host.approval.cancelled', { approvalId: 'a1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelApproval).not.toHaveBeenCalled()
  })

  it('宿主崩溃时取消未决审批，补写 approval.resolved 再写 session.crashed', async () => {
    const host = fakeHost()
    const requestApproval = vi.fn(() => new Promise<never>(() => {}))
    const cancelApproval = vi.fn()
    const { supervisor } = setup(host, { requestApproval, cancelApproval })
    await supervisor.startHost(init)
    void host.endpoint!.request('host.approval.request', request, { timeoutMs: 0 }).catch(() => {})
    void host
      .endpoint!.request(
        'host.approval.request',
        { ...request, approvalId: 'a2' },
        { timeoutMs: 0 },
      )
      .catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    host.endpoint!.emit('host.approval.cancelled', { approvalId: 'a2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelApproval.mock.calls).toEqual([['s1', 'a2']])
    // 先于请求到达的取消：请求随即以 approval.cancelled 结束，不交给审批服务
    host.endpoint!.emit('host.approval.cancelled', { approvalId: 'a3' })
    await expect(
      host.endpoint!.request(
        'host.approval.request',
        { ...request, approvalId: 'a3' },
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'approval.cancelled' })
    expect(requestApproval).toHaveBeenCalledTimes(2)
    host.exit(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelApproval.mock.calls).toEqual([
      ['s1', 'a2'],
      ['s1', 'a1'],
    ])
    expect(published.map((e) => e.type)).toEqual(['approval.resolved', 'session.crashed'])
    expect(published[0]!.payload).toEqual({
      approvalId: 'a1',
      decision: 'cancelled',
      decidedBy: 'system',
    })
  })

  it('停止的宿主只取消审批，不写事件', async () => {
    const host = fakeHost()
    const cancelApproval = vi.fn()
    const { supervisor } = setup(host, {
      requestApproval: () => new Promise<never>(() => {}),
      cancelApproval,
    })
    const handle = await supervisor.startHost(init)
    void host.endpoint!.request('host.approval.request', request, { timeoutMs: 0 }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await handle.stop()
    expect(cancelApproval).toHaveBeenCalledWith('s1', 'a1')
    expect(published).toEqual([])
  })

  it('没有审批服务时报 run.unsupported', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host)
    await supervisor.startHost(init)
    await expect(host.endpoint!.request('host.approval.request', request)).rejects.toMatchObject({
      code: 'run.unsupported',
    })
    host.endpoint!.emit('host.approval.cancelled', { approvalId: 'a1' })
    await vi.advanceTimersByTimeAsync(0)
  })
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

  it('resolves the credential for the model and passes it only in host.init', async () => {
    const host = fakeHost()
    const resolveCredential = vi.fn(async () => ({ apiKey: 'secret-key-value' }))
    const { supervisor } = setup(host, { resolveCredential })
    await supervisor.startHost(init)
    expect(resolveCredential).toHaveBeenCalledWith(init.model)
    expect(host.inits).toEqual([{ ...init, credential: { apiKey: 'secret-key-value' } }])

    const other = fakeHost()
    const { supervisor: none } = setup(other, { resolveCredential: async () => undefined })
    await none.startHost(init)
    expect(other.inits).toEqual([init])
  })

  it('records host.start_failed with the cause when the credential cannot be resolved', async () => {
    const host = fakeHost()
    const { supervisor, onError } = setup(host, {
      resolveCredential: () => Promise.reject(new RpcError('credentials.decrypt_failed')),
    })
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([
      { error: { code: 'host.start_failed', params: { cause: 'credentials.decrypt_failed' } } },
    ])
    expect(host.inits).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('passes the model config from resolveModelConfig in host.init', async () => {
    const host = fakeHost()
    const modelConfig = {
      kind: 'gemini' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      profile: {
        id: 'gemini-flash-latest',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: true,
      },
    }
    const resolveModelConfig = vi.fn(() => modelConfig)
    const { supervisor } = setup(host, { resolveModelConfig })
    await supervisor.startHost(init)
    expect(resolveModelConfig).toHaveBeenCalledWith(init.model)
    expect(host.inits).toEqual([{ ...init, modelConfig }])
  })

  it('records host.start_failed when the model is no longer configured', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host, {
      resolveModelConfig: () => {
        throw new RpcError('session.unknown_model')
      },
    })
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([
      { error: { code: 'host.start_failed', params: { cause: 'session.unknown_model' } } },
    ])
    expect(host.inits).toEqual([])
  })

  it('passes the session permission rules in host.init', async () => {
    const host = fakeHost()
    const permissionRules = [
      {
        id: 'r1',
        scope: 'session' as const,
        effect: 'allow' as const,
        match: { tool: 'run_command', command: ['npm test'] },
        source: 'approval' as const,
      },
    ]
    const resolvePermissionRules = vi.fn(() => permissionRules)
    const { supervisor } = setup(host, { resolvePermissionRules })
    await supervisor.startHost(init)
    expect(resolvePermissionRules).toHaveBeenCalledWith(init.sessionId)
    expect(host.inits).toEqual([{ ...init, permissionRules }])
  })

  it('passes the checkpoint location in host.init (M1-12b)', async () => {
    const host = fakeHost()
    const checkpoints = { gitDir: '/data/checkpoints/p1.git', ref: 'refs/cairn/sessions/s1' }
    const resolveCheckpoints = vi.fn(() => checkpoints)
    const { supervisor } = setup(host, { resolveCheckpoints })
    await supervisor.startHost(init)
    expect(resolveCheckpoints).toHaveBeenCalledWith(init.sessionId)
    expect(host.inits).toEqual([{ ...init, checkpoints }])
  })

  it('passes the custom instructions in host.init (M1-13b)', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host, { resolveInstructions: () => 'Use pnpm.' })
    await supervisor.startHost(init)
    expect(host.inits).toEqual([{ ...init, instructions: 'Use pnpm.' }])

    const none = fakeHost()
    await setup(none, { resolveInstructions: () => undefined }).supervisor.startHost(init)
    expect(none.inits).toEqual([init])
  })

  it('records host.start_failed when the permission rules cannot be loaded', async () => {
    const host = fakeHost()
    const { supervisor } = setup(host, {
      resolvePermissionRules: () => {
        throw new RpcError('storage.not_found')
      },
    })
    await expect(supervisor.startHost(init)).rejects.toMatchObject({ code: 'host.start_failed' })
    expect(crashes()).toEqual([
      { error: { code: 'host.start_failed', params: { cause: 'storage.not_found' } } },
    ])
    expect(host.inits).toEqual([])
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
