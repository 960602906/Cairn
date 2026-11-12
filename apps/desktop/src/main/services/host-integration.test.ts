/**
 * M0-13 / M0-14 集成测试：会话管理器 + 宿主监督器 + 真实的宿主协议实现（FakeRuntime），
 * 宿主进程以内存通道模拟，不启动 Electron。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { presetRules, rebuildHistory, type FakeScript } from '@cairn/core'
import type { AgentDefinition, PersistedEvent, RpcChannel } from '@cairn/protocol'
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

/** 按模型 id 选择脚本；委派测试用它让父子运行得到不同的脚本。 */
let scripts: Record<string, FakeScript> = {}
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
    createRuntime: (model) => createFakeHostRuntime(model, scripts[model.modelId] ?? SCRIPT),
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

/** 委派测试用的 Agent 定义（M4-13）。 */
const reviewerDefinition: AgentDefinition = {
  id: 'builtin.reviewer',
  version: 1,
  source: 'builtin',
  status: 'published',
  name: { 'en-US': 'Reviewer' },
  description: { 'en-US': 'Reviews changes' },
  instructions: 'Review the change.',
  model: { mode: 'inherit' },
  tools: { allow: ['*'] },
  skills: { allow: [] },
  permissions: 'read-only',
  limits: { maxStepsPerTurn: 8, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
  context: { includeProjectInstructions: false, compaction: 'auto' },
  memory: { scopes: [], write: 'never' },
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1,
}

const delegatingDefinition: AgentDefinition = {
  ...reviewerDefinition,
  id: 'default',
  name: { 'en-US': 'Default' },
  description: { 'en-US': 'Default agent' },
  instructions: '',
  delegation: {
    enabled: true,
    allowedAgents: ['builtin.reviewer'],
    maxDepth: 1,
    maxChildrenPerTurn: 2,
    maxParallel: 2,
    childBudgetShare: 0.5,
    defaultWorkspace: 'shared',
    mergeReview: 'user',
  },
}

const delegateCall = (task: string) => ({
  name: 'delegate',
  input: { agent: 'builtin.reviewer', task, brief: { goal: 'review', deliverable: 'summary' } },
})

/** 父运行一轮里并行派出两个只读子运行。 */
const delegationScript = (delayMs: number, text = 'done'): FakeScript => ({
  delayMs,
  chunkSize: 2,
  turns: [
    {
      steps: [
        { kind: 'tools', calls: [delegateCall('first'), delegateCall('second')] },
        { kind: 'reply', text },
      ],
    },
  ],
})

const childScript = (delayMs: number): FakeScript => ({
  delayMs,
  chunkSize: 2,
  turns: [
    {
      steps: [
        {
          kind: 'reply',
          text: '{"status":"completed","summary":"ok"}',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      ],
    },
  ],
})

/** `restart` 为 true 时保留数据库（模拟应用重启）。`delegation` 打开时注册委派目标。 */
function setup(restart = false, options: { delegation?: boolean } = {}) {
  if (!restart) storage = createMemoryStorage()
  scripts = {}
  service = createSessionEventService({ storage })
  inits.length = 0
  const delegation = options.delegation === true
  const real = createHostSupervisor({
    spawn,
    events: service,
    ...(delegation
      ? {
          resolveAgentDefinition: (agent: { id: string }) =>
            agent.id === delegatingDefinition.id ? delegatingDefinition : undefined,
          resolveDelegateTargets: (_sessionId: string, agentIds: readonly string[]) =>
            agentIds
              .filter((agentId) => agentId === reviewerDefinition.id)
              .map((agentId) => ({
                id: agentId,
                name: 'Reviewer',
                description: 'Reviews changes',
                permissions: 'read-only' as const,
              })),
          resolveDelegation: (_sessionId: string, agentId: string) =>
            agentId === reviewerDefinition.id
              ? {
                  definition: reviewerDefinition,
                  model: { providerId: 'fake', modelId: 'child' },
                  permissionRules: presetRules('read-only'),
                  skills: [],
                  mcpTools: [],
                  workspace: 'shared' as const,
                }
              : undefined,
        }
      : {}),
  })
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

describe('multi-session concurrency (M4-13)', () => {
  const threeSessions = () =>
    ['/a', '/b', '/c'].map((projectPath) => manager.create({ projectPath }).sessionId)

  const promptAll = (sessionIds: readonly string[]) => {
    for (const sessionId of sessionIds) manager.prompt({ sessionId, content: text('go') })
  }

  /** 只算根运行的轮次事件：子运行也写同一个会话日志。 */
  const rootCount = (sessionId: string, type: string) => {
    const rootRunId = inits.find((init) => init.sessionId === sessionId)?.runId
    return stored(sessionId).filter((event) => event.type === type && event.runId === rootRunId)
      .length
  }

  it('runs three sessions with two delegated children each without mixing runs', async () => {
    setup(false, { delegation: true })
    scripts = { fake: delegationScript(2), child: childScript(2) }
    const sessionIds = threeSessions()
    promptAll(sessionIds)

    for (const sessionId of sessionIds) {
      await vi.waitFor(() => expect(rootCount(sessionId, 'turn.completed')).toBe(1))
    }

    const runIdsBySession = new Map<string, ReadonlySet<string>>()
    for (const sessionId of sessionIds) {
      const events = stored(sessionId)
      const rootRunId = inits.find((init) => init.sessionId === sessionId)?.runId
      expect(rootRunId).toBeDefined()
      const created = events.filter((event) => event.type === 'run.created')
      expect(created).toHaveLength(3)
      expect(created.filter((event) => event.runId !== rootRunId)).toHaveLength(2)
      for (const child of created.filter((event) => event.runId !== rootRunId)) {
        expect(child.parentRunId).toBe(rootRunId)
      }
      expect(count(sessionId, 'run.delegated')).toBe(2)
      expect(count(sessionId, 'run.child.completed')).toBe(2)
      expect(count(sessionId, 'session.crashed')).toBe(0)
      runIdsBySession.set(sessionId, new Set(created.map((event) => event.runId)))
    }

    // 三个会话的运行 id 互不相交：事件严格按会话隔离
    const sets = [...runIdsBySession.values()]
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        expect([...sets[i]!].filter((runId) => sets[j]!.has(runId))).toEqual([])
      }
    }
  })

  it('cancelling one session only aborts its own runs', async () => {
    setup(false, { delegation: true })
    scripts = {
      fake: delegationScript(10, 'x'.repeat(40)),
      child: childScript(20),
    }
    const sessionIds = threeSessions()
    promptAll(sessionIds)
    for (const sessionId of sessionIds) {
      await vi.waitFor(() => expect(count(sessionId, 'run.delegated')).toBe(2))
    }

    const [first, second, third] = sessionIds as [string, string, string]
    await manager.abort({ sessionId: second })
    await vi.waitFor(() => expect(rootCount(second, 'turn.aborted')).toBe(1))

    for (const sessionId of [first, third]) {
      await vi.waitFor(() => expect(rootCount(sessionId, 'turn.completed')).toBe(1))
      expect(rootCount(sessionId, 'turn.aborted')).toBe(0)
    }
    expect(rootCount(second, 'turn.completed')).toBe(0)
    // 被中止会话的子运行也一起中止，但不影响其他会话
    expect(count(second, 'run.child.completed')).toBe(2)
  })

  it('a crashed host only marks its own session', async () => {
    setup(false, { delegation: true })
    scripts = {
      fake: delegationScript(10, 'x'.repeat(40)),
      child: childScript(20),
    }
    const sessionIds = threeSessions()
    promptAll(sessionIds)
    // 并行跑整套测试时子进程启动会慢一些，这里的等待放宽到 10 秒。
    const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 10_000 })
    for (const sessionId of sessionIds) {
      await waitFor(() => expect(count(sessionId, 'run.delegated')).toBe(2))
    }

    const [first, second, third] = sessionIds as [string, string, string]
    procs[1]?.kill()
    await waitFor(() => expect(count(second, 'session.crashed')).toBe(1))

    for (const sessionId of [first, third]) {
      await waitFor(() => expect(rootCount(sessionId, 'turn.completed')).toBe(1))
      expect(count(sessionId, 'session.crashed')).toBe(0)
    }
    expect(rootCount(second, 'turn.completed')).toBe(0)
    expect(manager.activeSessions()).not.toContain(second)
  })
})
