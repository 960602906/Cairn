/**
 * M0-13 / M0-14 集成测试：会话管理器 + 宿主监督器 + 真实的宿主协议实现（FakeRuntime），
 * 宿主进程以内存通道模拟，不启动 Electron。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rebuildHistory, type FakeScript } from '@cairn/core'
import type { PersistedEvent, RpcChannel } from '@cairn/protocol'
import { createMemoryStorage, type Storage } from '@cairn/storage'
import { createAgentHost } from '../../agent-host/host.js'
import { createFakeHostRuntime } from '../../agent-host/fake-model.js'
import { createSessionEventService, type SessionEventService } from './event-service.js'
import type { HostProcess } from './host-process.js'
import { createHostSupervisor, type HostInit, type HostSupervisor } from './host-supervisor.js'
import { createSessionManager, type SessionManager } from './session-manager.js'

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

const SCRIPT: FakeScript = { turns: [], chunkSize: 1, delayMs: 10 }

let storage: Storage
let service: SessionEventService
let manager: SessionManager
const inits: HostInit[] = []
const procs: HostProcess[] = []
let ids = 0

/** 以内存通道“启动”宿主进程：宿主退出时通知主进程。 */
function spawn(): HostProcess {
  const [mainSide, hostSide] = channelPair()
  const exitListeners: ((code: number) => void)[] = []
  let alive = true
  const exit = (code: number) => {
    if (!alive) return
    alive = false
    for (const l of exitListeners) l(code)
  }
  createAgentHost({
    channel: hostSide,
    createRuntime: (model) => createFakeHostRuntime(model, SCRIPT),
    exit,
    createId: () => `h${++ids}`,
  })
  const proc: HostProcess = {
    channel: mainSide,
    pid: 1,
    kill: () => exit(-1),
    onExit: (l) => exitListeners.push(l),
  }
  procs.push(proc)
  return proc
}

/** `restart` 为 true 时保留数据库（模拟应用重启）。 */
function setup(restart = false) {
  if (!restart) storage = createMemoryStorage()
  service = createSessionEventService({ storage })
  inits.length = 0
  const real = createHostSupervisor({ spawn, events: service })
  const supervisor: HostSupervisor = {
    startHost: (init) => {
      inits.push(structuredClone(init))
      return real.startHost(init)
    },
  }
  manager = createSessionManager({
    storage,
    events: service,
    supervisor,
    runDefaults: {
      agent: { id: 'default', version: 1 },
      model: { providerId: 'fake', modelId: 'fake' },
      mode: 'interactive',
      limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
    },
    idleTimeoutMs: 60_000,
  })
}

const stored = (sessionId: string): PersistedEvent[] => storage.events.readAfter(sessionId, 0)
const count = (sessionId: string, type: string) =>
  stored(sessionId).filter((e) => e.type === type).length
const text = (t: string) => [{ type: 'text' as const, text: t }]

afterEach(async () => {
  await manager.shutdown()
  inits.length = 0
  procs.length = 0
})

describe('session manager with a real host', () => {
  it('runs turns, aborts, and resumes the same run with consistent history after a restart', async () => {
    setup()
    const { sessionId } = manager.create({ projectPath: '/work' })

    // 第一轮：回显
    manager.prompt({ sessionId, content: text('hello') })
    await vi.waitFor(() => expect(count(sessionId, 'turn.completed')).toBe(1))
    const runId = inits[0]!.runId
    expect(inits[0]?.resume).toBeUndefined()

    // 第二轮：中途停止，产生 turn.aborted
    let sawDelta = false
    const off = service.subscribe((_id, batch) => {
      if (batch.some((e) => e.type === 'message.assistant.delta')) sawDelta = true
    })
    manager.prompt({ sessionId, content: text('a fairly long answer that streams slowly') })
    await vi.waitFor(() => expect(sawDelta).toBe(true))
    off()
    await manager.abort({ sessionId })
    await vi.waitFor(() => expect(count(sessionId, 'turn.aborted')).toBe(1))
    expect(stored(sessionId).find((e) => e.type === 'turn.aborted')?.payload).toEqual({
      reason: 'user',
    })

    // 停止宿主（应用退出），再输入：新宿主继续同一个运行
    const historyBefore = rebuildHistory(stored(sessionId), { runId })
    await manager.shutdown()
    expect(manager.activeSessions()).toEqual([])
    setup(true)
    expect(manager.recoverInterrupted()).toBe(0)
    manager.prompt({ sessionId, content: text('again') })
    await vi.waitFor(() => expect(count(sessionId, 'turn.completed')).toBe(2))

    expect(inits[0]).toMatchObject({ runId, resume: { state: 'idle' } })
    expect(inits[0]?.history).toEqual(historyBefore)
    expect(historyBefore.map((m) => [m.role, m.content])).toEqual([
      ['user', text('hello')],
      ['assistant', text('hello')],
      ['user', text('a fairly long answer that streams slowly')],
    ])
    expect(count(sessionId, 'run.created')).toBe(1)
    const reply = stored(sessionId).findLast((e) => e.type === 'message.assistant.completed')
    expect(reply?.payload).toMatchObject({ content: text('again') })
    // 轮次 id 跨宿主重启不重复
    const turnIds = stored(sessionId)
      .filter((e) => e.type === 'turn.started')
      .map((e) => e.turnId)
    expect(new Set(turnIds).size).toBe(3)
  })

  it('marks a turn cut off by a host crash as interrupted and continues the run', async () => {
    setup()
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('a fairly long answer that streams slowly') })
    await vi.waitFor(() => expect(count(sessionId, 'turn.started')).toBe(1))
    const runId = inits[0]!.runId
    // 宿主进程意外退出
    procs[0]?.kill()
    await vi.waitFor(() => expect(count(sessionId, 'session.crashed')).toBe(1))
    await vi.waitFor(() => expect(manager.activeSessions()).toEqual([]))

    manager.prompt({ sessionId, content: text('again') })
    await vi.waitFor(() => expect(count(sessionId, 'turn.completed')).toBe(1))
    expect(inits[1]).toMatchObject({ runId, resume: { state: 'interrupted' } })
    expect(
      stored(sessionId)
        .filter((e) => e.type === 'run.state.changed')
        .map((e) => e.payload),
    ).toContainEqual({ from: 'thinking', to: 'interrupted', reason: 'host_lost' })
    expect(manager.list({}).sessions[0]?.status).toBe('idle')
  })
})
