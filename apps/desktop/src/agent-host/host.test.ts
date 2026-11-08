import { describe, expect, it, vi } from 'vitest'
import {
  FakeRuntime,
  presetRules,
  type FakeScript,
  type ToolDefinition,
  type ToolRegistry,
} from '@cairn/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type PermissionRule,
  type RpcChannel,
  type UnsequencedEvent,
} from '@cairn/protocol'
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

const echoTool: ToolDefinition<object> = {
  name: 'echo',
  description: 'Echo',
  category: 'read',
  source: { kind: 'builtin' },
  trust: 'builtin',
  inputSchema: { type: 'object', properties: {} },
  execute: () => Promise.resolve({ content: text('') }),
}

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

  it('asks the main process for AGENTS.md at the start of a turn (M3-02)', async () => {
    const prompts: string[] = []
    const script: FakeScript = { turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }
    const h = setup(script, {
      createRuntime: (model) => {
        const fake = new FakeRuntime(script)
        return {
          runtime: {
            id: 'spy',
            async createSession(sessionInit) {
              const session = await fake.createSession(sessionInit)
              return {
                prompt: (input: Parameters<typeof session.prompt>[0]) => session.prompt(input),
                steer: (input: Parameters<typeof session.steer>[0]) => session.steer(input),
                abort: () => session.abort(),
                onEvent: (listener: Parameters<typeof session.onEvent>[0]) =>
                  session.onEvent(listener),
                exportHistory: () => session.exportHistory(),
                dispose: () => session.dispose(),
                setSystemPrompt(prompt: string) {
                  prompts.push(prompt)
                },
              }
            },
          },
          model: fakeModel(model),
        }
      },
    })
    const agentsMd = { sha256: 'c'.repeat(64), bytes: 9, truncated: false, lines: 1 }
    h.main.handle('host.agentsMd', () => ({ text: 'Use tabs.', context: { agentsMd } }))
    await h.main.request('host.init', init)
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(
      prompts.some(
        (prompt) =>
          prompt.includes('# Project instructions (AGENTS.md)') && prompt.includes('Use tabs.'),
      ),
    ).toBe(true)
    expect(h.events.find((event) => event.type === 'turn.started')?.payload).toEqual({
      context: { agentsMd },
    })
    expect(h.onError).not.toHaveBeenCalled()
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

  it('passes the shell preference from host.init to registerTools (M2-09)', async () => {
    const registerTools = vi.fn(() => undefined)
    const h = setup({ turns: [] }, { registerTools })
    await h.main.request('host.init', { ...init, shell: 'cmd' })
    expect(registerTools).toHaveBeenCalledWith(expect.anything(), init.workspacePath, 'cmd')
    const other = setup({ turns: [] }, { registerTools })
    await other.main.request('host.init', init)
    expect(registerTools).toHaveBeenLastCalledWith(expect.anything(), init.workspacePath, 'auto')
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
          runId: 'r1',
          agent: { id: 'default', version: 1 },
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
        checkpoints: { gitDir: '/data/p1.git', ref: 'refs/cairn/sessions/s1' },
      })
      await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
      await h.waitFor('turn.completed')
      expect(opened).toEqual([
        { gitDir: '/data/p1.git', workTree: '/work', ref: 'refs/cairn/sessions/s1' },
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

  it('registers MCP tools from host.init and calls main for execution (M3-09)', async () => {
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool' as const, name: 'mcp_fixture_echo', input: { text: 'hi' } },
            { kind: 'reply' as const, text: 'done' },
          ],
        },
      ],
    }
    const h = setup(script)
    const calls: unknown[] = []
    h.main.handle('host.mcp.call', (params) => {
      calls.push(params)
      return { text: 'echo:hi', isError: false }
    })
    h.main.handle('host.approval.request', () => ({ decision: 'allow_once' as const }))
    await h.main.request('host.init', {
      ...init,
      mcpTools: [
        {
          name: 'mcp_fixture_echo',
          description: 'Echo',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          serverId: 'fixture',
          originalName: 'echo',
          category: 'network',
        },
      ],
    })
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('turn.completed')
    expect(calls).toEqual([
      {
        serverId: 'fixture',
        toolName: 'echo',
        input: { text: 'hi' },
        maxOutputTokens: expect.any(Number),
      },
    ])
    const completed = h.events.filter((e) => e.type === 'tool.completed')
    expect(completed[0]?.payload).toMatchObject({ output: text('echo:hi') })
  })

  it('skips an MCP tool whose name conflicts with a builtin', async () => {
    const echo: ToolDefinition<object> = {
      name: 'mcp_fixture_echo',
      description: 'Builtin',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: text('') }),
    }
    const h = setup({ turns: [] }, { registerTools: (registry) => registry.register(echo) })
    await h.main.request('host.init', {
      ...init,
      mcpTools: [
        {
          name: 'mcp_fixture_echo',
          description: 'MCP',
          inputSchema: { type: 'object', properties: {} },
          serverId: 'fixture',
          originalName: 'echo',
          category: 'network',
        },
      ],
    })
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/conflicts/) }),
    )
  })

  it('uses a fallback description and reports MCP tool errors (M3-09)', async () => {
    const h = setup({
      turns: [
        {
          steps: [
            { kind: 'tool' as const, name: 'mcp_fixture_blank', input: {} },
            { kind: 'reply' as const, text: 'done' },
          ],
        },
      ],
    })
    h.main.handle('host.mcp.call', () => ({ text: 'boom', isError: true }))
    h.main.handle('host.approval.request', () => ({ decision: 'allow_once' as const }))
    await h.main.request('host.init', {
      ...init,
      mcpTools: [
        {
          name: 'mcp_fixture_blank',
          description: '',
          inputSchema: { type: 'object', properties: {} },
          serverId: 'fixture',
          originalName: 'blank',
          category: 'network',
        },
      ],
    })
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('turn.completed')
    expect(h.events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      error: { code: 'tool.execution_failed' },
    })
  })

  it('puts agent instructions in the system prompt and hides unselected tools (M3-11)', async () => {
    const readTool: ToolDefinition<object> = {
      name: 'read_file',
      description: 'Read',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: text('') }),
    }
    const writeTool: ToolDefinition<object> = {
      name: 'write_file',
      description: 'Write',
      category: 'write',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: text('') }),
    }
    const prompts: string[] = []
    const toolNames: string[][] = []
    const h = setup(
      { turns: [] },
      {
        registerTools: (registry) => {
          registry.register(readTool)
          registry.register(writeTool)
        },
        createRuntime: (model) => {
          const fake = new FakeRuntime({ turns: [] })
          return {
            runtime: {
              id: 'spy',
              createSession: (sessionInit) => {
                prompts.push(sessionInit.systemPrompt)
                toolNames.push((sessionInit.tools ?? []).map((tool) => tool.name))
                return fake.createSession(sessionInit)
              },
            },
            model: fakeModel(model),
          }
        },
      },
    )
    await h.main.request('host.init', {
      ...init,
      agentDefinition: {
        id: 'user.reviewer',
        version: 1,
        source: 'user',
        status: 'published',
        name: { 'en-US': 'Reviewer' },
        description: { 'en-US': 'Read-only' },
        instructions: 'Only review, never edit.',
        model: { mode: 'inherit' },
        tools: { allow: ['read_file'] },
        skills: { allow: [] },
        permissions: 'ask',
        limits: {},
        context: { includeProjectInstructions: true, compaction: 'auto' },
        memory: { scopes: ['session'], write: 'never' },
        createdAt: 0,
        updatedAt: 0,
        schemaVersion: 1,
      },
    })
    expect(prompts[0]).toContain('Only review, never edit.')
    expect(toolNames[0]).toContain('read_file')
    expect(toolNames[0]).not.toContain('write_file')
  })

  it('skips the project instructions when the agent disables them (M3-11)', async () => {
    const requests: string[] = []
    const h = setup()
    h.main.handle('host.agentsMd', () => {
      requests.push('agentsMd')
      return {
        text: 'never',
        context: { agentsMd: { sha256: 'a'.repeat(64), bytes: 1, truncated: false, lines: 1 } },
      }
    })
    await h.main.request('host.init', {
      ...init,
      agentDefinition: {
        id: 'user.quiet',
        version: 1,
        source: 'user',
        status: 'published',
        name: { 'en-US': 'Quiet' },
        description: { 'en-US': 'No project instructions' },
        instructions: '',
        model: { mode: 'inherit' },
        tools: { allow: ['*'] },
        skills: { allow: [] },
        permissions: 'ask',
        limits: {},
        context: { includeProjectInstructions: false, compaction: 'auto' },
        memory: { scopes: ['session'], write: 'never' },
        createdAt: 0,
        updatedAt: 0,
        schemaVersion: 1,
      },
    })
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(requests).toEqual([])
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

  it('keeps plan mode read-only and ends the turn after propose_plan (M3-05)', async () => {
    const plan = {
      goal: '读代码',
      files: ['src/a.ts'],
      steps: [{ id: 'read', title: '读 src/a.ts' }],
      risks: '',
      verification: '单测通过',
      markdown: '1. 读代码',
    }
    const write: ToolDefinition = {
      name: 'write_note',
      description: 'Write a note',
      category: 'write',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object' },
      execute: () => Promise.resolve({ content: text('wrote') }),
    }
    const h = setup(
      {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_note', input: {} },
              { kind: 'tool', name: 'propose_plan', input: plan },
              { kind: 'reply', text: 'should-not-run' },
            ],
          },
        ],
      },
      { registerTools: (registry) => registry.register(write) },
    )
    await h.main.request('host.init', { ...init, permissionRules: presetRules('auto') })
    await h.main.request('host.prompt', {
      messageId: 'm1',
      content: text('计划一下'),
      mode: 'plan',
    })
    await h.waitFor('turn.completed')
    expect(h.events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      error: {
        code: 'tool.denied',
        params: { reason: expect.stringContaining('Plan mode is read-only') },
      },
    })
    expect(h.events.some((event) => event.type === 'plan.proposed')).toBe(true)
    expect(JSON.stringify(h.events)).not.toContain('should-not-run')
    expect(h.events.filter((event) => event.type === 'step.started')).toHaveLength(2)
  })

  it('puts the skill index in the prompt and records load_skill (M3-07)', async () => {
    const prompts: string[] = []
    const tail = 'TAIL-MARKER'
    const body = `${'x'.repeat(32 * 1024)}${tail}`
    const sha = 'ab'.repeat(32)
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'load_skill', input: { name: 'house' } },
            { kind: 'reply', text: 'done' },
          ],
        },
      ],
    }
    const echo: ToolDefinition<object> = {
      name: 'echo',
      description: 'Echo',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: text('') }),
    }
    const h = setup(script, {
      registerTools: (registry) => registry.register(echo),
      createRuntime: (model) => {
        const fake = new FakeRuntime(script)
        return {
          runtime: {
            id: 'spy',
            async createSession(sessionInit) {
              const session = await fake.createSession(sessionInit)
              return {
                prompt: (input: Parameters<typeof session.prompt>[0]) => session.prompt(input),
                steer: (input: Parameters<typeof session.steer>[0]) => session.steer(input),
                abort: () => session.abort(),
                onEvent: (listener: Parameters<typeof session.onEvent>[0]) =>
                  session.onEvent(listener),
                exportHistory: () => session.exportHistory(),
                dispose: () => session.dispose(),
                setSystemPrompt(prompt: string) {
                  prompts.push(prompt)
                },
              }
            },
          },
          model: fakeModel(model),
        }
      },
    })
    h.main.handle('host.skills', () => ({
      skills: [
        {
          name: 'example',
          description: 'Built in.',
          sha256: sha,
          source: 'builtin' as const,
          pinned: false,
          root: '/skills/example',
          body: 'example body',
          hasScripts: false,
          files: [],
        },
        {
          name: 'house',
          description: 'House style.',
          sha256: sha,
          source: 'user' as const,
          pinned: true,
          root: '/skills/house',
          body,
          hasScripts: false,
          files: [],
        },
        {
          name: 'tiny',
          description: 'Short pinned skill.',
          sha256: sha,
          source: 'user' as const,
          pinned: true,
          root: '/skills/tiny',
          body: 'tiny body',
          hasScripts: false,
          files: [],
          filesTruncated: true,
        },
      ],
    }))
    await h.main.request('host.init', init)
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    const prompt = prompts.at(-1) ?? ''
    expect(prompt).toContain('# Skills')
    expect(prompt).toContain('- example: Built in.')
    expect(prompt).toContain('# Pinned skills')
    expect(prompt).toContain('## house')
    expect(prompt).toContain('## tiny')
    expect(prompt).toContain('tiny body')
    expect(prompt).toContain('Call load_skill to read the rest.')
    expect(prompt).not.toContain(tail)
    expect(prompt.indexOf('# Skills')).toBeLessThan(prompt.indexOf('# Environment'))
    expect(h.events.find((event) => event.type === 'tool.completed')?.payload).toMatchObject({
      skill: { name: 'house', sha256: sha },
    })
    expect(JSON.stringify(h.events)).toContain(tail)
  })

  it('continues a turn when the skill index cannot be loaded (M3-07)', async () => {
    const script: FakeScript = { turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }
    const h = setup(script)
    h.main.handle('host.skills', () => {
      throw new Error('skills down')
    })
    await h.main.request('host.init', init)
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(h.onError).toHaveBeenCalled()
  })

  it('continues a turn when AGENTS.md cannot be loaded (M3-02)', async () => {
    const h = setup({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] })
    h.main.handle('host.agentsMd', () => {
      throw new Error('agents md down')
    })
    await h.main.request('host.init', init)
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(h.onError).toHaveBeenCalled()
  })

  it('reads the session brief and tolerates missing or failing ones (M3-04)', async () => {
    const prompts: string[] = []
    const script: FakeScript = { turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] }
    const h = setup(script, {
      createRuntime: (model) => {
        const fake = new FakeRuntime(script)
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
    })
    h.main.handle('host.sessionBrief', () => ({ text: 'The user wants tests.' }))
    await h.main.request('host.init', init)
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(prompts).toHaveLength(1)
    expect(h.onError).not.toHaveBeenCalled()

    const missing = setup({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] })
    missing.main.handle('host.sessionBrief', () => ({}))
    await missing.main.request('host.init', init)
    await missing.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await missing.waitFor('turn.completed')
    expect(missing.onError).not.toHaveBeenCalled()

    const broken = setup({ turns: [{ steps: [{ kind: 'reply', text: 'ok' }] }] })
    broken.main.handle('host.sessionBrief', () => {
      throw new Error('brief down')
    })
    await broken.main.request('host.init', init)
    await broken.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await broken.waitFor('turn.completed')
    expect(broken.onError).toHaveBeenCalled()
  })

  it('summarizes history on host.compact and tolerates failures (M3-03)', async () => {
    const history = [
      { role: 'user' as const, content: text('first'), ts: 1 },
      {
        role: 'assistant' as const,
        content: text('one'),
        model: { providerId: 'fake', modelId: 'fake-1' },
        ts: 2,
      },
      { role: 'user' as const, content: text('second'), ts: 3 },
      {
        role: 'assistant' as const,
        content: text('two'),
        model: { providerId: 'fake', modelId: 'fake-1' },
        ts: 4,
      },
      { role: 'user' as const, content: text('third'), ts: 5 },
      {
        role: 'assistant' as const,
        content: text('three'),
        model: { providerId: 'fake', modelId: 'fake-1' },
        ts: 6,
      },
    ]
    const ok = setup()
    const transcripts: string[] = []
    ok.main.handle('host.summarize', ({ transcript }) => {
      transcripts.push(transcript)
      return { text: 'Summary.' }
    })
    await ok.main.request('host.init', { ...init, history, resume: { state: 'idle' } })
    await expect(ok.main.request('host.compact', {})).resolves.toEqual({ compacted: true })
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]).toContain('first')
    expect(ok.events.some((event) => event.type === 'context.compacted')).toBe(true)
    expect(ok.onError).not.toHaveBeenCalled()

    const broken = setup()
    broken.main.handle('host.summarize', () => {
      throw new RpcError('provider.error', { provider: 'fake' })
    })
    await broken.main.request('host.init', { ...init, history, resume: { state: 'idle' } })
    await expect(broken.main.request('host.compact', {})).resolves.toEqual({ compacted: false })
    expect(broken.onError).toHaveBeenCalled()

    const missing = setup()
    await missing.main.request('host.init', { ...init, history, resume: { state: 'idle' } })
    await expect(missing.main.request('host.compact', {})).resolves.toEqual({ compacted: false })
    expect(missing.onError).not.toHaveBeenCalled()
  })

  it('runs the approved plan and exposes update_plan_step (M3-05)', async () => {
    const plan = {
      planId: 'plan-1',
      goal: 'Ship it',
      steps: [{ id: 'one', title: 'First step' }],
    }
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'update_plan_step', input: { stepId: 'one', status: 'done' } },
            { kind: 'reply', text: 'done' },
          ],
        },
      ],
    }
    const h = setup(script, {
      registerTools: (registry) => registry.register(echoTool),
    })
    await h.main.request('host.init', { ...init, permissionRules: presetRules('auto') })
    await h.main.request('host.prompt', {
      messageId: 'm1',
      content: text('go'),
      plan,
    })
    await h.waitFor('turn.completed')
    expect(h.events.find((event) => event.type === 'plan.step.updated')?.payload).toMatchObject({
      planId: 'plan-1',
      stepIndex: 0,
      status: 'done',
    })
    const completed = h.events.find((event) => event.type === 'tool.completed')
    expect(completed?.payload).toMatchObject({ output: text('Step one is now done.') })
  })

  it('resolves workspace paths and reads the skill read-only roots (M3-07)', async () => {
    const probes: unknown[] = []
    const probe: ToolDefinition<{ path: string }> = {
      name: 'probe_path',
      description: 'Resolve a path',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      async execute(input, ctx) {
        const result = await ctx.resolvePath(input.path)
        probes.push(result)
        return { content: text(result.ok ? 'ok' : 'failed') }
      },
    }
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'probe_path', input: { path: 'notes.md' } },
            { kind: 'reply', text: 'done' },
          ],
        },
      ],
    }
    const h = setup(script, { registerTools: (registry) => registry.register(probe) })
    h.main.handle('host.skills', () => ({
      skills: [
        {
          name: 'house',
          description: 'House style.',
          sha256: 'a'.repeat(64),
          source: 'user' as const,
          pinned: false,
          root: '/skills/house',
          body: 'body',
          hasScripts: false,
          files: [],
        },
      ],
    }))
    await h.main.request('host.init', { ...init, permissionRules: presetRules('auto') })
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(probes).toHaveLength(1)
  })

  it('logs through the silent logger when no logger is configured', async () => {
    const probe: ToolDefinition<object> = {
      name: 'log_probe',
      description: 'Exercise the logger',
      category: 'read',
      source: { kind: 'builtin' },
      trust: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      execute: (_input, ctx) => {
        ctx.log.setLevel('debug')
        const enabled = ctx.log.isEnabled('debug')
        ctx.log.debug('debug')
        ctx.log.info('info')
        ctx.log.warn('warn')
        ctx.log.error('error')
        return Promise.resolve({ content: text(String(enabled)) })
      },
    }
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'log_probe', input: {} },
            { kind: 'reply', text: 'done' },
          ],
        },
      ],
    }
    const h = setup(script, { registerTools: (registry) => registry.register(probe) })
    await h.main.request('host.init', { ...init, permissionRules: presetRules('auto') })
    await h.main.request('host.prompt', { messageId: 'm1', content: text('hi') })
    await h.waitFor('turn.completed')
    expect(h.events.find((event) => event.type === 'tool.completed')?.payload).toMatchObject({
      output: text('false'),
    })
  })

  it('uses the platform default clock and a case-insensitive option', async () => {
    const [mainSide, hostSide] = channelPair()
    let id = 0
    createAgentHost({
      channel: hostSide,
      createRuntime: (model) => ({
        runtime: new FakeRuntime({ turns: [] }),
        model: fakeModel(model),
      }),
      exit: vi.fn(),
      createId: () => `id${++id}`,
      caseInsensitive: true,
    })
    const main = createEndpoint(mainSide, { local: MainForHost, remote: HostForMain })
    await main.request('host.init', init)
    const { ts } = await main.request('host.heartbeat', {})
    expect(Math.abs(ts - Date.now())).toBeLessThan(5_000)
  })

  it('passes a retry policy through to the run supervisor', async () => {
    const h = setup({ turns: [] }, { retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 10 } })
    await h.main.request('host.init', init)
    expect(h.events.map((event) => event.type)).toEqual(['run.created'])
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
