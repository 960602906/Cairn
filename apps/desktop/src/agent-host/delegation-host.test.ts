import { describe, expect, it, vi } from 'vitest'
import {
  FakeRuntime,
  presetRules,
  type AgentRuntime,
  type FakeScript,
  type ToolDefinition,
} from '@cairn/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type AgentDefinition,
  type McpToolExposure,
  type RpcChannel,
  type SkillCatalogEntry,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { createAgentHost, type AgentHostOptions } from './host.js'
import { fakeModel } from './fake-model.js'

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

const text = (t: string) => [{ type: 'text' as const, text: t }]

const lookup: ToolDefinition<object> = {
  name: 'lookup',
  description: 'Look something up',
  category: 'read',
  source: { kind: 'builtin' },
  trust: 'builtin',
  inputSchema: { type: 'object', properties: {} },
  execute: () => Promise.resolve({ content: text('found') }),
}

function agent(id: string, patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    version: 1,
    source: 'builtin',
    status: 'published',
    name: { 'en-US': id },
    description: { 'en-US': `${id} description` },
    instructions: `${id} instructions`,
    model: { mode: 'inherit' },
    tools: { allow: ['*'] },
    skills: { allow: [] },
    permissions: 'read-only',
    limits: { maxStepsPerTurn: 8, maxTurnDurationMs: 30_000, maxConsecutiveToolErrors: 3 },
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: [], write: 'never' },
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 1,
    ...patch,
  }
}

const reviewer = agent('builtin.reviewer')
const coder = agent('builtin.coder')

const delegation = {
  enabled: true,
  allowedAgents: ['builtin.reviewer'],
  maxDepth: 1,
  maxChildrenPerTurn: 2,
  maxParallel: 1,
  childBudgetShare: 0.5,
  defaultWorkspace: 'shared' as const,
  mergeReview: 'user' as const,
}

const parentDefinition = (patch: Partial<AgentDefinition> = {}): AgentDefinition =>
  agent('default', { delegation, ...patch })

const baseInit = {
  sessionId: 's1',
  runId: 'r1',
  workspacePath: '/work',
  agent: { id: 'default', version: 1 },
  model: { providerId: 'fake', modelId: 'fake-1' },
  mode: 'interactive' as const,
  limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
  history: [],
}

interface SetupOptions {
  readonly parentScript?: FakeScript
  readonly childScript?: FakeScript
  readonly grandchildScript?: FakeScript
  readonly definition?: AgentDefinition
  readonly targets?: readonly { id: string; definition: AgentDefinition }[]
  readonly delegationError?: RpcError
  readonly host?: Partial<AgentHostOptions>
  readonly credential?: { apiKey: string }
  readonly skills?: readonly SkillCatalogEntry[]
  readonly mcpTools?: readonly McpToolExposure[]
  readonly noTargetsHandler?: boolean
}

function setup(options: SetupOptions = {}) {
  const [mainSide, hostSide] = channelPair()
  const events: UnsequencedEvent[] = []
  const onError = vi.fn()
  const runtimeTools: Record<string, readonly { name: string; description: string }[]> = {}
  const systemPrompts: Record<string, string> = {}
  const createdRuntimes: string[] = []
  const definitions = new Map(
    (options.targets ?? [{ id: reviewer.id, definition: reviewer }]).map((entry) => [
      entry.id,
      entry.definition,
    ]),
  )
  const scripts: Record<string, FakeScript> = {
    'fake-1': options.parentScript ?? { turns: [] },
    reviewer: options.childScript ?? { turns: [] },
    coder: options.grandchildScript ?? { turns: [] },
  }
  let id = 0
  const host = createAgentHost({
    channel: hostSide,
    createRuntime: (model) => {
      createdRuntimes.push(model.modelId)
      const base = new FakeRuntime(scripts[model.modelId] ?? { turns: [] })
      const runtime: AgentRuntime = {
        id: `spy-${model.modelId}`,
        createSession: (sessionInit) => {
          runtimeTools[model.modelId] = sessionInit.tools
          systemPrompts[model.modelId] = sessionInit.systemPrompt
          return base.createSession(sessionInit)
        },
      }
      return { runtime, model: fakeModel(model) }
    },
    exit: vi.fn(),
    createId: () => `id${++id}`,
    now: () => 7,
    onError,
    registerTools: (registry) => registry.register(lookup),
    ...options.host,
  })
  const main = createEndpoint(mainSide, { local: MainForHost, remote: HostForMain })
  main.on('host.event', ({ event }) => events.push(event))
  if (!options.noTargetsHandler) {
    main.handle('host.delegate.targets', ({ agents }) => ({
      targets: agents.flatMap((agentId) => {
        const definition = definitions.get(agentId)
        return definition
          ? [
              {
                id: agentId,
                name: definition.name['en-US'] ?? agentId,
                description: definition.description['en-US'] ?? '',
              },
            ]
          : []
      }),
    }))
  }
  main.handle('host.delegate', async ({ agent: agentId }) => {
    if (options.delegationError) throw options.delegationError
    const definition = definitions.get(agentId)
    if (!definition) throw new RpcError('delegation.agent_not_published', { agent: agentId })
    return {
      definition,
      model: {
        providerId: 'fake',
        modelId: definition.id.endsWith('coder') ? 'coder' : 'reviewer',
      },
      ...(options.credential ? { credential: options.credential } : {}),
      permissionRules: presetRules(definition.permissions),
      skills: [...(options.skills ?? [])],
      mcpTools: [...(options.mcpTools ?? [])],
      workspace: 'shared' as const,
    }
  })
  return {
    main,
    events,
    onError,
    host,
    runtimeTools,
    systemPrompts,
    createdRuntimes,
    initHost: () =>
      main.request('host.init', {
        ...baseInit,
        agentDefinition: options.definition ?? parentDefinition(),
      }),
    waitFor: async (type: string, count = 1) => {
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === type).length).toBeGreaterThanOrEqual(count),
      )
    },
  }
}

const toolCompletedText = (events: readonly UnsequencedEvent[]) =>
  events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => JSON.stringify(event.payload))
    .join('\n')

const delegateStep = (agentId: string) => ({
  kind: 'tool' as const,
  name: 'delegate',
  input: { agent: agentId, task: 'review', brief: { goal: 'g', deliverable: 'd' } },
})

describe('host delegation (M4-02)', () => {
  it('父运行调用 delegate，子运行执行并把结构化结果回填', async () => {
    const h = setup({
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'thanks' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              {
                kind: 'reply',
                text: '{"status":"completed","summary":"looks good","output":{"count":1}}',
                usage: { inputTokens: 4, outputTokens: 2 },
              },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('please review') })
    await h.waitFor('run.child.completed')
    await h.waitFor('turn.completed')

    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      runId: 'r1',
      payload: {
        agent: { id: 'builtin.reviewer', version: 1 },
        task: 'review',
        workspace: 'shared',
        workspacePath: '/work',
      },
    })
    expect(
      h.events.find((event) => event.type === 'run.created' && event.runId !== 'r1'),
    ).toMatchObject({ parentRunId: 'r1' })
    expect(toolCompletedText(h.events)).toContain('looks good')
    expect(h.createdRuntimes).toEqual(['fake-1', 'reviewer'])
    // 工具说明列出了可委派目标
    const delegate = h.runtimeTools['fake-1']?.find((tool) => tool.name === 'delegate')
    expect(delegate?.description).toContain('builtin.reviewer')
  })

  it('未启用委派时 delegate 工具不可见', async () => {
    const h = setup({ definition: parentDefinition({ delegation: undefined }) })
    await h.initHost()
    expect(h.runtimeTools['fake-1']?.map((tool) => tool.name)).not.toContain('delegate')
    expect(h.runtimeTools['fake-1']?.map((tool) => tool.name)).toContain('lookup')
  })

  it('子运行使用自己的 Skills、MCP 工具与系统提示词', async () => {
    const h = setup({
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
      skills: [
        {
          name: 'review-checklist',
          description: 'Review checklist',
          sha256: 'a'.repeat(64),
          source: 'builtin',
          pinned: true,
          root: '/skills/review',
          body: 'Pinned review checklist',
          hasScripts: false,
          files: [],
        },
      ],
      mcpTools: [
        {
          name: 'mcp_echo',
          description: 'Echo',
          inputSchema: { type: 'object' },
          serverId: 'srv',
          originalName: 'echo',
          category: 'read',
        },
      ],
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    const names = h.runtimeTools['reviewer']?.map((tool) => tool.name) ?? []
    expect(names).toContain('mcp_echo')
    expect(names).toContain('load_skill')
    expect(h.systemPrompts['reviewer']).toContain('Pinned review checklist')
    expect(h.systemPrompts['reviewer']).toContain('reviewer instructions')
  })

  it('主进程没有目标列表接口时仍按 id 登记 delegate', async () => {
    const h = setup({ noTargetsHandler: true })
    await h.initHost()
    const delegate = h.runtimeTools['fake-1']?.find((tool) => tool.name === 'delegate')
    expect(delegate?.description).toContain('builtin.reviewer')
  })

  it('allowedAgents 为空时不登记 delegate', async () => {
    const h = setup({
      definition: parentDefinition({ delegation: { ...delegation, allowedAgents: [] } }),
    })
    await h.initHost()
    expect(h.runtimeTools['fake-1']?.map((tool) => tool.name)).not.toContain('delegate')
  })

  it('子运行没有可见工具时不创建流水线，并跳过空指令与非固定技能', async () => {
    const toolLess = agent('builtin.reviewer', { tools: { allow: [] }, instructions: '' })
    const h = setup({
      targets: [{ id: reviewer.id, definition: toolLess }],
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
      skills: [
        {
          name: 'optional-skill',
          description: 'Not pinned',
          sha256: 'b'.repeat(64),
          source: 'user',
          pinned: false,
          root: '/skills/optional',
          body: 'Optional body',
          hasScripts: false,
          files: [],
        },
      ],
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(h.runtimeTools['reviewer']).toEqual([])
    expect(h.systemPrompts['reviewer']).not.toContain('Optional body')
  })

  it('子运行的工具环境与大小写选项传入工具流水线', async () => {
    const h = setup({
      host: {
        caseInsensitive: true,
        registerTools: (registry) => {
          registry.register(lookup)
          return { shell: 'PowerShell 7' }
        },
      },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(h.runtimeTools['reviewer']?.map((tool) => tool.name)).toContain('lookup')
    expect(h.systemPrompts['reviewer']).toContain('PowerShell 7')
  })

  it('目标不在 allowedAgents 时返回权限错误且不创建子运行', async () => {
    const h = setup({
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.coder'), { kind: 'reply', text: 'done' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('tool.failed')
    expect(h.events.find((event) => event.type === 'run.delegated')).toBeUndefined()
    expect(JSON.stringify(h.events)).toContain('delegation.agent_not_allowed')
  })

  it('目标未发布时映射为工具错误', async () => {
    const h = setup({
      delegationError: new RpcError('delegation.agent_not_published'),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('tool.failed')
    expect(JSON.stringify(h.events)).toContain('delegation.agent_not_published')
    expect(h.createdRuntimes).toEqual(['fake-1'])
  })

  it('子运行的凭据不出现在事件、日志与错误中', async () => {
    const secret = '{{SECRET_childkey0123}}'
    const h = setup({
      credential: { apiKey: secret },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(JSON.stringify(h.events)).not.toContain(secret)
    for (const call of h.onError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret)
    }
  })

  it('嵌套委派在深度上限内继续', async () => {
    const nestedReviewer = agent('builtin.reviewer', {
      delegation: { ...delegation, allowedAgents: ['builtin.coder'], maxDepth: 2 },
    })
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['builtin.reviewer'], maxDepth: 2 },
      }),
      targets: [
        { id: reviewer.id, definition: nestedReviewer },
        { id: coder.id, definition: coder },
      ],
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              delegateStep('builtin.coder'),
              { kind: 'reply', text: '{"summary":"child done"}' },
            ],
          },
        ],
      },
      grandchildScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"grandchild done"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed', 2)
    const delegated = h.events.filter((event) => event.type === 'run.delegated')
    expect(delegated).toHaveLength(2)
    expect(delegated[1]).toMatchObject({ payload: { agent: { id: 'builtin.coder' } } })
    expect(h.createdRuntimes).toEqual(['fake-1', 'reviewer', 'coder'])
  })

  it('子 Agent 的深度上限阻止继续委派', async () => {
    const nestedReviewer = agent('builtin.reviewer', {
      delegation: { ...delegation, allowedAgents: ['builtin.coder'], maxDepth: 1 },
    })
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['builtin.reviewer'], maxDepth: 2 },
      }),
      targets: [
        { id: reviewer.id, definition: nestedReviewer },
        { id: coder.id, definition: coder },
      ],
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              {
                kind: 'tool',
                name: 'delegate',
                input: {
                  agent: 'builtin.coder',
                  task: 't',
                  brief: { goal: 'g', deliverable: 'd' },
                },
              },
              { kind: 'reply', text: '{"summary":"child done"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    // 子运行的模型上下文里没有 delegate（深度已达上限）
    expect(h.runtimeTools['reviewer']?.map((tool) => tool.name)).not.toContain('delegate')
    expect(h.createdRuntimes).toEqual(['fake-1', 'reviewer'])
  })
})
