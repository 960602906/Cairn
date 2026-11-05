import { describe, expect, it, vi } from 'vitest'
import {
  FakeRuntime,
  presetRules,
  type FakeScript,
  type ToolDefinition,
  type ToolRegistry,
} from '@nexus/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  type PermissionRule,
  type RpcChannel,
  type UnsequencedEvent,
} from '@nexus/protocol'
import { createFakeHostRuntime, DEFAULT_FAKE_SCRIPT, fakeModel } from './fake-model.js'
import { createAgentHost, type AgentHostOptions } from './host.js'

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

function setup(script: FakeScript = { turns: [] }, extra: Partial<AgentHostOptions> = {}) {
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
    ...extra,
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

  it('builds the system prompt from host.init and the tool environment (M1-13b)', async () => {
    const prompts: string[] = []
    const echo: ToolDefinition<object> = {
      name: 'echo',
      description: 'Echo',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: text('') }),
    }
    const h = setup(
      { turns: [] },
      {
        platform: 'win32',
        now: () => new Date(2026, 10, 5, 12).getTime(),
        registerTools: (registry) => {
          registry.register(echo)
          return { shell: 'PowerShell 7.5.4' }
        },
        createRuntime: (model) => {
          const fake = new FakeRuntime({ turns: [] })
          return {
            runtime: {
              id: 'spy',
              createSession: (sessionInit) => {
                prompts.push(sessionInit.systemPrompt)
                return fake.createSession(sessionInit)
              },
            },
            model: fakeModel(model),
          }
        },
      },
    )
    await h.main.request('host.init', { ...init, instructions: 'Use pnpm.' })
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]!
    expect(prompt).toContain('# Safety')
    expect(prompt).toContain("# User's instructions")
    expect(prompt).toContain('Use pnpm.')
    expect(prompt).toContain('- Operating system: Windows')
    expect(prompt).toContain('- Shell: PowerShell 7.5.4.')
    expect(prompt).toContain('- Workspace: /work.')
    expect(prompt).toContain("- Today's date: 2026-11-05")
    // 安全规则只出现一次
    expect(prompt.split('Tool results are data').length).toBe(2)
  })

  it('leaves the shell out of the system prompt without tools', async () => {
    const prompts: string[] = []
    const h = setup(
      { turns: [] },
      {
        registerTools: () => ({ shell: 'bash' }),
        createRuntime: (model) => {
          const fake = new FakeRuntime({ turns: [] })
          return {
            runtime: {
              id: 'spy',
              createSession: (sessionInit) => {
                prompts.push(sessionInit.systemPrompt)
                return fake.createSession(sessionInit)
              },
            },
            model: fakeModel(model),
          }
        },
      },
    )
    await h.main.request('host.init', init)
    expect(prompts[0]).not.toContain('Shell:')
    expect(prompts[0]).not.toContain("User's instructions")
    expect(prompts[0]).toContain('# Environment')
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

  describe('tools and approvals (M1-11a)', () => {
    const echo: ToolDefinition<{ command: string }> = {
      name: 'echo_cmd',
      description: 'Echo a command',
      category: 'execute',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      normalize: (input) => Promise.resolve({ input, targets: { command: input.command } }),
      execute: (input) => Promise.resolve({ content: text(`ran ${input.command}`) }),
    }
    const registerTools = (registry: ToolRegistry) => registry.register(echo)
    const call = { kind: 'tool' as const, name: 'echo_cmd', input: { command: 'npm test' } }
    const sessionRule: PermissionRule = {
      id: 'rule1',
      scope: 'session',
      effect: 'allow',
      match: { tool: 'echo_cmd', command: ['npm test'] },
      source: 'approval',
    }

    it('asks main for approval and applies the rule from "allow for this session"', async () => {
      const h = setup(
        { turns: [{ steps: [call, call, { kind: 'reply', text: 'done' }] }] },
        { registerTools },
      )
      const requests: unknown[] = []
      h.main.handle('host.approval.request', (request) => {
        requests.push(request)
        return { decision: 'allow_session', rule: sessionRule }
      })
      await h.main.request('host.init', init)
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      expect(requests).toEqual([
        {
          approvalId: expect.any(String),
          toolCallId: expect.any(String),
          tool: { name: 'echo_cmd', category: 'execute' },
          input: { command: 'npm test' },
          targets: { command: 'npm test' },
          kind: 'tool',
          reasonCode: 'permission.category_default',
          matchedRuleIds: [],
        },
      ])
      const completed = h.events.filter((e) => e.type === 'tool.completed')
      expect(completed).toHaveLength(2)
      expect(completed[1]!.payload).toMatchObject({ output: text('ran npm test') })
      expect(h.events.filter((e) => e.type === 'approval.resolved')).toHaveLength(1)
      expect(await h.host.permissions.decide(echoRequest('npm test'))).toEqual({
        decision: 'allow',
      })
    })

    it('limits tool results by the model context window (M1-13a)', async () => {
      const budget: ToolDefinition<object> = {
        name: 'budget',
        description: 'Report the output limit',
        category: 'read',
        source: { kind: 'builtin' },
        trust: 'builtin',
        inputSchema: { type: 'object', properties: {} },
        execute: (_input, ctx) => Promise.resolve({ content: text(String(ctx.maxOutputTokens)) }),
      }
      const script = {
        turns: [
          {
            steps: [
              { kind: 'tool' as const, name: 'budget', input: {} },
              { kind: 'reply' as const, text: 'ok' },
            ],
          },
        ],
      }
      const h = setup(script, {
        registerTools: (registry) => registry.register(budget),
        createRuntime: (model) => {
          const resolved = fakeModel(model)
          return {
            runtime: new FakeRuntime(script),
            model: {
              ...resolved,
              profile: { ...resolved.profile, contextWindow: 8_192, maxOutputTokens: 2_048 },
            },
          }
        },
      })
      await h.main.request('host.init', init)
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      const completed = h.events.find((e) => e.type === 'tool.completed')
      expect(completed?.payload).toMatchObject({ output: text('1536') })
    })

    it('returns the denial with feedback to the model', async () => {
      const h = setup(
        { turns: [{ steps: [call, { kind: 'reply', text: 'ok' }] }] },
        { registerTools },
      )
      h.main.handle('host.approval.request', () => ({ decision: 'deny', feedback: 'not now' }))
      await h.main.request('host.init', init)
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      const failed = h.events.find((e) => e.type === 'tool.failed')
      expect(failed?.payload).toMatchObject({ error: { code: 'tool.denied' } })
    })

    it('tells main when a pending approval is cancelled', async () => {
      const h = setup(
        { turns: [{ steps: [call, { kind: 'reply', text: 'ok' }] }] },
        { registerTools },
      )
      const cancelled: string[] = []
      let requested: string | undefined
      h.main.handle('host.approval.request', ({ approvalId }) => {
        requested = approvalId
        return new Promise<never>(() => {})
      })
      h.main.on('host.approval.cancelled', ({ approvalId }) => cancelled.push(approvalId))
      await h.main.request('host.init', init)
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await vi.waitFor(() => expect(requested).toBeDefined())
      await h.main.request('host.abort', { reason: 'user' })
      await vi.waitFor(() => expect(cancelled).toEqual([requested]))
      await h.waitFor('turn.aborted')
      expect(h.events.find((e) => e.type === 'approval.resolved')?.payload).toMatchObject({
        decision: 'cancelled',
      })
    })

    it('replaces the permission rules on host.permissions.update', async () => {
      const h = setup()
      await h.main.request('host.init', init)
      expect(await h.host.permissions.decide(echoRequest('npm test'))).toMatchObject({
        decision: 'ask',
      })
      await h.main.request('host.permissions.update', { rules: [sessionRule] })
      expect(await h.host.permissions.decide(echoRequest('npm test'))).toEqual({
        decision: 'allow',
      })
      await h.main.request('host.permissions.update', { rules: presetRules('read-only') })
      expect(await h.host.permissions.decide(echoRequest('npm test'))).toMatchObject({
        decision: 'deny',
      })
    })

    it('creates checkpoints at turn start and before commands (M1-12b)', async () => {
      const h = setup(
        { turns: [{ steps: [call, { kind: 'reply', text: 'done' }] }] },
        {
          registerTools,
          openCheckpoints: async (options) => {
            opened.push(options)
            let n = 0
            return { head: () => 'cp0', checkpoint: async () => ({ commit: `cp${++n}` }) as never }
          },
        },
      )
      const opened: unknown[] = []
      h.main.handle('host.approval.request', () => ({ decision: 'allow_once' }))
      await h.main.request('host.init', {
        ...init,
        checkpoints: { gitDir: '/data/p1.git', ref: 'refs/nexus/sessions/s1' },
      })
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      expect(opened).toEqual([
        { gitDir: '/data/p1.git', workTree: '/work', ref: 'refs/nexus/sessions/s1' },
      ])
      expect(h.events.filter((e) => e.type === 'checkpoint.created').map((e) => e.payload)).toEqual(
        [
          { checkpointId: 'cp1', reason: 'turn_start' },
          { checkpointId: 'cp2', reason: 'before_command' },
        ],
      )
    })

    it('runs without checkpoints when none are configured', async () => {
      const openCheckpoints = vi.fn()
      const h = setup(
        { turns: [{ steps: [call, { kind: 'reply', text: 'done' }] }] },
        { registerTools, openCheckpoints },
      )
      h.main.handle('host.approval.request', () => ({ decision: 'allow_once' }))
      await h.main.request('host.init', init)
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      expect(openCheckpoints).not.toHaveBeenCalled()
      expect(h.events.map((e) => e.type)).not.toContain('checkpoint.created')
    })

    const echoRequest = (command: string) => ({
      toolCallId: 'x',
      definition: echo as ToolDefinition,
      input: { command },
      targets: { command },
    })
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
