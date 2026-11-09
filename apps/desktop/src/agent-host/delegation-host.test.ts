import { describe, expect, it, vi } from 'vitest'
import { CheckpointError, CheckpointErrorCode } from '@cairn/checkpoint'
import {
  FakeRuntime,
  presetRules,
  type AgentRuntime,
  type FakeScript,
  type ToolDefinition,
  type ToolRegistry,
} from '@cairn/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type AgentDefinition,
  type ApprovalDecision,
  type HostApprovalRequest,
  type McpToolExposure,
  type PermissionRule,
  type RunSnapshotInput,
  type RpcChannel,
  type SkillCatalogEntry,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { createAgentHost, type AgentHostOptions, type HostSandboxConfig } from './host.js'
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

const writeFile: ToolDefinition<{ path: string }> = {
  name: 'write_file',
  description: 'Write a file',
  category: 'write',
  source: { kind: 'builtin' },
  trust: 'builtin',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  normalize: (input) => Promise.resolve({ input, targets: { paths: [input.path] } }),
  execute: () => Promise.resolve({ content: text('wrote') }),
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
  readonly targetsError?: unknown
  readonly delegateFailure?: unknown
  readonly host?: Partial<AgentHostOptions>
  readonly credential?: { apiKey: string }
  readonly skills?: readonly SkillCatalogEntry[]
  readonly mcpTools?: readonly McpToolExposure[]
  readonly noTargetsHandler?: boolean
  readonly approval?: (request: HostApprovalRequest) => {
    decision: ApprovalDecision
    feedback?: string
    rule?: PermissionRule
  }
  readonly permissionRules?: readonly PermissionRule[]
  /** `host.delegate` 返回的工作区方式（M4-08）；默认共享。 */
  readonly targetWorkspace?: 'shared' | 'isolated'
  /** 父运行的检查点位置；给出时宿主可以创建委派基线检查点。 */
  readonly checkpoints?: { readonly gitDir: string; readonly ref: string }
  /** 创建隔离工作区；默认按 runId 返回 `/worktrees/s1/<runId>`。 */
  readonly workspaceCreate?: (input: {
    readonly projectPath: string
    readonly baseCommit: string
    readonly sessionId: string
    readonly runId: string
    readonly gitDir?: string | undefined
  }) => Promise<{
    path: string
    mode: 'worktree' | 'export'
    sharedDirs: string[]
    checkpoint: { gitDir: string; ref: string }
  }>
  readonly noWorkspaceHandler?: boolean
  readonly workspaceCleanupError?: unknown
  /** 计算改动集（M4-09）；默认按子运行返回一个单文件改动集。 */
  readonly changesetCreate?: (input: {
    readonly runId: string
    readonly parentRunId?: string | undefined
  }) => Promise<{
    changeSetId: string
    files: { path: string; added: number; removed: number }[]
  }>
  /** 不注册 `host.changeset.create`（模拟旧主进程）。 */
  readonly noChangeSetHandler?: boolean
  /** `host.init.sandbox`（M5-04）。 */
  readonly sandbox?: HostSandboxConfig
}

function setup(options: SetupOptions = {}) {
  const [mainSide, hostSide] = channelPair()
  const events: UnsequencedEvent[] = []
  const onError = vi.fn()
  const runtimeTools: Record<string, readonly { name: string; description: string }[]> = {}
  const systemPrompts: Record<string, string> = {}
  const createdRuntimes: string[] = []
  const workspacePaths: string[] = []
  const sandboxConfigs: (HostSandboxConfig | undefined)[] = []
  const workspaceRuns: string[] = []
  const workspaceCreateInputs: {
    projectPath: string
    baseCommit: string
    sessionId: string
    runId: string
    gitDir?: string | undefined
  }[] = []
  const cleanupCalls: string[] = []
  const changeSetCalls: { runId: string; parentRunId?: string | undefined }[] = []
  const callOrder: string[] = []
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
  const registerTools = options.host?.registerTools
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
    ...options.host,
    registerTools: (registry, workspacePath, shell, sandbox) => {
      workspacePaths.push(workspacePath)
      sandboxConfigs.push(sandbox)
      return registerTools
        ? registerTools(registry, workspacePath, shell, sandbox)
        : registry.register(lookup)
    },
  })
  const main = createEndpoint(mainSide, { local: MainForHost, remote: HostForMain })
  main.on('host.event', ({ event }) => {
    events.push(event)
    if (event.type === 'run.child.completed') {
      callOrder.push(`completed:${event.payload.childRunId}`)
    }
  })
  if (!options.noTargetsHandler) {
    main.handle('host.delegate.targets', ({ agents }) => {
      if (options.targetsError !== undefined) throw options.targetsError
      return {
        targets: agents.flatMap((agentId) => {
          const definition = definitions.get(agentId)
          return definition
            ? [
                {
                  id: agentId,
                  name: definition.name['en-US'] ?? agentId,
                  description: definition.description['en-US'] ?? '',
                  permissions: definition.permissions,
                },
              ]
            : []
        }),
      }
    })
  }
  main.handle('host.delegate', async ({ agent: agentId }) => {
    if (options.delegationError) throw options.delegationError
    if (options.delegateFailure !== undefined) throw options.delegateFailure
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
      workspace: options.targetWorkspace ?? ('shared' as const),
    }
  })
  if (!options.noWorkspaceHandler) {
    main.handle('host.workspace.create', async (input) => {
      workspaceRuns.push(input.runId)
      workspaceCreateInputs.push(input)
      if (options.workspaceCreate) return options.workspaceCreate(input)
      return {
        path: `/worktrees/s1/${input.runId}`,
        mode: 'worktree' as const,
        sharedDirs: ['node_modules'],
        checkpoint: {
          gitDir: `/data/worktrees/s1/${input.runId}.checkpoints.git`,
          ref: `refs/cairn/worktrees/${input.runId}`,
        },
      }
    })
    main.handle('host.workspace.cleanup', ({ runId }) => {
      cleanupCalls.push(runId)
      callOrder.push(`cleanup:${runId}`)
      if (options.workspaceCleanupError !== undefined) throw options.workspaceCleanupError
      return { cleaned: true }
    })
  }
  if (!options.noChangeSetHandler) {
    main.handle('host.changeset.create', async (input) => {
      changeSetCalls.push(input)
      callOrder.push(`changeset:${input.runId}`)
      return options.changesetCreate
        ? options.changesetCreate(input)
        : {
            changeSetId: `cs-${input.runId}`,
            files: [{ path: 'src/a.ts', added: 1, removed: 0 }],
          }
    })
  }
  if (options.approval) {
    const approval = options.approval
    main.handle('host.approval.request', (request) => approval(request))
  }
  return {
    main,
    events,
    onError,
    host,
    runtimeTools,
    systemPrompts,
    createdRuntimes,
    workspacePaths,
    sandboxConfigs,
    workspaceRuns,
    workspaceCreateInputs,
    cleanupCalls,
    changeSetCalls,
    callOrder,
    initHost: () =>
      main.request('host.init', {
        ...baseInit,
        agentDefinition: options.definition ?? parentDefinition(),
        ...(options.permissionRules ? { permissionRules: [...options.permissionRules] } : {}),
        ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
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

  it('委派结束后归还运行名额，连续委派不会被上限挡住（M4-13）', async () => {
    const h = setup({
      parentScript: {
        turns: [
          {
            steps: [
              delegateStep('builtin.reviewer'),
              delegateStep('builtin.reviewer'),
              { kind: 'reply', text: 'done' },
            ],
          },
        ],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"status":"completed","summary":"ok"}' }] }],
      },
      host: { maxRuns: 1, maxOverflowRuns: 1 },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('turn.completed')

    expect(h.events.filter((event) => event.type === 'run.delegated')).toHaveLength(2)
    expect(h.events.filter((event) => event.type === 'run.child.completed')).toHaveLength(2)
    expect(toolCompletedText(h.events)).toContain('ok')
  })

  it('父子运行分别上报带运行归属的上下文快照（M4-04）', async () => {
    const snapshots: RunSnapshotInput[] = []
    const h = setup({
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"status":"completed","summary":"ok"}' }] }],
      },
    })
    h.main.handle('host.snapshot', (snapshot) => {
      snapshots.push(snapshot)
      return {}
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('please review') })
    await h.waitFor('run.child.completed')
    await h.waitFor('turn.completed')
    await vi.waitFor(() => expect(snapshots.some((item) => item.parentRunId === 'r1')).toBe(true))

    const parent = snapshots.find((item) => item.runId === 'r1')
    const child = snapshots.find((item) => item.parentRunId === 'r1')
    expect(parent).toMatchObject({
      agent: { id: 'default', version: 1 },
      model: { providerId: 'fake', modelId: 'fake-1' },
    })
    expect(child).toMatchObject({
      agent: { id: 'builtin.reviewer', version: 1 },
      model: { providerId: 'fake', modelId: 'reviewer' },
    })
    expect(child!.history.preview.some((message) => message.role === 'user')).toBe(true)
    expect(child!.tools.map((tool) => tool.name)).toContain('lookup')
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
        {
          name: 'optional-skill',
          description: 'Optional checklist',
          sha256: 'c'.repeat(64),
          source: 'user',
          pinned: false,
          root: '/skills/optional',
          body: 'Optional skill body',
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
    expect(h.systemPrompts['reviewer']).not.toContain('Optional skill body')
    expect(h.systemPrompts['reviewer']).toContain('reviewer instructions')
  })

  it('主进程没有目标列表接口时仍按 id 登记 delegate', async () => {
    const h = setup({ noTargetsHandler: true })
    await h.initHost()
    const delegate = h.runtimeTools['fake-1']?.find((tool) => tool.name === 'delegate')
    expect(delegate?.description).toContain('builtin.reviewer')
  })

  it('目标列表接口失败时回退到 id 并记录错误', async () => {
    const h = setup({ targetsError: new Error('target list unavailable') })
    await h.initHost()
    const delegate = h.runtimeTools['fake-1']?.find((tool) => tool.name === 'delegate')
    expect(delegate?.description).toContain('builtin.reviewer')
    expect(h.onError).toHaveBeenCalled()
  })

  it('拒绝缺少任务与简报的委派输入', async () => {
    const h = setup({
      parentScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'delegate', input: { agent: 'builtin.reviewer' } },
              { kind: 'reply', text: 'done' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('tool.failed')
    expect(JSON.stringify(h.events)).toContain('tool.invalid_input')
    expect(h.createdRuntimes).toEqual(['fake-1'])
  })

  it('把主进程的委派失败映射为工具错误', async () => {
    const h = setup({
      delegateFailure: new Error('delegate backend unavailable'),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('tool.failed')
    expect(h.createdRuntimes).toEqual(['fake-1'])
  })

  it('allowedAgents 为空时不登记 delegate', async () => {
    const h = setup({
      definition: parentDefinition({ delegation: { ...delegation, allowedAgents: [] } }),
    })
    await h.initHost()
    expect(h.runtimeTools['fake-1']?.map((tool) => tool.name)).not.toContain('delegate')
  })

  it('allowedAgents 中没有已发布目标时不登记 delegate', async () => {
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['missing.agent'] },
      }),
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

  it('子运行没有注册任何工具时不登记 load_skill', async () => {
    const toolLess = agent('builtin.reviewer', { tools: { allow: [] } })
    const h = setup({
      targets: [{ id: reviewer.id, definition: toolLess }],
      host: { registerTools: () => undefined },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
      skills: [
        {
          name: 'pinned-skill',
          description: 'Pinned',
          sha256: 'd'.repeat(64),
          source: 'builtin',
          pinned: true,
          root: '/skills/pinned',
          body: 'Pinned body',
          hasScripts: false,
          files: [],
        },
      ],
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(h.runtimeTools['reviewer']).toEqual([])
    expect(h.systemPrompts['reviewer']).toContain('Pinned body')
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

describe('host isolated workspace (M4-08)', () => {
  const tester = agent('builtin.tester', { permissions: 'ask' })
  const autoParent = parentDefinition({
    delegation: { ...delegation, allowedAgents: ['builtin.tester'], defaultWorkspace: 'auto' },
  })
  const checkpoints = { gitDir: '/data/p1.git', ref: 'refs/cairn/sessions/s1' }
  const baseline = 'a'.repeat(40)

  it('子运行可以加载技能正文与额外文件提示', async () => {
    const skillUser = agent('builtin.tester', {
      permissions: 'ask',
      tools: { allow: ['load_skill'] },
    })
    const h = setup({
      definition: autoParent,
      targets: [{ id: skillUser.id, definition: skillUser }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => baseline,
          checkpoint: async () => ({ commit: baseline }) as never,
        }),
      },
      approval: () => ({ decision: 'allow_once' }),
      skills: [
        {
          name: 'review-checklist',
          description: 'Review checklist',
          sha256: 'e'.repeat(64),
          source: 'builtin',
          pinned: false,
          root: '/skills/review',
          body: 'Skill body loaded on demand',
          hasScripts: false,
          files: [],
          filesTruncated: true,
        },
      ],
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'load_skill', input: { name: 'review-checklist' } },
              { kind: 'reply', text: '{"summary":"ok"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(toolCompletedText(h.events)).toContain('Skill body loaded on demand')
  })

  it('creates an isolated workspace and roots the child run at it', async () => {
    const openCheckpoints = vi.fn(async () => ({
      head: () => baseline,
      checkpoint: vi.fn(async () => ({ commit: baseline }) as never),
    }))
    const h = setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: { openCheckpoints },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.workspaceRuns).toHaveLength(1)
    const childRunId = h.workspaceRuns[0]!
    const isolated = `/worktrees/s1/${childRunId}`
    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      payload: { workspace: 'isolated', workspacePath: isolated },
    })
    // 父运行与子运行的工具都拿到正确的工作区根
    expect(h.workspacePaths).toEqual(['/work', isolated])
    expect(h.systemPrompts['reviewer']).toContain(isolated)
    // 子运行使用自己的检查点位置，并把 .git 文件排除在外
    expect(openCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        gitDir: `/data/worktrees/s1/${childRunId}.checkpoints.git`,
        ref: `refs/cairn/worktrees/${childRunId}`,
        workTree: isolated,
        extraExcludes: ['.git'],
      }),
    )
    expect(h.cleanupCalls).toEqual([childRunId])
  })

  it('records cleanup failures without failing the delegated result', async () => {
    const h = setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => baseline,
          checkpoint: async () => ({ commit: baseline }) as never,
        }),
      },
      workspaceCleanupError: new Error('cleanup failed'),
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.cleanupCalls).toHaveLength(1)
    expect(h.onError).toHaveBeenCalled()
    expect(toolCompletedText(h.events)).toContain('ok')
  })

  it('falls back to shared when the delegation checkpoint fails', async () => {
    const h = setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => baseline,
          checkpoint: async () => {
            throw new Error('checkpoint disk full')
          },
        }),
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.workspaceRuns).toEqual([])
    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      payload: { workspace: 'shared', workspacePath: '/work' },
    })
    expect(h.onError).toHaveBeenCalled()
  })

  it('nests isolated workspaces and gives the grandchild its own checkpoint root', async () => {
    const nestedTester = agent('builtin.tester', {
      permissions: 'ask',
      delegation: {
        ...delegation,
        allowedAgents: ['builtin.coder'],
        maxDepth: 2,
        defaultWorkspace: 'auto',
      },
    })
    const writer = agent('builtin.coder', { permissions: 'ask' })
    const h = setup({
      definition: parentDefinition({
        delegation: {
          ...delegation,
          allowedAgents: ['builtin.tester'],
          maxDepth: 2,
          defaultWorkspace: 'auto',
        },
      }),
      targets: [
        { id: nestedTester.id, definition: nestedTester },
        { id: writer.id, definition: writer },
      ],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => baseline,
          checkpoint: async () => ({ commit: baseline }) as never,
        }),
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
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

    expect(h.workspaceCreateInputs).toHaveLength(2)
    const [childCreate, grandchildCreate] = h.workspaceCreateInputs
    expect(childCreate!.gitDir).toBeUndefined()
    expect(grandchildCreate!.gitDir).toBe(
      `/data/worktrees/s1/${childCreate!.runId}.checkpoints.git`,
    )
    expect(grandchildCreate!.runId).not.toBe(childCreate!.runId)
    expect(h.cleanupCalls).toEqual([grandchildCreate!.runId, childCreate!.runId])
  })

  it('falls back to the shared workspace when creation fails', async () => {
    const h = setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => 'cp0',
          checkpoint: async () => ({ commit: 'cp0' }) as never,
        }),
      },
      workspaceCreate: async () => {
        throw new Error('quota exceeded')
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      payload: { workspace: 'shared', workspacePath: '/work' },
    })
    expect(h.cleanupCalls).toEqual([])
    expect(h.onError).toHaveBeenCalled()
  })

  it('falls back to shared when no checkpoint baseline is available', async () => {
    const h = setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => {
          throw new CheckpointError(CheckpointErrorCode.GitUnavailable, 'git not found')
        },
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.workspaceRuns).toEqual([])
    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      payload: { workspace: 'shared', workspacePath: '/work' },
    })
  })

  it('keeps the parent workspace when the policy explicitly asks for shared', async () => {
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['builtin.tester'] },
      }),
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => 'cp0',
          checkpoint: async () => ({ commit: 'cp0' }) as never,
        }),
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(h.workspaceRuns).toEqual([])
    expect(h.events.find((event) => event.type === 'run.delegated')).toMatchObject({
      payload: { workspace: 'shared', workspacePath: '/work' },
    })
  })

  it('serializes shared writes so only one child mutates the parent workspace', async () => {
    const parallel = {
      ...delegation,
      allowedAgents: ['builtin.tester'],
      maxChildrenPerTurn: 2,
      maxParallel: 2,
    }
    const step = (task: string) => ({
      kind: 'tool' as const,
      name: 'delegate',
      input: { agent: 'builtin.tester', task, brief: { goal: 'g', deliverable: 'd' } },
    })
    const h = setup({
      definition: parentDefinition({ delegation: parallel }),
      targets: [{ id: tester.id, definition: tester }],
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [step('first'), step('second'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed', 2)

    const delegated = h.events.filter((event) => event.type === 'run.delegated')
    expect(delegated).toHaveLength(2)
    const firstCompleted = h.events.findIndex((event) => event.type === 'run.child.completed')
    const secondDelegated = h.events.indexOf(delegated[1]!)
    expect(secondDelegated).toBeGreaterThan(firstCompleted)
  })
})

describe('host change sets (M4-09)', () => {
  const tester = agent('builtin.tester', { permissions: 'ask' })
  const autoParent = parentDefinition({
    delegation: { ...delegation, allowedAgents: ['builtin.tester'], defaultWorkspace: 'auto' },
  })
  const checkpoints = { gitDir: '/data/p1.git', ref: 'refs/cairn/sessions/s1' }
  const baseline = 'a'.repeat(40)

  const isolatedSetup = (extra: Partial<SetupOptions> = {}) =>
    setup({
      definition: autoParent,
      targets: [{ id: tester.id, definition: tester }],
      targetWorkspace: 'isolated',
      checkpoints,
      host: {
        openCheckpoints: async () => ({
          head: () => baseline,
          checkpoint: async () => ({ commit: baseline }) as never,
        }),
      },
      approval: () => ({ decision: 'allow_once' }),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
      },
      ...extra,
    })

  it('collects the change set before the child completes and before cleanup', async () => {
    const h = isolatedSetup()
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    const childRunId = h.workspaceRuns[0]!
    expect(h.changeSetCalls).toEqual([{ runId: childRunId, parentRunId: 'r1' }])
    // 主进程先写 changeset.created，再收到 run.child.completed，最后才清理隔离目录。
    expect(h.callOrder).toEqual([
      `changeset:${childRunId}`,
      `completed:${childRunId}`,
      `cleanup:${childRunId}`,
    ])
    const completed = h.events.find((event) => event.type === 'run.child.completed')!
    expect(completed.payload).toMatchObject({ changeSetId: `cs-${childRunId}` })
    // 结果里带改动集，父 Agent 知道有改动待审阅。
    expect(toolCompletedText(h.events)).toContain(`cs-${childRunId}`)
    expect(toolCompletedText(h.events)).toContain('pending_review')
  })

  it('does not collect change sets for shared workspaces', async () => {
    const h = isolatedSetup({
      targetWorkspace: 'shared',
      definition: parentDefinition({
        delegation: {
          ...delegation,
          allowedAgents: ['builtin.tester'],
          defaultWorkspace: 'shared',
        },
      }),
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(h.changeSetCalls).toEqual([])
    const delegated = h.events.find((event) => event.type === 'run.delegated')!
    expect(h.callOrder).toEqual([`completed:${delegated.payload.childRunId}`])
    const completed = h.events.find((event) => event.type === 'run.child.completed')!
    expect(completed.payload).not.toHaveProperty('changeSetId')
  })

  it('still completes the delegation when the main process has no change set service', async () => {
    const h = isolatedSetup({ noChangeSetHandler: true })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    const completed = h.events.find((event) => event.type === 'run.child.completed')!
    expect(completed.payload).toMatchObject({ status: 'completed' })
    expect(completed.payload).not.toHaveProperty('changeSetId')
    // 旧主进程没有这个接口：不当作错误。
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('still completes the delegation and reports an ordinary change set failure', async () => {
    const h = isolatedSetup({
      changesetCreate: async () => {
        throw new Error('change set failed')
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    const completed = h.events.find((event) => event.type === 'run.child.completed')!
    expect(completed.payload).toMatchObject({ status: 'completed' })
    expect(completed.payload).not.toHaveProperty('changeSetId')
    expect(h.onError).toHaveBeenCalledTimes(1)
  })
})

describe('host delegation permissions (M4-03)', () => {
  const registerTools = (registry: ToolRegistry) => {
    registry.register(lookup)
    registry.register(writeFile)
  }

  it('委派给只读 Agent 不需要额外审批', async () => {
    const requests: HostApprovalRequest[] = []
    const h = setup({
      approval: (request) => {
        requests.push(request)
        return { decision: 'allow_once' }
      },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: { turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }] },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')
    expect(requests).toEqual([])
  })

  it('委派给写入类 Agent 需要审批，子运行的审批带父运行归属', async () => {
    const requests: HostApprovalRequest[] = []
    const h = setup({
      targets: [{ id: reviewer.id, definition: agent('builtin.reviewer', { permissions: 'ask' }) }],
      permissionRules: presetRules('auto'),
      approval: (request) => {
        requests.push(request)
        return { decision: 'allow_once' }
      },
      host: { registerTools },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_file', input: { path: 'a.ts' } },
              { kind: 'reply', text: '{"summary":"ok"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    const delegation = requests.find((request) => request.tool.name === 'delegate')
    expect(delegation).toMatchObject({
      runId: 'r1',
      agent: { id: 'default', version: 1 },
      reasonCode: 'permission.delegation_target_requires_approval',
    })
    const childRunId = h.events.find(
      (event) => event.type === 'run.created' && event.runId !== 'r1',
    )?.runId
    const write = requests.find((request) => request.tool.name === 'write_file')
    expect(write).toMatchObject({
      runId: childRunId,
      parentRunId: 'r1',
      agent: { id: 'builtin.reviewer', version: 1 },
    })
  })

  it('只读父运行限制写入子 Agent，即使子 Agent 允许写入', async () => {
    const requests: HostApprovalRequest[] = []
    const h = setup({
      targets: [
        { id: reviewer.id, definition: agent('builtin.reviewer', { permissions: 'auto' }) },
      ],
      permissionRules: presetRules('read-only'),
      approval: (request) => {
        requests.push(request)
        return { decision: 'allow_once' }
      },
      host: { registerTools },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_file', input: { path: 'a.ts' } },
              { kind: 'reply', text: '{"summary":"ok"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(requests.map((request) => request.tool.name)).toEqual(['delegate'])
    expect(h.events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      error: { code: 'tool.denied' },
    })
  })

  it('子 Agent 的路径策略阻止写测试目录之外的文件', async () => {
    const tester = agent('builtin.tester', {
      permissions: 'auto',
      pathPolicy: { write: ['**/*.{test,spec}.*', '**/tests/**'] },
    })
    const requests: HostApprovalRequest[] = []
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['builtin.tester'] },
      }),
      targets: [{ id: tester.id, definition: tester }],
      permissionRules: presetRules('auto'),
      approval: (request) => {
        requests.push(request)
        return { decision: 'allow_once' }
      },
      host: { registerTools },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.tester'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_file', input: { path: 'tests/a.ts' } },
              { kind: 'tool', name: 'write_file', input: { path: 'src/a.ts' } },
              { kind: 'reply', text: '{"summary":"ok"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed')

    expect(requests.map((request) => request.tool.name)).toEqual(['delegate'])
    expect(
      h.events
        .filter((event) => event.type === 'tool.requested')
        .map((event) => JSON.stringify(event.payload))
        .join('\n'),
    ).toContain('tests/a.ts')
    expect(h.events.filter((event) => event.type === 'tool.failed')).toHaveLength(1)
    expect(h.events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      error: { code: 'tool.denied' },
    })
  })

  it('嵌套委派继承整条祖先链的权限上限', async () => {
    const nestedReviewer = agent('builtin.reviewer', {
      permissions: 'read-only',
      delegation: { ...delegation, allowedAgents: ['builtin.coder'], maxDepth: 2 },
    })
    const coder = agent('builtin.coder', { permissions: 'auto' })
    const requests: HostApprovalRequest[] = []
    const h = setup({
      definition: parentDefinition({
        delegation: { ...delegation, allowedAgents: ['builtin.reviewer'], maxDepth: 2 },
      }),
      targets: [
        { id: nestedReviewer.id, definition: nestedReviewer },
        { id: coder.id, definition: coder },
      ],
      permissionRules: presetRules('auto'),
      approval: (request) => {
        requests.push(request)
        return { decision: 'allow_once' }
      },
      host: { registerTools },
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'done' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [delegateStep('builtin.coder'), { kind: 'reply', text: '{"summary":"child"}' }],
          },
        ],
      },
      grandchildScript: {
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_file', input: { path: 'a.ts' } },
              { kind: 'reply', text: '{"summary":"grandchild"}' },
            ],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('run.child.completed', 2)

    expect(requests.map((request) => request.tool.name)).toEqual(['delegate'])
    const grandchild = h.events.find(
      (event) =>
        event.type === 'run.created' &&
        (event.payload as { agent: { id: string } }).agent.id === 'builtin.coder',
    )?.runId
    expect(
      h.events.find((event) => event.type === 'tool.failed' && event.runId === grandchild)?.payload,
    ).toMatchObject({ error: { code: 'tool.denied' } })
  })

  it('按 Agent 权限向父运行与子运行下发命令沙箱（M5-04）', async () => {
    const sandbox: HostSandboxConfig = {
      policy: { profile: 'workspace-write', network: 'none' },
      capability: {
        available: true,
        supported: true,
        mechanism: 'restricted-token',
        networkIsolated: false,
        checks: {
          restrictedToken: true,
          lowIntegrity: true,
          jobObject: true,
          appContainer: false,
        },
      },
      unavailable: 'deny',
    }
    const h = setup({
      sandbox,
      definition: parentDefinition({ permissions: 'ask' }),
      permissionRules: presetRules('auto'),
      parentScript: {
        turns: [{ steps: [delegateStep('builtin.reviewer'), { kind: 'reply', text: 'ok' }] }],
      },
      childScript: {
        turns: [
          {
            steps: [{ kind: 'reply', text: '{"status":"completed","summary":"ok","output":{}}' }],
          },
        ],
      },
    })
    await h.initHost()
    await h.main.request('host.prompt', { messageId: 'm1', content: text('go') })
    await h.waitFor('turn.completed')
    expect(h.sandboxConfigs).toHaveLength(2)
    expect(h.sandboxConfigs).toEqual([
      sandbox,
      { ...sandbox, policy: { ...sandbox.policy, profile: 'read-only' } },
    ])
  })
})
