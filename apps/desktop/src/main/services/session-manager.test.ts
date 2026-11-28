import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDefinition, EventEnvelope, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage, type Storage } from '@cairn/storage'
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
  readonly inputs: unknown[]
  crash(): void
}

function fakeHandle(init: HostInit, stopsCleanly = true): FakeHost {
  let state: HostState = 'running'
  let resolveExited!: (exit: HostExit) => void
  const exited = new Promise<HostExit>((resolve) => (resolveExited = resolve))
  const prompts: string[] = []
  const inputs: unknown[] = []
  const end = (exit: HostExit) => {
    if (state === 'stopped' || state === 'crashed') return
    state = exit.reason
    resolveExited(exit)
  }
  return {
    init,
    prompts,
    inputs,
    sessionId: init.sessionId,
    runId: init.runId,
    pid: 1,
    state: () => state,
    prompt: vi.fn(async (input) => {
      prompts.push(input.messageId)
      inputs.push(input)
    }),
    abort: vi.fn(async () => undefined),
    refreshPermissions: vi.fn(async () => undefined),
    compact: vi.fn(async () => false),
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

  it('saves a user brief and skips an unchanged one (M3-04)', () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor)
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Old' })
    expect(manager.updateBrief({ sessionId, content: '  ' })).toEqual({})
    expect(published.some((event) => event.type === 'session.brief.updated')).toBe(false)
    manager.updateBrief({ sessionId, content: '  不要改 API  ' })
    expect(published.at(-1)).toMatchObject({
      type: 'session.brief.updated',
      payload: { content: '不要改 API', editedBy: 'user' },
    })
    const count = published.length
    expect(manager.updateBrief({ sessionId, content: '不要改 API' })).toEqual({})
    expect(published).toHaveLength(count)
    expect(() => manager.updateBrief({ sessionId: 'missing', content: 'x' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('renames and archives sessions (M2-02)', () => {
    const { supervisor } = fakeSupervisor()
    let locked = false
    const { manager } = setup(supervisor, { isLocked: () => locked })
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Old' })
    manager.rename({ sessionId, title: '  New  ' })
    expect(manager.list({}).sessions[0]?.title).toBe('New')
    expect(published.at(-1)).toMatchObject({
      type: 'session.renamed',
      runId: sessionId,
      payload: { title: 'New', source: 'user' },
    })
    expect(() => manager.rename({ sessionId: 'missing', title: 'x' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )

    locked = true
    expect(() => manager.archive({ sessionId })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    locked = false
    manager.prompt({ sessionId, content: text('hi') })
    expect(() => manager.archive({ sessionId })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )

    const other = manager.create({ projectPath: '/work' })
    manager.archive({ sessionId: other.sessionId })
    expect(published.at(-1)).toMatchObject({ type: 'session.archived', payload: {} })
    expect(manager.list({}).sessions.map((s) => s.sessionId)).toEqual([sessionId])
    expect(() => manager.archive({ sessionId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('pins a session to the top of the list without changing its updatedAt', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const first = manager.create({ projectPath: '/work', title: 'First' })
    const second = manager.create({ projectPath: '/work', title: 'Second' })
    const before = manager.list({}).sessions
    expect(before.map((s) => s.sessionId)).toEqual([first.sessionId, second.sessionId])

    manager.setPinned({ sessionId: second.sessionId, pinned: true })
    const after = manager.list({}).sessions
    expect(after.map((s) => s.sessionId)).toEqual([second.sessionId, first.sessionId])
    expect(after[0]).toMatchObject({ pinned: true, updatedAt: before[0]?.updatedAt })
    expect(after[1]?.pinned).toBeUndefined()

    expect(() => manager.setPinned({ sessionId: 'missing', pinned: true })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('exports a Markdown transcript and saves it through the dialog', async () => {
    const showSaveDialog = vi.fn(async () => '/tmp/chat.md')
    const writeFile = vi.fn()
    const { manager } = setup(fakeSupervisor().supervisor, {
      showSaveDialog,
      writeFile,
      transcriptLocale: () => 'zh-CN',
    })
    const { sessionId } = manager.create({ projectPath: '/work', title: '修复/登录' })
    hostEmits(
      sessionId,
      'run-1',
      ['message.user', { messageId: 'm1', content: [{ type: 'text', text: '你好' }] }],
      [
        'message.assistant.completed',
        {
          messageId: 'm2',
          content: [{ type: 'text', text: '你好！' }],
          model: { providerId: 'p', modelId: 'm' },
        },
      ],
    )

    const { markdown } = manager.transcript({ sessionId })
    expect(markdown).toBe(
      [
        '# 修复/登录',
        '',
        '> /work',
        '',
        '## 用户',
        '',
        '你好',
        '',
        '## 助手',
        '',
        '你好！',
        '',
      ].join('\n'),
    )
    await expect(manager.exportTranscript({ sessionId })).resolves.toEqual({
      cancelled: false,
      path: '/tmp/chat.md',
    })
    expect(showSaveDialog).toHaveBeenCalledWith('修复 登录.md')
    expect(writeFile).toHaveBeenCalledWith('/tmp/chat.md', markdown)

    expect(() => manager.transcript({ sessionId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('skips the file when the export dialog is cancelled and reports write failures', async () => {
    const writeFile = vi.fn()
    const { manager } = setup(fakeSupervisor().supervisor, {
      showSaveDialog: async () => undefined,
      writeFile,
    })
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Demo' })
    await expect(manager.exportTranscript({ sessionId })).resolves.toEqual({ cancelled: true })
    expect(writeFile).not.toHaveBeenCalled()

    const failing = setup(fakeSupervisor().supervisor, {
      showSaveDialog: async () => '/tmp/chat.md',
      writeFile: () => {
        throw new Error('disk full')
      },
    })
    const other = failing.manager.create({ projectPath: '/work', title: 'Demo' })
    await expect(
      failing.manager.exportTranscript({ sessionId: other.sessionId }),
    ).rejects.toMatchObject({ code: 'fs.failed' })
    expect(failing.onError).toHaveBeenCalled()
  })

  it('searches message text for the command palette, skipping archived sessions', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const first = manager.create({ projectPath: '/work', title: 'First' })
    const second = manager.create({ projectPath: '/work', title: 'Second' })
    hostEmits(first.sessionId, 'run-1', [
      'message.user',
      { messageId: 'm1', content: [{ type: 'text', text: '修复登录问题' }] },
    ])
    hostEmits(second.sessionId, 'run-1', [
      'message.user',
      { messageId: 'm1', content: [{ type: 'text', text: '写登录页' }] },
    ])

    expect(manager.searchText({ query: ' 登录 ' }).hits).toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        snippet: expect.stringContaining('登录'),
      }),
      expect.objectContaining({ sessionId: second.sessionId }),
    ])

    manager.archive({ sessionId: second.sessionId })
    expect(manager.searchText({ query: '登录' }).hits.map((hit) => hit.sessionId)).toEqual([
      first.sessionId,
    ])
    expect(
      manager.searchText({ query: '登录', includeArchived: true }).hits.map((hit) => hit.sessionId),
    ).toEqual([first.sessionId, second.sessionId])
    expect(manager.searchText({ query: '找不到的词' }).hits).toEqual([])
  })

  it('restores an archived session (M2-02)', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Demo' })
    manager.archive({ sessionId })
    expect(manager.list({}).sessions.map((s) => s.sessionId)).toEqual([])

    manager.unarchive({ sessionId })
    expect(published.at(-1)).toMatchObject({ type: 'session.unarchived', payload: {} })
    expect(manager.list({}).sessions.map((s) => s.sessionId)).toEqual([sessionId])
    expect(manager.list({}).sessions[0]?.status).toBe('idle')

    expect(() => manager.unarchive({ sessionId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('deletes only archived sessions, permanently', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Demo' })

    expect(() => manager.delete({ sessionId })).toThrow(
      expect.objectContaining({ code: 'session.not_archived' }),
    )

    manager.archive({ sessionId })
    manager.delete({ sessionId })
    expect(manager.list({ includeArchived: true }).sessions).toEqual([])
    expect(storage.sessions.get(sessionId)).toBeUndefined()
    expect(() => manager.delete({ sessionId })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('refuses to delete while the session is locked', () => {
    let locked = false
    const { manager } = setup(fakeSupervisor().supervisor, { isLocked: () => locked })
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Demo' })
    manager.archive({ sessionId })
    // 撤销改动或恢复检查点时不能删
    locked = true

    expect(() => manager.delete({ sessionId })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
  })

  it('stores the thinking level of a session and announces it', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const { sessionId } = manager.create({ projectPath: '/work', title: 'Demo' })

    manager.setThinkingLevel({ sessionId, thinkingLevel: 'low' })
    expect(storage.sessions.get(sessionId)?.thinkingLevel).toBe('low')
    expect(published.at(-1)).toMatchObject({
      type: 'session.thinkingLevel.changed',
      payload: { thinkingLevel: 'low' },
    })
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

    // 已发送、尚未 turn.started 时仍不接受新输入
    expect(manager.isBusy(sessionId)).toBe(true)
    expect(() => manager.prompt({ sessionId, content: text('again') })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    startTurn(sessionId, 'id3', 't1')
    // 运行中再发会作为引导注入当前轮：不抛忙、不另起一轮、沿用同一个运行
    const steered = manager.prompt({ sessionId, content: text('more') })
    expect(hosts[0]?.inputs.at(-1)).toMatchObject({
      messageId: steered.messageId,
      content: text('more'),
      send: 'steer',
    })
    expect(manager.list({}).sessions[0]?.status).toBe('running')
    finishTurn(sessionId, 'id3', 't1')
    expect(manager.isBusy(sessionId)).toBe(false)

    // 同一个宿主、同一个运行继续
    const second = manager.prompt({ sessionId, content: text('next') })
    await flush()
    expect(supervisor.startHost).toHaveBeenCalledTimes(1)
    expect(hosts[0]?.prompts).toEqual([messageId, steered.messageId, second.messageId])
    expect(published.filter((e) => e.type === 'message.user').map((e) => e.runId)).toEqual([
      'id3',
      'id3',
      'id3',
    ])
  })

  it('isBusy covers queued and starting sessions; isLocked rejects prompts (M1-08b)', async () => {
    const { supervisor } = fakeSupervisor()
    let locked = true
    const { manager } = setup(supervisor, { isLocked: () => locked })
    const { sessionId } = manager.create({ projectPath: '/work' })
    expect(manager.isBusy(sessionId)).toBe(false)
    expect(() => manager.prompt({ sessionId, content: text('hi') })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    locked = false
    manager.prompt({ sessionId, content: text('hi') })
    // 宿主启动中
    expect(manager.isBusy(sessionId)).toBe(true)
    expect(manager.isBusy('unknown')).toBe(false)
  })

  it('stores @ mentions with the user message and sends their context to the model (ADR-0037)', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 1_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    const mentions = [{ path: 'a.ts', kind: 'file' as const }]
    manager.prompt({ sessionId, content: text('看 @a.ts'), mentions, context: 'ctx' })
    const user = published.find((e) => e.type === 'message.user')
    expect(user?.payload).toEqual({
      messageId: expect.any(String),
      content: text('看 @a.ts'),
      mentions,
      context: 'ctx',
    })
    await flush()
    expect(hosts[0]?.inputs[0]).toMatchObject({ content: [...text('看 @a.ts'), ...text('ctx')] })
    startTurn(sessionId, 'id3', 't1')
    finishTurn(sessionId, 'id3', 't1')

    // 宿主运行中直接转发，同样带上上下文；空的引用列表不落库
    manager.prompt({ sessionId, content: text('再看'), mentions: [], context: 'more' })
    await flush()
    expect(hosts[0]?.inputs[1]).toMatchObject({ content: [...text('再看'), ...text('more')] })
    expect(published.filter((e) => e.type === 'message.user').at(-1)?.payload).not.toHaveProperty(
      'mentions',
    )
  })

  it('stores / skills and @ agents with the user message', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 1_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    const skills = [{ name: 'review' }]
    const agents = [{ agentId: 'user.review', name: '审查员' }]
    manager.prompt({ sessionId, content: text('/review 看'), skills, agents, context: 'ctx' })
    expect(published.find((e) => e.type === 'message.user')?.payload).toEqual({
      messageId: expect.any(String),
      content: text('/review 看'),
      skills,
      agents,
      context: 'ctx',
    })
    await flush()
    startTurn(sessionId, 'id3', 't1')
    finishTurn(sessionId, 'id3', 't1')

    // 空的技能与 Agent 列表不落库
    manager.prompt({ sessionId, content: text('hi'), skills: [], agents: [] })
    const last = published.filter((e) => e.type === 'message.user').at(-1)?.payload
    expect(last).not.toHaveProperty('skills')
    expect(last).not.toHaveProperty('agents')
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

  it('switches the model from the next turn, restarting an idle host (M2-04)', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const chat = { providerId: 'deepseek', modelId: 'deepseek-chat' }
    const reasoner = { providerId: 'deepseek', modelId: 'deepseek-reasoner' }
    const { manager } = setup(supervisor, {
      models: { defaultModel: () => chat, has: (m) => m.modelId !== 'missing' },
    })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    expect(hosts[0]?.init.model).toEqual(chat)
    hostEmits(
      sessionId,
      'id3',
      ['run.created', { ...defaults, model: chat }],
      ['turn.started', {}, { turnId: 't1' }],
      ['run.state.changed', { from: 'idle', to: 'thinking' }],
    )
    finishTurn(sessionId, 'id3', 't1')

    manager.setModel({ sessionId, model: reasoner })
    expect(storage.sessions.get(sessionId)?.model).toEqual(reasoner)
    expect(published.at(-1)).toMatchObject({
      type: 'session.model.changed',
      runId: sessionId,
      payload: { model: reasoner },
    })
    expect(() =>
      manager.setModel({ sessionId, model: { providerId: 'deepseek', modelId: 'missing' } }),
    ).toThrow(expect.objectContaining({ code: 'session.unknown_model' }))
    expect(() => manager.setModel({ sessionId: 'missing', model: chat })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )

    manager.prompt({ sessionId, content: text('again') })
    expect(hosts[0]?.stop).toHaveBeenCalled()
    expect(manager.isBusy(sessionId)).toBe(true)
    await flush()
    expect(hosts[1]?.init).toMatchObject({
      runId: 'id3',
      model: reasoner,
      history: [{ role: 'user', content: text('hi') }],
      resume: { state: 'completed' },
    })
    expect(hosts[1]?.prompts).toHaveLength(1)

    // 模型没变时继续用原来的宿主
    hostEmits(
      sessionId,
      'id3',
      ['turn.started', {}, { turnId: 't2' }],
      ['run.state.changed', { from: 'completed', to: 'thinking' }],
    )
    finishTurn(sessionId, 'id3', 't2')
    manager.prompt({ sessionId, content: text('third') })
    await flush()
    expect(hosts).toHaveLength(2)
    expect(hosts[1]?.prompts).toHaveLength(2)
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

  it('restarts hosts with a stale tool list: idle ones now, busy ones after the turn (M3-09)', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 60_000 })
    const ids = ['/a', '/b'].map((p) => manager.create({ projectPath: p }).sessionId)
    for (const sessionId of ids) manager.prompt({ sessionId, content: text('go') })
    await flush()
    const [idle, busy] = hosts
    startTurn(ids[0]!, idle!.runId, 't1')
    finishTurn(ids[0]!, idle!.runId, 't1')
    startTurn(ids[1]!, busy!.runId, 't2')

    manager.refreshTools()
    await flush()
    expect(idle!.stop).toHaveBeenCalled()
    expect(busy!.stop).not.toHaveBeenCalled()

    finishTurn(ids[1]!, busy!.runId, 't2')
    await flush()
    // 不等 60 秒的空闲超时
    expect(busy!.stop).toHaveBeenCalled()
    expect(manager.activeSessions()).toEqual([])
  })

  it('asks running hosts to refresh their permission rules (M1-11b)', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const onError = vi.fn()
    const { manager } = setup(supervisor, { onError })
    const ids = ['/a', '/b'].map((p) => manager.create({ projectPath: p }).sessionId)
    for (const sessionId of ids) manager.prompt({ sessionId, content: text('go') })
    await flush()
    manager.refreshPermissions()
    expect(hosts.map((h) => vi.mocked(h.refreshPermissions).mock.calls.length)).toEqual([1, 1])
    vi.mocked(hosts[1]!.refreshPermissions).mockRejectedValueOnce(new Error('gone'))
    manager.refreshPermissions([ids[1]!])
    await flush()
    expect(hosts.map((h) => vi.mocked(h.refreshPermissions).mock.calls.length)).toEqual([1, 2])
    expect(onError).toHaveBeenCalled()
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
    await expect(manager.compact({ sessionId: ids[0]! })).rejects.toMatchObject({
      code: 'run.disposed',
    })
    expect(() => manager.updateBrief({ sessionId: ids[0]!, content: 'x' })).toThrow(
      expect.objectContaining({ code: 'run.disposed' }),
    )
    expect(() => manager.approvePlan({ sessionId: ids[0]!, planId: 'p' })).toThrow(
      expect.objectContaining({ code: 'run.disposed' }),
    )
    expect(types()).not.toContain('session.crashed')
  })
})

describe('compact (M3-03)', () => {
  it('returns no compaction for a session without runs or without anything to compact', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 60_000 })
    const empty = manager.create({ projectPath: '/empty' }).sessionId
    await expect(manager.compact({ sessionId: empty })).resolves.toEqual({ compacted: false })
  })

  it('asks the running host, and compacts from the log when no host is up', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const summarize = vi.fn(async () => 'SUM')
    const { manager } = setup(supervisor, { summarize, idleTimeoutMs: 60_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('一') })
    await flush()
    vi.mocked(hosts[0]!.compact).mockResolvedValueOnce(true)
    await expect(manager.compact({ sessionId })).resolves.toEqual({ compacted: true })
    expect(hosts[0]?.compact).toHaveBeenCalledOnce()

    const runId = hosts[0]!.runId
    const assistant = (messageId: string, turnId: string): [string, object, object] => [
      'message.assistant.completed',
      { messageId, content: text('ok'), model: defaults.model },
      { turnId },
    ]
    hostEmits(
      sessionId,
      runId,
      ['run.created', defaults],
      ['turn.started', {}, { turnId: 't1' }],
      assistant('a1', 't1'),
      ['message.user', { messageId: 'u2', content: text('二') }, { turnId: 't2' }],
      ['turn.started', {}, { turnId: 't2' }],
      assistant('a2', 't2'),
      ['message.user', { messageId: 'u3', content: text('三') }, { turnId: 't3' }],
      ['turn.started', {}, { turnId: 't3' }],
      assistant('a3', 't3'),
    )
    finishTurn(sessionId, runId, 't3')
    await hosts[0]!.stop()
    await flush()
    expect(manager.activeSessions()).toEqual([])

    await expect(manager.compact({ sessionId })).resolves.toEqual({ compacted: true })
    expect(summarize).toHaveBeenCalledOnce()
    expect(published.at(-1)).toMatchObject({
      type: 'context.compacted',
      runId,
      payload: { summary: 'SUM', coversTurns: ['t1', 't1'] },
    })
  })
})

describe('plan (M3-05)', () => {
  const content = {
    goal: '读代码',
    files: ['a.ts'],
    steps: [{ id: 'read', title: '读 a.ts' }],
    risks: '',
    verification: '单测',
    markdown: '1. 读 a.ts',
  }

  async function proposed(mode: 'plan' | 'normal' = 'plan') {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 60_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('计划一下'), ...(mode === 'plan' ? { mode } : {}) })
    await flush()
    const host = hosts[0]!
    startTurn(sessionId, host.runId, 't1')
    hostEmits(sessionId, host.runId, [
      'plan.proposed',
      { planId: 'pl1', content },
      { turnId: 't1' },
    ])
    finishTurn(sessionId, host.runId, 't1')
    return { manager, sessionId, host }
  }

  it('approves edited steps and keeps that plan after a later one is abandoned', async () => {
    const { manager, sessionId, host } = await proposed()
    expect(host.inputs[0]).toMatchObject({ mode: 'plan' })
    expect(host.inputs[0]).not.toHaveProperty('plan')
    expect(() =>
      manager.approvePlan({ sessionId, planId: 'pl1', steps: [{ id: 'missing', title: 'x' }] }),
    ).toThrow(expect.objectContaining({ code: 'plan.unknown_step' }))
    const approved = manager.approvePlan({
      sessionId,
      planId: 'pl1',
      steps: [{ id: 'read', title: '先读测试' }],
    })
    if (!('messageId' in approved)) throw new Error('approvePlan should resolve immediately')
    await flush()
    expect(published.some((event) => event.type === 'plan.approved')).toBe(true)
    // 批准即创建执行列表，且排在 plan.approved 之前（ADR-0038）。
    const taskListIndex = types().indexOf('tasklist.created')
    expect(taskListIndex).toBeGreaterThan(-1)
    expect(taskListIndex).toBeLessThan(types().indexOf('plan.approved'))
    expect(published[taskListIndex]?.payload).toMatchObject({
      listId: 'plan-pl1',
      title: '读代码',
      source: 'plan',
      planId: 'pl1',
      items: [{ itemId: 'read', title: '先读测试' }],
    })
    expect(host.inputs[1]).toMatchObject({
      messageId: approved.messageId,
      plan: { planId: 'pl1', goal: '读代码', steps: [{ id: 'read', title: '先读测试' }] },
      taskLists: [
        {
          listId: 'plan-pl1',
          source: 'plan',
          planId: 'pl1',
          items: [{ itemId: 'read', title: '先读测试', status: 'pending' }],
        },
      ],
    })
    expect(host.inputs[1]).not.toHaveProperty('mode')
    expect(
      JSON.stringify(published.filter((event) => event.type === 'message.user').at(-1)),
    ).toContain('先读测试')

    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')
    hostEmits(sessionId, host.runId, [
      'plan.proposed',
      { planId: 'pl2', content },
      { turnId: 't2' },
    ])
    expect(manager.abandonPlan({ sessionId, planId: 'pl2' })).toEqual({})
    manager.prompt({ sessionId, content: text('继续') })
    await flush()
    expect(host.inputs.at(-1)).toMatchObject({ plan: { planId: 'pl1' } })
    expect(host.inputs.at(-1)).not.toHaveProperty('mode')
  })

  it('passes the executed plan snapshot when steering mid-turn', async () => {
    const { manager, sessionId, host } = await proposed()
    manager.approvePlan({ sessionId, planId: 'pl1' })
    await flush()
    startTurn(sessionId, host.runId, 't2', false)
    const steered = manager.prompt({ sessionId, content: text('加一步') })
    expect(host.inputs.at(-1)).toMatchObject({
      messageId: steered.messageId,
      send: 'steer',
      plan: { planId: 'pl1', goal: '读代码', steps: [{ id: 'read', title: '读 a.ts' }] },
      taskLists: [{ listId: 'plan-pl1', planId: 'pl1' }],
    })
  })

  it('replans in plan mode and rejects a plan that is not pending', async () => {
    const { manager, sessionId, host } = await proposed()
    const next = manager.replan({ sessionId, planId: 'pl1', feedback: '换个做法' })
    if (!('messageId' in next)) throw new Error('replan should resolve immediately')
    await flush()
    expect(published.some((event) => event.type === 'plan.rejected')).toBe(true)
    expect(host.inputs[1]).toMatchObject({
      messageId: next.messageId,
      mode: 'plan',
      content: text('换个做法'),
    })
    expect(host.inputs[1]).not.toHaveProperty('plan')
    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')
    expect(() => manager.abandonPlan({ sessionId, planId: 'pl1' })).toThrow(
      expect.objectContaining({ code: 'plan.not_pending' }),
    )
  })
})

describe('task lists in prompts (ADR-0038)', () => {
  it('passes open lists on the next prompt and omits closed ones', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 60_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    const host = hosts[0]!
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    expect(host.inputs[0]).not.toHaveProperty('taskLists')

    hostEmits(sessionId, host.runId, [
      'tasklist.created',
      {
        listId: 'tl1',
        title: '清单',
        source: 'ad_hoc',
        items: [{ itemId: 'x', title: '做' }],
      },
    ])
    manager.prompt({ sessionId, content: text('继续') })
    await flush()
    expect(host.inputs.at(-1)).toMatchObject({
      taskLists: [
        {
          listId: 'tl1',
          title: '清单',
          source: 'ad_hoc',
          items: [{ itemId: 'x', title: '做', status: 'pending' }],
        },
      ],
    })

    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')
    hostEmits(sessionId, host.runId, ['tasklist.closed', { listId: 'tl1' }])
    manager.prompt({ sessionId, content: text('再来') })
    await flush()
    expect(host.inputs.at(-1)).not.toHaveProperty('taskLists')
  })

  it('closes superseded plan lists and reuses an existing one on approval', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, { idleTimeoutMs: 60_000 })
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('计划一下'), mode: 'plan' })
    await flush()
    const host = hosts[0]!
    startTurn(sessionId, host.runId, 't1')
    hostEmits(sessionId, host.runId, [
      'plan.proposed',
      {
        planId: 'pl1',
        content: {
          goal: '读代码',
          files: [],
          steps: [{ id: 'read', title: '读 a.ts' }],
          risks: '',
          verification: '',
          markdown: '',
        },
      },
      { turnId: 't1' },
    ])
    // 上一份计划的列表还开着；同一计划的列表已经存在（例如恢复的会话）。
    hostEmits(sessionId, host.runId, [
      'tasklist.created',
      {
        listId: 'plan-pl0',
        title: '旧计划',
        source: 'plan',
        planId: 'pl0',
        items: [{ itemId: 'old', title: '旧' }],
      },
    ])
    hostEmits(sessionId, host.runId, [
      'tasklist.created',
      {
        listId: 'plan-pl1',
        title: '读代码',
        source: 'plan',
        planId: 'pl1',
        items: [{ itemId: 'read', title: '读 a.ts' }],
      },
    ])
    finishTurn(sessionId, host.runId, 't1')

    // 计划轮不下发列表快照，执行轮才有（见上一条用例）。
    manager.prompt({ sessionId, content: text('再计划'), mode: 'plan' })
    await flush()
    expect(host.inputs.at(-1)).not.toHaveProperty('taskLists')
    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')

    manager.approvePlan({ sessionId, planId: 'pl1' })
    await flush()
    expect(published.filter((event) => event.type === 'tasklist.closed')).toMatchObject([
      { payload: { listId: 'plan-pl0', reason: 'superseded' } },
    ])
    // 已经存在同 id 的列表时不重复创建。
    expect(
      published
        .filter((event) => event.type === 'tasklist.created')
        .map((event) => (event.payload as { listId: string }).listId),
    ).toEqual(['plan-pl0', 'plan-pl1'])
  })
})

describe('agent switching (M3-11)', () => {
  const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
    id: 'user.reviewer',
    version: 3,
    source: 'user',
    status: 'published',
    name: { 'en-US': 'Reviewer' },
    description: { 'en-US': 'Read-only review' },
    instructions: 'Only review.',
    model: { mode: 'inherit' },
    tools: { allow: ['read_file'] },
    skills: { allow: [] },
    permissions: 'ask',
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...overrides,
  })

  const resolver = (def: AgentDefinition | undefined) =>
    ({ resolveAgent: () => def }) satisfies Partial<SessionManagerOptions>

  it('starts a new run with the chosen agent and fixed model', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const fixed = definition({
      model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
      limits: { maxStepsPerTurn: 4 },
    })
    const { manager } = setup(supervisor, resolver(fixed))
    const { sessionId } = manager.create({ projectPath: '/work' })

    await manager.setAgent({ sessionId, agent: { id: fixed.id, version: fixed.version } })
    expect(published.at(-1)).toMatchObject({
      type: 'run.created',
      payload: {
        agent: { id: 'user.reviewer', version: 3 },
        model: { providerId: 'openai', modelId: 'gpt' },
        limits: { maxStepsPerTurn: 4 },
      },
    })

    manager.prompt({ sessionId, content: text('go') })
    await flush()
    expect(hosts[0]?.init).toMatchObject({
      agent: { id: 'user.reviewer', version: 3 },
      model: { providerId: 'openai', modelId: 'gpt' },
      limits: { maxStepsPerTurn: 4 },
    })
  })

  it('rejects an unknown agent and a busy session', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, resolver(undefined))
    const { sessionId } = manager.create({ projectPath: '/work' })
    await expect(
      manager.setAgent({ sessionId, agent: { id: 'missing', version: 1 } }),
    ).rejects.toMatchObject({ code: 'agent.not_found' })

    const known = definition()
    const other = setup(fakeSupervisor().supervisor, resolver(known))
    const created = other.manager.create({ projectPath: '/work' })
    other.manager.prompt({ sessionId: created.sessionId, content: text('hi') })
    await expect(
      other.manager.setAgent({
        sessionId: created.sessionId,
        agent: { id: known.id, version: known.version },
      }),
    ).rejects.toMatchObject({ code: 'run.busy' })
  })

  it('resumes the new run with the agent model and limits on the next prompt', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const fixed = definition({
      model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
      limits: { maxStepsPerTurn: 4 },
    })
    const { manager } = setup(supervisor, resolver(fixed))
    const { sessionId } = manager.create({ projectPath: '/work' })
    await manager.setAgent({ sessionId, agent: { id: fixed.id, version: fixed.version } })
    const runId = published.at(-1)?.runId ?? ''
    manager.prompt({ sessionId, content: text('go') })
    await flush()
    expect(hosts[0]?.init).toMatchObject({ runId })
    expect(hosts[0]?.init).toMatchObject({ model: { providerId: 'openai', modelId: 'gpt' } })
  })

  it('reports the delegation targets of the current agent', async () => {
    const { supervisor } = fakeSupervisor()
    const agentDef = definition({
      delegation: {
        enabled: true,
        allowedAgents: ['builtin.explorer', 'builtin.reviewer'],
        maxDepth: 1,
        maxChildrenPerTurn: 4,
        maxParallel: 2,
        childBudgetShare: 0.5,
        defaultWorkspace: 'auto',
        mergeReview: 'user',
      },
    })
    const { manager } = setup(supervisor, resolver(agentDef))
    const { sessionId } = manager.create({ projectPath: '/work' })
    const targets = { enabled: true, agentIds: ['builtin.explorer', 'builtin.reviewer'] }
    // 没有会话按新会话的默认 Agent；还没运行过的会话同样回退到默认 Agent。
    expect(manager.delegationTargets({})).toEqual(targets)
    expect(manager.delegationTargets({ sessionId })).toEqual(targets)
    await manager.setAgent({ sessionId, agent: { id: agentDef.id, version: agentDef.version } })
    expect(manager.delegationTargets({ sessionId })).toEqual(targets)
    expect(() => manager.delegationTargets({ sessionId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('reports no targets when the current agent cannot delegate', () => {
    const { manager } = setup(fakeSupervisor().supervisor, resolver(definition()))
    const { sessionId } = manager.create({ projectPath: '/work' })
    expect(manager.delegationTargets({})).toEqual({ enabled: false, agentIds: [] })
    expect(manager.delegationTargets({ sessionId })).toEqual({ enabled: false, agentIds: [] })
  })

  it('resolves new-session targets from the selected agent or team', () => {
    const policy = (allowedAgents: string[]) => ({
      enabled: true,
      allowedAgents,
      maxDepth: 1,
      maxChildrenPerTurn: 2,
      maxParallel: 1,
      childBudgetShare: 0.5,
      defaultWorkspace: 'auto' as const,
      mergeReview: 'user' as const,
    })
    const selected = definition({ id: 'user.selected', delegation: policy(['builtin.explorer']) })
    const teamAgent = definition({ id: 'user.coordinator', delegation: policy(['user.maker']) })
    const resolveTeamAgent = vi.fn((teamId: string) =>
      teamId === 'user.team-1' ? teamAgent : undefined,
    )
    const { manager } = setup(fakeSupervisor().supervisor, {
      ...resolver(selected),
      resolveTeamAgent,
    })

    // 新对话页选了单个 Agent：按它的名单，而不是默认 Agent 的。
    expect(
      manager.delegationTargets({ agent: { id: selected.id, version: selected.version } }),
    ).toEqual({ enabled: true, agentIds: ['builtin.explorer'] })
    // 选了团队：按主控合并后的名单；传了 agent 也以团队为准。
    expect(
      manager.delegationTargets({
        teamId: 'user.team-1',
        agent: { id: 'ignored', version: 1 },
      }),
    ).toEqual({ enabled: true, agentIds: ['user.maker'] })
    expect(manager.delegationTargets({ teamId: 'user.missing' })).toEqual({
      enabled: false,
      agentIds: [],
    })
    // 都没选：沿用默认 Agent。
    expect(manager.delegationTargets({})).toEqual({
      enabled: true,
      agentIds: ['builtin.explorer'],
    })
  })
})

describe('team binding (M7-09)', () => {
  const coordinator: AgentDefinition = {
    id: 'user.coordinator',
    version: 2,
    source: 'user',
    status: 'published',
    name: { 'en-US': 'Coordinator' },
    description: { 'en-US': 'Runs the team' },
    instructions: 'Coordinate.',
    model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
    tools: { allow: ['read_file'] },
    skills: { allow: [] },
    permissions: 'ask',
    limits: { maxStepsPerTurn: 4 },
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
  }
  const binding = {
    teamId: 'user.team-1',
    name: { 'en-US': 'Review team' },
    version: 1,
    pattern: 'review-loop' as const,
  }
  const resolution = { team: binding, coordinator: { id: coordinator.id, version: 2 } }
  const secondBinding = { ...binding, teamId: 'user.team-2', name: { 'en-US': 'Second team' } }
  const secondResolution = { team: secondBinding, coordinator: resolution.coordinator }
  const options = (): Partial<SessionManagerOptions> => ({
    resolveAgent: (agent) => (agent.id === coordinator.id ? coordinator : undefined),
    resolveTeam: (teamId) =>
      teamId === binding.teamId
        ? resolution
        : teamId === secondBinding.teamId
          ? secondResolution
          : undefined,
  })

  it('binds a published team and starts a coordinator run', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, options())
    const { sessionId } = manager.create({ projectPath: '/work' })
    const before = published.length

    await manager.setTeam({ sessionId, teamId: binding.teamId })
    expect(published.slice(before)).toMatchObject([
      { type: 'session.team.changed', payload: { team: binding } },
      {
        type: 'run.created',
        payload: {
          agent: { id: 'user.coordinator', version: 2 },
          model: { providerId: 'openai', modelId: 'gpt' },
          limits: { maxStepsPerTurn: 4 },
        },
      },
    ])
    const listed = () => manager.list({}).sessions.find((s) => s.sessionId === sessionId)
    expect(listed()?.team).toEqual(binding)

    // 同一个模板的同一个版本已经在用：不重复发事件。
    const settled = published.length
    await manager.setTeam({ sessionId, teamId: binding.teamId })
    expect(published).toHaveLength(settled)

    // 换成另一个模板但主控相同：只更新绑定，不新建运行。
    const runs = published.filter((event) => event.type === 'run.created').length
    await manager.setTeam({ sessionId, teamId: secondBinding.teamId })
    expect(published.at(-1)).toMatchObject({
      type: 'session.team.changed',
      payload: { team: secondBinding },
    })
    expect(published.filter((event) => event.type === 'run.created')).toHaveLength(runs)
    expect(listed()?.team).toEqual(secondBinding)

    // null 取消绑定，当前 Agent 保持不变；没有绑定时不再发事件。
    await manager.setTeam({ sessionId, teamId: null })
    expect(published.at(-1)).toMatchObject({ type: 'session.team.changed', payload: {} })
    expect(listed()?.team).toBeUndefined()
    const cleared = published.length
    await manager.setTeam({ sessionId, teamId: null })
    expect(published).toHaveLength(cleared)
  })

  it('leaves the team when another agent is chosen', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, options())
    const { sessionId } = manager.create({ projectPath: '/work' })
    await manager.setTeam({ sessionId, teamId: binding.teamId })
    await manager.setAgent({ sessionId, agent: { id: coordinator.id, version: 2 } })
    expect(published.slice(-2)).toMatchObject([
      { type: 'run.created', payload: { agent: { id: 'user.coordinator', version: 2 } } },
      { type: 'session.team.changed', payload: {} },
    ])
  })

  it('stops an idle host so clearing the team takes effect next turn', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, options())
    const { sessionId } = manager.create({ projectPath: '/work' })
    await manager.setTeam({ sessionId, teamId: binding.teamId })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    const host = hosts[0]!
    hostEmits(
      sessionId,
      host.runId,
      ['turn.started', {}, { turnId: 't1' }],
      ['run.state.changed', { from: 'idle', to: 'thinking' }],
    )
    finishTurn(sessionId, host.runId, 't1')

    await manager.setTeam({ sessionId, teamId: null })
    expect(host.stop).toHaveBeenCalled()
  })

  it('restarts idle hosts only for the published team they are bound to', async () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor, options())
    const { sessionId } = manager.create({ projectPath: '/work' })
    await manager.setTeam({ sessionId, teamId: binding.teamId })
    manager.prompt({ sessionId, content: text('hi') })
    await flush()
    const host = hosts[0]!
    hostEmits(
      sessionId,
      host.runId,
      ['turn.started', {}, { turnId: 't1' }],
      ['run.state.changed', { from: 'idle', to: 'thinking' }],
    )
    finishTurn(sessionId, host.runId, 't1')

    manager.refreshTeam('user.other')
    expect(host.stop).not.toHaveBeenCalled()
    manager.refreshTeam(binding.teamId)
    expect(host.stop).toHaveBeenCalled()
  })

  it('rejects unavailable teams, trial sessions and busy sessions', async () => {
    const { supervisor } = fakeSupervisor()
    const { manager } = setup(supervisor, options())
    const { sessionId } = manager.create({ projectPath: '/work' })
    await expect(manager.setTeam({ sessionId, teamId: 'user.missing' })).rejects.toMatchObject({
      code: 'team.unavailable',
    })

    storage.sessions.create({
      sessionId: 'trial-1',
      projectId: storage.projects.list()[0]!.projectId,
      workspacePath: '/work',
      title: '',
      kind: 'trial',
      trialAgentId: coordinator.id,
      trialDraftHash: 'hash',
      trialTeamId: binding.teamId,
    })
    await expect(
      manager.setTeam({ sessionId: 'trial-1', teamId: binding.teamId }),
    ).rejects.toMatchObject({ code: 'team.unavailable' })

    manager.prompt({ sessionId, content: text('hi') })
    await expect(manager.setTeam({ sessionId, teamId: binding.teamId })).rejects.toMatchObject({
      code: 'run.busy',
    })
  })

  it('uses the team-merged definition for delegation targets', async () => {
    const { supervisor } = fakeSupervisor()
    const merged: AgentDefinition = {
      ...coordinator,
      delegation: {
        enabled: true,
        allowedAgents: ['builtin.explorer'],
        maxDepth: 1,
        maxChildrenPerTurn: 2,
        maxParallel: 1,
        childBudgetShare: 0.5,
        defaultWorkspace: 'shared',
        mergeReview: 'user',
      },
    }
    const { manager } = setup(supervisor, {
      ...options(),
      resolveSessionAgent: () => merged,
    })
    const { sessionId } = manager.create({ projectPath: '/work' })
    expect(manager.delegationTargets({ sessionId })).toEqual({
      enabled: true,
      agentIds: ['builtin.explorer'],
    })
  })
})

describe('legacy trial sessions', () => {
  it('hides trial sessions from the default list and rejects new prompts', () => {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor)
    storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work' })
    storage.sessions.create({
      sessionId: 't1',
      projectId: 'p1',
      workspacePath: '/work',
      title: '',
      kind: 'trial',
      trialAgentId: 'user.reviewer',
      trialDraftHash: 'hash-1',
    })
    expect(manager.list({}).sessions).toEqual([])
    expect(() => manager.prompt({ sessionId: 't1', content: text('review') })).toThrow(
      expect.objectContaining({ code: 'run.unsupported' }),
    )
    expect(hosts).toEqual([])
  })

  it('falls back to the default agent for a malformed trial when reading delegation', () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work' })
    storage.sessions.create({
      sessionId: 't2',
      projectId: 'p1',
      workspacePath: '/work',
      title: '',
      kind: 'trial',
    })
    expect(manager.delegationTargets({ sessionId: 't2' })).toEqual({
      enabled: false,
      agentIds: [],
    })
  })
})

describe('edit and regenerate (ADR-0046)', () => {
  /** 两轮完整的问答；返回会话、运行 id、两轮的用户消息事件与最后一条助手消息 id。 */
  async function twoTurns() {
    const { supervisor, hosts } = fakeSupervisor()
    const { manager } = setup(supervisor)
    const { sessionId } = manager.create({ projectPath: '/work' })
    manager.prompt({ sessionId, content: text('第一轮') })
    // 新会话的 runId 由主进程分配并写进用户消息；run.created 随宿主开始这一轮发出。
    const runId = published.find((event) => event.type === 'message.user')!.runId
    await flush()
    startTurn(sessionId, runId, 't1')
    hostEmits(sessionId, runId, [
      'message.assistant.completed',
      { messageId: 'a1', content: text('回复一'), model: defaults.model },
      { turnId: 't1' },
    ])
    finishTurn(sessionId, runId, 't1')

    manager.prompt({ sessionId, content: text('第二轮') })
    await flush()
    startTurn(sessionId, runId, 't2', false)
    hostEmits(sessionId, runId, [
      'message.assistant.completed',
      { messageId: 'a2', content: text('回复二'), model: defaults.model },
      { turnId: 't2' },
    ])
    finishTurn(sessionId, runId, 't2')
    const users = published.filter((event) => event.type === 'message.user')
    return { manager, hosts, sessionId, runId, user1: users[0]!, user2: users[1]! }
  }

  it('编辑用户消息：回退到这一轮开头，重启宿主并用新内容重发', async () => {
    const { manager, hosts, sessionId, user2 } = await twoTurns()
    const edited = manager.editMessage({
      sessionId,
      messageId: user2.payload.messageId,
      content: text('改过的问题'),
    })
    const rewound = published.filter((event) => event.type === 'conversation.rewound').at(-1)
    expect(rewound?.payload).toEqual({ fromSeq: user2.seq, reason: 'edit' })
    expect(edited.messageId).not.toBe(user2.payload.messageId)

    await flush()
    // 旧宿主被停掉，新宿主从事件日志重建历史：只剩第一轮。
    expect(hosts).toHaveLength(2)
    expect(hosts[1]?.init.history).toEqual([
      { role: 'user', content: text('第一轮'), ts: 1_000, turnId: 't1' },
      { role: 'assistant', content: text('回复一'), model: defaults.model, ts: 1_000 },
    ])
    expect(hosts[1]?.prompts).toEqual([edited.messageId])
    expect(hosts[1]?.inputs[0]).toMatchObject({ content: text('改过的问题') })
    expect(published.filter((event) => event.type === 'message.user').at(-1)?.payload).toEqual({
      messageId: edited.messageId,
      content: text('改过的问题'),
    })
  })

  it('重新生成：复用原来的输入和上下文，回退到这一轮开头', async () => {
    const { manager, hosts, sessionId, user2 } = await twoTurns()
    manager.regenerate({ sessionId, messageId: 'a2' })
    const rewound = published.filter((event) => event.type === 'conversation.rewound').at(-1)
    expect(rewound?.payload).toEqual({ fromSeq: user2.seq, reason: 'regenerate' })

    await flush()
    expect(hosts).toHaveLength(2)
    expect(hosts[1]?.init.history).toEqual([
      { role: 'user', content: text('第一轮'), ts: 1_000, turnId: 't1' },
      { role: 'assistant', content: text('回复一'), model: defaults.model, ts: 1_000 },
    ])
    const resent = published.filter((event) => event.type === 'message.user').at(-1)
    expect(resent?.payload).toMatchObject({ content: text('第二轮') })
  })

  it('运行中或目标不是轮次开头时拒绝回退', async () => {
    const { manager, hosts, sessionId, runId, user1 } = await twoTurns()
    manager.prompt({ sessionId, content: text('第三轮') })
    await flush()
    startTurn(sessionId, runId, 't3', false)
    expect(() =>
      manager.editMessage({ sessionId, messageId: user1.payload.messageId, content: text('x') }),
    ).toThrow(expect.objectContaining({ code: 'run.busy' }))
    expect(() => manager.regenerate({ sessionId, messageId: 'a1' })).toThrow(
      expect.objectContaining({ code: 'run.busy' }),
    )
    // 运行中再发一条会成为这一轮的引导；它不是轮次开头，结束后不能作为编辑起点。
    const steer = manager.prompt({ sessionId, content: text('补充') })
    finishTurn(sessionId, runId, 't3')
    expect(() =>
      manager.editMessage({ sessionId, messageId: steer.messageId, content: text('x') }),
    ).toThrow(expect.objectContaining({ code: 'rpc.invalid_params' }))
    expect(() =>
      manager.editMessage({ sessionId, messageId: 'missing', content: text('x') }),
    ).toThrow(expect.objectContaining({ code: 'rpc.invalid_params' }))
    expect(hosts.length).toBeGreaterThan(0)
  })
})

describe('goal mode (ADR-0047)', () => {
  const planContent = {
    goal: '读代码',
    files: ['a.ts'],
    steps: [{ id: 'read', title: '读 a.ts' }],
    risks: '',
    verification: '单测',
    markdown: '1. 读 a.ts',
  }

  async function started(
    extra: Partial<SessionManagerOptions> = {},
    limits: { maxTurns?: number; maxDurationMs?: number } = {},
  ) {
    const fake = fakeSupervisor()
    const { manager, onError } = setup(fake.supervisor, extra)
    const { sessionId } = manager.create({ projectPath: '/work' })
    const goal = await manager.setGoal({ sessionId, condition: '测试全部通过', ...limits })
    await flush()
    return { ...fake, manager, onError, sessionId, goal, host: fake.hosts[0]! }
  }

  it('creates the goal before the first message and injects it into the turn', async () => {
    const { manager, sessionId, host, goal } = await started()
    const created = published.find((event) => event.type === 'goal.created')
    const user = published.find((event) => event.type === 'message.user')
    expect(created?.seq).toBeLessThan(user?.seq ?? 0)
    expect(user).toMatchObject({ payload: { content: text('测试全部通过') } })
    expect(host.inputs[0]).toMatchObject({
      goal: {
        goalId: goal.goalId,
        condition: '测试全部通过',
        limits: { maxTurns: 20, maxDurationMs: 7_200_000 },
        turn: 1,
      },
    })

    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    expect(manager.goalView(sessionId)).toMatchObject({ status: 'active', turnIds: ['t1'] })
    await expect(manager.setGoal({ sessionId, condition: '另一个目标' })).rejects.toMatchObject({
      code: 'goal.exists',
    })
  })

  it('rejects goal commands without an open goal and on unsupported sessions', async () => {
    const { manager } = setup(fakeSupervisor().supervisor)
    const { sessionId } = manager.create({ projectPath: '/work' })
    await expect(manager.pauseGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.not_found',
    })
    await expect(manager.resumeGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.not_found',
    })
    await expect(manager.clearGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.not_found',
    })

    const projectId = storage.projects.list()[0]!.projectId
    storage.sessions.create({
      sessionId: 'trial',
      projectId,
      workspacePath: '/work',
      title: '',
      kind: 'trial',
      trialAgentId: 'a',
      trialDraftHash: 'h',
    })
    await expect(
      manager.setGoal({ sessionId: 'trial', condition: '测试通过' }),
    ).rejects.toMatchObject({ code: 'goal.not_available' })
  })

  it('pauses without stopping the running turn, and resume continues with the next turn number', async () => {
    const { manager, sessionId, host, goal } = await started()
    startTurn(sessionId, host.runId, 't1')
    await manager.pauseGoal({ sessionId })
    await flush()
    expect(host.abort).not.toHaveBeenCalled()
    expect(published.find((event) => event.type === 'goal.paused')).toMatchObject({
      payload: { goalId: goal.goalId, reason: 'user' },
    })
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    expect(manager.goalView(sessionId)).toMatchObject({ status: 'paused', turnIds: ['t1'] })

    const resumed = await manager.resumeGoal({ sessionId })
    await flush()
    expect(resumed.messageId).toBeDefined()
    const continuation = published.filter((event) => event.type === 'message.user').at(-1)
    expect(continuation).toMatchObject({
      payload: { origin: 'goal', goalId: goal.goalId },
    })
    expect(continuation?.payload.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('The goal was paused'),
    })
    expect(host.inputs.at(-1)).toMatchObject({ goal: { turn: 2 } })

    // 已经 active 时 resume 不新建轮次。
    const before = published.filter((event) => event.type === 'message.user').length
    await expect(manager.resumeGoal({ sessionId })).resolves.toEqual({})
    expect(published.filter((event) => event.type === 'message.user')).toHaveLength(before)
  })

  it('pauses goals and stops running sessions when their project is removed', async () => {
    const { manager, sessionId, host, goal } = await started()
    // 同一路径下再建一个空闲会话：移除项目时它没有目标、也没有在跑，不应被中止。
    const idle = manager.create({ projectPath: '/work' })
    startTurn(sessionId, host.runId, 't1')
    const projectId = storage.sessions.get(sessionId)!.projectId
    expect(storage.sessions.get(idle.sessionId)?.projectId).toBe(projectId)
    await manager.stopProjectSessions(projectId)
    expect(manager.goalView(sessionId)).toMatchObject({
      status: 'paused',
      pauseReason: 'project_removed',
    })
    expect(host.abort).toHaveBeenCalledWith('user')
    expect(manager.isBusy(idle.sessionId)).toBe(false)
    expect(published.filter((event) => event.type === 'goal.paused').at(-1)).toMatchObject({
      payload: { goalId: goal.goalId, reason: 'project_removed' },
    })
  })

  it('ends a budget-exhausted resume without starting another turn', async () => {
    const finishGoalBudget = vi.fn()
    const { manager, sessionId, host } = await started({ finishGoalBudget }, { maxTurns: 1 })
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    await manager.pauseGoal({ sessionId })
    await flush()
    const before = published.filter((event) => event.type === 'message.user').length
    await expect(manager.resumeGoal({ sessionId })).resolves.toEqual({})
    expect(finishGoalBudget).toHaveBeenCalledWith(sessionId)
    expect(published.filter((event) => event.type === 'message.user')).toHaveLength(before)
    expect(published.some((event) => event.type === 'goal.ended')).toBe(false)
  })

  it('writes budget ended directly when no final judge is wired', async () => {
    const { manager, sessionId, host } = await started({}, { maxTurns: 1 })
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    await manager.pauseGoal({ sessionId })
    await flush()
    await expect(manager.resumeGoal({ sessionId })).resolves.toEqual({})
    expect(published.find((event) => event.type === 'goal.ended')).toMatchObject({
      payload: { reason: 'budget', turns: 1 },
    })
  })

  it('pauses the goal before a plan turn and never injects it', async () => {
    const { manager, sessionId, host } = await started()
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    manager.prompt({ sessionId, content: text('计划一下'), mode: 'plan' })
    await flush()
    const paused = published.find((event) => event.type === 'goal.paused')
    const planned = published.filter((event) => event.type === 'message.user').at(-1)
    expect(paused).toMatchObject({ payload: { reason: 'plan_mode' } })
    expect(paused?.seq).toBeLessThan(planned?.seq ?? 0)
    expect(host.inputs.at(-1)).not.toHaveProperty('goal')
    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')
    await flush()
    expect(manager.goalView(sessionId)).toMatchObject({
      status: 'paused',
      turnIds: ['t1'],
      pauseReason: 'plan_mode',
    })
  })

  it('pauses on a rewind and the resent turn does not carry the goal', async () => {
    const { manager, sessionId, hosts } = await started()
    const host = hosts[0]!
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    // 编辑目标的首条消息会移除目标；这里编辑之后的一条用户消息，目标保留但暂停。
    const later = manager.prompt({ sessionId, content: text('换个文件先看') })
    await flush()
    startTurn(sessionId, host.runId, 't2', false)
    finishTurn(sessionId, host.runId, 't2')
    await flush()
    manager.editMessage({ sessionId, messageId: later.messageId, content: text('改一下') })
    await flush()
    await flush()
    expect(manager.goalView(sessionId)).toMatchObject({
      status: 'paused',
      pauseReason: 'rewind',
      pauseDetail: 'edit',
    })
    const resent = hosts.at(-1)!.inputs.at(-1)
    expect(resent).not.toHaveProperty('goal')
    expect(
      published.filter((event) => event.type === 'message.user').at(-1)?.payload,
    ).not.toHaveProperty('origin')
  })

  it('never steers a goal continuation into a running turn', async () => {
    const { manager, sessionId, host, goal } = await started()
    startTurn(sessionId, host.runId, 't1')
    const before = published.filter((event) => event.type === 'message.user').length
    expect(manager.canAutoContinue(sessionId)).toBe(false)
    expect(manager.promptGoal(sessionId, { text: '继续', goalId: goal.goalId })).toBeUndefined()
    expect(published.filter((event) => event.type === 'message.user')).toHaveLength(before)
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    expect(manager.canAutoContinue(sessionId)).toBe(true)
  })

  it('pauses an active goal when the user stops with nothing running', async () => {
    const { manager, sessionId, host } = await started()
    startTurn(sessionId, host.runId, 't1')
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    await manager.abort({ sessionId })
    expect(published.filter((event) => event.type === 'goal.paused')).toMatchObject([
      { payload: { reason: 'user' } },
    ])
  })

  it('rejects set and resume while a plan is pending', async () => {
    const { manager, sessionId, host } = await started()
    startTurn(sessionId, host.runId, 't1')
    hostEmits(sessionId, host.runId, [
      'plan.proposed',
      { planId: 'pl1', content: planContent },
      { turnId: 't1' },
    ])
    finishTurn(sessionId, host.runId, 't1')
    await flush()
    await manager.pauseGoal({ sessionId })
    await expect(manager.resumeGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.plan_pending',
    })

    const freshFake = fakeSupervisor()
    const fresh = setup(freshFake.supervisor).manager
    const other = fresh.create({ projectPath: '/other' }).sessionId
    fresh.prompt({ sessionId: other, content: text('计划'), mode: 'plan' })
    await flush()
    const otherHost = freshFake.hosts[0]!
    startTurn(other, otherHost.runId, 't1')
    hostEmits(other, otherHost.runId, [
      'plan.proposed',
      { planId: 'pl2', content: planContent },
      { turnId: 't1' },
    ])
    finishTurn(other, otherHost.runId, 't1')
    await flush()
    await expect(fresh.setGoal({ sessionId: other, condition: '测试通过' })).rejects.toMatchObject({
      code: 'goal.plan_pending',
    })
  })

  it('clears the goal and stays idempotent', async () => {
    const { manager, sessionId } = await started()
    await expect(manager.clearGoal({ sessionId })).resolves.toEqual({})
    expect(published.find((event) => event.type === 'goal.ended')).toMatchObject({
      payload: { reason: 'user', turns: 0 },
    })
    await expect(manager.clearGoal({ sessionId })).resolves.toEqual({})
    await expect(manager.pauseGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.not_found',
    })
    await expect(manager.resumeGoal({ sessionId })).rejects.toMatchObject({
      code: 'goal.not_found',
    })
  })

  it('updates the open goal condition without requiring idle', async () => {
    const { manager, sessionId } = await started()
    await expect(
      manager.updateGoalCondition({ sessionId, condition: '改成新条件' }),
    ).resolves.toEqual({})
    expect(published.find((event) => event.type === 'goal.condition_updated')).toMatchObject({
      payload: { condition: '改成新条件' },
    })
    expect(manager.goalView(sessionId)?.condition).toBe('改成新条件')
    const before = published.length
    await expect(
      manager.updateGoalCondition({ sessionId, condition: '改成新条件' }),
    ).resolves.toEqual({})
    expect(published.length).toBe(before)
    await manager.clearGoal({ sessionId })
    await expect(
      manager.updateGoalCondition({ sessionId, condition: '再改' }),
    ).rejects.toMatchObject({ code: 'goal.not_found' })
  })
})
