import { describe, expect, it, vi } from 'vitest'
import { FakeRuntime, presetRules, type FakeScript } from '@nexus/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  type RpcChannel,
  type UnsequencedEvent,
} from '@nexus/protocol'
import { createFakeHostRuntime, DEFAULT_FAKE_SCRIPT, fakeModel } from './fake-model.js'
import { createAgentHost } from './host.js'

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

const init = {
  sessionId: 's1',
  runId: 'r1',
  workspacePath: '/work',
  agent: { id: 'default', version: 1 },
  model: { providerId: 'fake', modelId: 'fake-1' },
  mode: 'interactive' as const,
  limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
  history: [],
}

function setup(script: FakeScript = { turns: [] }) {
  const [mainSide, hostSide] = channelPair()
  const exit = vi.fn()
  const onError = vi.fn()
  const credentials: unknown[] = []
  const modelConfigs: unknown[] = []
  let id = 0
  const host = createAgentHost({
    channel: hostSide,
    createRuntime: (model, credential, modelConfig) => {
      credentials.push(credential)
      modelConfigs.push(modelConfig)
      return { runtime: new FakeRuntime(script), model: fakeModel(model) }
    },
    exit,
    createId: () => `id${++id}`,
    now: () => 7,
    onError,
  })
  const main = createEndpoint(mainSide, { local: MainForHost, remote: HostForMain })
  const events: UnsequencedEvent[] = []
  main.on('host.event', ({ event }) => events.push(event))
  const waitFor = async (type: string) => {
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type))
  }
  return { main, events, exit, onError, waitFor, credentials, modelConfigs, host }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]

describe('agent host', () => {
  it('passes the credential from host.init to the runtime factory', async () => {
    const withKey = setup()
    await withKey.main.request('host.init', { ...init, credential: { apiKey: 'secret-key-value' } })
    expect(withKey.credentials).toEqual([{ apiKey: 'secret-key-value' }])
    expect(JSON.stringify(withKey.events)).not.toContain('secret-key-value')

    const without = setup()
    await without.main.request('host.init', init)
    expect(without.credentials).toEqual([undefined])
    expect(without.modelConfigs).toEqual([undefined])
  })

  it('passes the model config from host.init to the runtime factory', async () => {
    const modelConfig = {
      kind: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      profile: {
        id: 'claude-sonnet-5-5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: true,
      },
    }
    const host = setup()
    await host.main.request('host.init', { ...init, modelConfig })
    expect(host.modelConfigs).toEqual([modelConfig])
  })

  it('decides tool calls with the permission rules from host.init', async () => {
    const definition = {
      name: 'run_command',
      description: 'Run a command',
      category: 'execute' as const,
      inputSchema: { type: 'object' },
      execute: () => Promise.resolve({ content: [] }),
    }
    const request = (command: string) => ({
      definition,
      input: { command },
      targets: { command },
      toolCallId: 'call1',
    })
    const decide = (h: ReturnType<typeof setup>, command: string) =>
      h.host.permissions.decide(request(command) as never)

    // 没有下发规则：按“询问”模式的预设
    const defaults = setup()
    expect(await decide(defaults, 'npm test')).toMatchObject({ decision: 'ask' })
    await defaults.main.request('host.init', init)
    expect(await decide(defaults, 'npm test')).toMatchObject({ decision: 'ask' })

    const ruled = setup()
    await ruled.main.request('host.init', {
      ...init,
      permissionRules: [
        ...presetRules('ask'),
        {
          id: 'r1',
          scope: 'session',
          effect: 'allow',
          match: { tool: 'run_command', command: ['npm test'] },
          source: 'approval',
        },
      ],
    })
    expect(await decide(ruled, 'npm test')).toEqual({ decision: 'allow' })
    expect(await decide(ruled, 'npm run build')).toMatchObject({ decision: 'ask' })
    // 强制拦截不能被规则覆盖
    expect(await decide(ruled, 'rm -rf /')).toMatchObject({ decision: 'deny' })
  })

  it('creates a run and answers prompts with events', async () => {
    const { main, events, waitFor } = setup()
    await main.request('host.init', init)
    expect(events.map((e) => e.type)).toEqual(['run.created'])
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      runId: 'r1',
      payload: { limits: init.limits },
    })

    await main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await waitFor('turn.completed')
    const completed = events.find((e) => e.type === 'message.assistant.completed')
    expect(completed?.payload).toMatchObject({ content: text('hi') })
    expect(events.filter((e) => e.type === 'message.user')).toEqual([])
    await expect(main.request('host.heartbeat', {})).resolves.toEqual({ ts: 7 })
  })

  it('resumes an existing run from history without run.created', async () => {
    const { main, events, waitFor } = setup()
    await main.request('host.init', {
      ...init,
      history: [{ role: 'user', content: text('earlier'), ts: 1 }],
      resume: { state: 'thinking' },
    })
    expect(events).toEqual([])
    await main.request('host.prompt', { messageId: 'm2', content: text('again') })
    await waitFor('turn.completed')
    expect(events.find((e) => e.type === 'run.state.changed')?.payload).toMatchObject({
      from: 'interrupted',
      to: 'thinking',
    })
  })

  it('rejects requests before init and a second init', async () => {
    const { main } = setup()
    await expect(
      main.request('host.prompt', { messageId: 'm1', content: text('hi') }),
    ).rejects.toMatchObject({ code: 'host.not_initialized' })
    await expect(main.request('host.abort', { reason: 'user' })).rejects.toMatchObject({
      code: 'host.not_initialized',
    })
    await main.request('host.init', init)
    await expect(main.request('host.init', init)).rejects.toMatchObject({
      code: 'host.already_initialized',
    })
  })

  it('aborts the current turn', async () => {
    const { main, events, waitFor } = setup({ turns: [], delayMs: 5 })
    await main.request('host.init', init)
    await main.request('host.prompt', { messageId: 'm1', content: text('a long reply') })
    await waitFor('message.assistant.delta')
    await main.request('host.abort', { reason: 'user' })
    await waitFor('turn.aborted')
    expect(events.find((e) => e.type === 'turn.aborted')?.payload).toEqual({ reason: 'user' })
  })

  it('aborts with reason shutdown, replies and then exits', async () => {
    const { main, events, exit, waitFor } = setup({ turns: [], delayMs: 5 })
    await main.request('host.init', init)
    await main.request('host.prompt', { messageId: 'm1', content: text('a long reply') })
    await waitFor('message.assistant.delta')
    await expect(main.request('host.shutdown', {})).resolves.toEqual({})
    expect(events.find((e) => e.type === 'turn.aborted')?.payload).toEqual({ reason: 'shutdown' })
    expect(events.map((e) => e.type)).not.toContain('run.disposed')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it('exits on shutdown before init', async () => {
    const { main, exit } = setup()
    await main.request('host.shutdown', {})
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})

describe('fake model', () => {
  it('builds the default fake runtime', () => {
    const { runtime, model } = createFakeHostRuntime({ providerId: 'fake', modelId: 'm' })
    expect(runtime.id).toBe('fake')
    expect(model).toMatchObject({
      ref: { providerId: 'fake', modelId: 'm' },
      providerKind: 'openai',
    })
    expect(DEFAULT_FAKE_SCRIPT.delayMs).toBeGreaterThan(0)
  })
})
