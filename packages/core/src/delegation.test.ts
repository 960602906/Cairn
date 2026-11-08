import type { DelegateInput, DelegationPolicy, RunLimits } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  createRunSupervisor,
  DelegationSession,
  FakeRuntime,
  TASK_BRIEF_TOTAL_MAX_CHARS,
  briefPrompt,
  delegateInputSchema,
  delegateToolSpec,
  parseDelegateReply,
  resolveDelegationPolicy,
  resolveDelegationWorkspace,
  runDelegation,
  summarizeChildTurn,
  taskBriefSize,
  validateDelegation,
  type RunContext,
  type RunEvent,
  type WorkspaceInfo,
} from './index.js'
import type { ResolvedModel } from './runtime.js'

const model: ResolvedModel = {
  ref: { providerId: 'fake', modelId: 'fake-1' },
  providerKind: 'anthropic',
  baseUrl: 'http://localhost:0',
  profile: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
  },
}

const policy = (patch: Partial<DelegationPolicy> = {}): DelegationPolicy => ({
  enabled: true,
  allowedAgents: ['builtin.reviewer'],
  maxDepth: 2,
  maxChildrenPerTurn: 6,
  maxParallel: 3,
  childBudgetShare: 0.5,
  defaultWorkspace: 'shared',
  mergeReview: 'user',
  ...patch,
})

const delegate = (patch: Partial<DelegateInput> = {}): DelegateInput => ({
  agent: 'builtin.reviewer',
  task: 'review the diff',
  brief: { goal: 'Review the change', deliverable: 'A list of findings' },
  ...patch,
})

const baseValidation = {
  policy: policy(),
  input: delegate(),
  chain: { agentIds: ['builtin.coder'], depth: 0 },
  childrenThisTurn: 0,
  runningChildren: 0,
  duplicateCount: 0,
}

describe('resolveDelegationPolicy', () => {
  it('省略时全部取默认值，委派未启用', () => {
    expect(resolveDelegationPolicy(undefined)).toEqual({
      enabled: false,
      allowedAgents: [],
      maxDepth: 1,
      maxChildrenPerTurn: 6,
      maxParallel: 3,
      childBudgetShare: 0.5,
      defaultWorkspace: 'auto',
      mergeReview: 'user',
    })
  })

  it('钳到全局硬上限并把非法数字换成默认值', () => {
    expect(
      resolveDelegationPolicy({
        enabled: true,
        maxDepth: 99,
        maxChildrenPerTurn: 0,
        maxParallel: 99,
        childBudgetShare: 4,
      }),
    ).toMatchObject({
      maxDepth: 3,
      maxChildrenPerTurn: 1,
      maxParallel: 8,
      childBudgetShare: 1,
    })
    expect(
      resolveDelegationPolicy({
        maxDepth: Number.NaN,
        maxParallel: Number.POSITIVE_INFINITY,
        childBudgetShare: Number.NaN,
      }),
    ).toMatchObject({ maxDepth: 1, maxParallel: 3, childBudgetShare: 0.5 })
    expect(resolveDelegationPolicy({ childBudgetShare: -1 })).toMatchObject({
      childBudgetShare: 0,
    })
    expect(resolveDelegationPolicy({ maxDepth: -2, maxChildrenPerTurn: -1 })).toMatchObject({
      maxDepth: 0,
      maxChildrenPerTurn: 1,
    })
  })
})

describe('validateDelegation', () => {
  it('合法委派没有 error', () => {
    expect(validateDelegation(baseValidation)).toEqual({ ok: true, issues: [] })
  })

  it('未启用、目标不在 allowedAgents、未发布', () => {
    expect(
      validateDelegation({ ...baseValidation, policy: policy({ enabled: false }) }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.disabled' }))
    expect(
      validateDelegation({ ...baseValidation, input: delegate({ agent: 'other' }) }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.agent_not_allowed' }))
    expect(validateDelegation({ ...baseValidation, targetPublished: false }).issues).toContainEqual(
      expect.objectContaining({ code: 'delegation.agent_not_published' }),
    )
  })

  it('深度 1/2/3 与链路沿用上限', () => {
    const depth = (n: number, patch: Partial<DelegationPolicy> = {}) =>
      validateDelegation({
        ...baseValidation,
        policy: policy(patch),
        chain: { agentIds: ['builtin.coder'], depth: n },
      })
    expect(depth(0, { maxDepth: 1 }).ok).toBe(true)
    expect(depth(1, { maxDepth: 1 }).issues).toContainEqual(
      expect.objectContaining({ code: 'delegation.depth_exceeded' }),
    )
    expect(depth(1, { maxDepth: 2 }).ok).toBe(true)
    expect(depth(2, { maxDepth: 2 }).issues).toContainEqual(
      expect.objectContaining({ code: 'delegation.depth_exceeded' }),
    )
    expect(
      validateDelegation({
        ...baseValidation,
        policy: policy({ maxDepth: 3 }),
        chain: { agentIds: ['builtin.coder'], depth: 1, maxDepth: 1 },
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.depth_exceeded' }))
  })

  it('循环委派与重复任务：第二次警告，第三次拒绝', () => {
    expect(
      validateDelegation({
        ...baseValidation,
        chain: { agentIds: ['builtin.reviewer'], depth: 1 },
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.cycle_detected' }))
    const second = validateDelegation({ ...baseValidation, duplicateCount: 2 })
    expect(second.ok).toBe(true)
    expect(second.issues).toEqual([
      expect.objectContaining({ code: 'delegation.duplicate_task', severity: 'warning' }),
    ])
    expect(validateDelegation({ ...baseValidation, duplicateCount: 3 }).ok).toBe(false)
  })

  it('每轮子运行数与并行数上限', () => {
    expect(
      validateDelegation({
        ...baseValidation,
        policy: policy({ maxChildrenPerTurn: 2 }),
        childrenThisTurn: 2,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.children_per_turn_exceeded' }))
    expect(
      validateDelegation({
        ...baseValidation,
        policy: policy({ maxParallel: 2 }),
        runningChildren: 2,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.parallel_exceeded' }))
  })

  it('任务书大小上限按字符数计算', () => {
    const big = delegate({
      brief: {
        goal: 'g'.repeat(TASK_BRIEF_TOTAL_MAX_CHARS),
        deliverable: 'd',
      },
    })
    expect(taskBriefSize(big.brief)).toBe(TASK_BRIEF_TOTAL_MAX_CHARS + 1)
    expect(
      taskBriefSize({ goal: 'g', deliverable: 'd', files: ['a.ts'], constraints: ['x'] }),
    ).toBe(7)
    expect(validateDelegation({ ...baseValidation, input: big }).issues).toContainEqual(
      expect.objectContaining({ code: 'delegation.brief_too_large' }),
    )
  })

  it('任务书预算不能超过父运行剩余额度', () => {
    const remaining: Partial<RunLimits> = { maxStepsPerTurn: 3, maxTokensPerTurn: 100 }
    expect(
      validateDelegation({
        ...baseValidation,
        input: delegate({ brief: { goal: 'g', deliverable: 'd', budget: { maxStepsPerTurn: 4 } } }),
        parentRemaining: remaining,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'delegation.budget_exceeded' }))
    expect(
      validateDelegation({
        ...baseValidation,
        input: delegate({ brief: { goal: 'g', deliverable: 'd', budget: { maxStepsPerTurn: 3 } } }),
        parentRemaining: remaining,
      }).ok,
    ).toBe(true)
    for (const [key, value] of [
      ['maxTokensPerTurn', 101],
      ['maxCostPerTurn', 1],
      ['maxTurnDurationMs', 4],
    ] as const) {
      expect(
        validateDelegation({
          ...baseValidation,
          input: delegate({ brief: { goal: 'g', deliverable: 'd', budget: { [key]: value } } }),
          parentRemaining: { ...remaining, maxCostPerTurn: 0.5, maxTurnDurationMs: 3 },
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'delegation.budget_exceeded' }))
    }
  })

  it('父运行任一剩余额度为 0 时不能继续分派（M4-03）', () => {
    for (const key of [
      'maxStepsPerTurn',
      'maxTokensPerTurn',
      'maxCostPerTurn',
      'maxTurnDurationMs',
    ] as const) {
      const result = validateDelegation({
        ...baseValidation,
        parentRemaining: { [key]: 0 },
      })
      expect(result.ok).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'delegation.budget_exceeded', severity: 'error' }),
      )
    }
  })

  it('隔离工作区在 M4-08 后允许委派', () => {
    expect(
      validateDelegation({ ...baseValidation, input: delegate({ workspace: 'isolated' }) }).ok,
    ).toBe(true)
    expect(resolveDelegationWorkspace(policy({ defaultWorkspace: 'isolated' }), delegate())).toBe(
      'isolated',
    )
    expect(resolveDelegationWorkspace(policy(), delegate())).toBe('shared')
    expect(
      resolveDelegationWorkspace(
        policy({ defaultWorkspace: 'isolated' }),
        delegate({ workspace: 'shared' }),
      ),
    ).toBe('shared')
  })

  it('auto 工作区按目标 Agent 权限选择共享或隔离', () => {
    const auto = policy({ defaultWorkspace: 'auto' })
    expect(resolveDelegationWorkspace(auto, delegate(), 'read-only')).toBe('shared')
    expect(resolveDelegationWorkspace(auto, delegate(), 'ask')).toBe('isolated')
    expect(resolveDelegationWorkspace(auto, delegate(), 'auto')).toBe('isolated')
    // 显式请求优先于目标权限
    expect(resolveDelegationWorkspace(auto, delegate({ workspace: 'shared' }), 'auto')).toBe(
      'shared',
    )
    expect(resolveDelegationWorkspace(auto, delegate({ workspace: 'isolated' }), 'read-only')).toBe(
      'isolated',
    )
  })
})

describe('delegate 工具说明', () => {
  it('没有目标时没有工具', () => {
    expect(delegateToolSpec([])).toBeUndefined()
  })

  it('列出目标名称与描述，并把参数标为可并行', () => {
    const spec = delegateToolSpec([
      { id: 'builtin.reviewer', name: 'Reviewer', description: 'Reviews diffs' },
    ])
    expect(spec).toMatchObject({ name: 'delegate', parallel: true })
    expect(spec?.description).toContain('builtin.reviewer: Reviewer — Reviews diffs')
    const schema = delegateInputSchema() as {
      properties: { agent: { type: string } }
      required: string[]
    }
    expect(schema.properties.agent.type).toBe('string')
    expect(schema.required).toEqual(['agent', 'task', 'brief'])
    expect(delegateInputSchema()).toMatchObject({ type: 'object' })
  })
})

describe('DelegationSession', () => {
  it('按轮清空计数与重复记录', async () => {
    const supervisor = createRunSupervisor({
      runtime: new FakeRuntime({ turns: [] }),
      model,
      signal: new AbortController().signal,
    })
    const parent = await supervisor.createRun({
      sessionId: 's1',
      agent: { id: 'builtin.coder', version: 1 },
      workspace: { path: '/w' },
      mode: 'interactive',
    })
    const session = new DelegationSession({
      policy: policy(),
      parent,
      chain: { agentIds: ['builtin.coder'], depth: 0 },
    })
    session.record(delegate())
    session.enter()
    expect(session.childrenThisTurn).toBe(1)
    expect(session.runningChildren).toBe(1)
    expect(session.validate(delegate()).ok).toBe(true)
    session.record(delegate())
    expect(session.validate(delegate()).ok).toBe(true)
    session.record(delegate())
    expect(session.validate(delegate()).issues).toContainEqual(
      expect.objectContaining({ code: 'delegation.duplicate_task', severity: 'error' }),
    )
    session.leave()
    await parent.send({ messageId: 'm1', content: [{ type: 'text', text: 'hi' }] })
    expect(session.childrenThisTurn).toBe(0)
    expect(session.runningChildren).toBe(0)
    expect(session.validate(delegate()).ok).toBe(true)
    expect(
      session.validate(delegate(), {
        targetPublished: true,
        parentRemaining: { maxStepsPerTurn: 5 },
      }).ok,
    ).toBe(true)
  })
})

describe('parseDelegateReply', () => {
  const outputSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  }

  it('解析 JSON 信封与 Markdown 围栏', () => {
    expect(parseDelegateReply('{"summary":"done","output":{"answer":"42"}}', outputSchema)).toEqual(
      { status: 'completed', summary: 'done', output: { answer: '42' } },
    )
    expect(
      parseDelegateReply(
        '```json\n{"status":"needs_input","summary":"?","question":"Which?"}\n```',
      ),
    ).toEqual({ status: 'needs_input', summary: '?', question: 'Which?' })
    expect(parseDelegateReply('```\n{"summary":"plain fence"}\n```')).toEqual({
      status: 'completed',
      summary: 'plain fence',
    })
  })

  it('拒绝不合规、多余字段与不符合 outputSchema 的结果', () => {
    expect(parseDelegateReply('not json')).toBeUndefined()
    expect(parseDelegateReply('{"summary":""}')).toBeUndefined()
    expect(parseDelegateReply('{"summary":"ok","extra":1}')).toBeUndefined()
    expect(
      parseDelegateReply('{"summary":"ok","output":{"answer":1}}', outputSchema),
    ).toBeUndefined()
    expect(
      parseDelegateReply(
        '{"summary":"ok","output":{"answer":"42"}}',
        // 不受支持的 schema 不做结构校验，仍返回结果
        { type: 'object', properties: { answer: { type: 'unknown-type' } } },
      ),
    ).toEqual({ status: 'completed', summary: 'ok', output: { answer: '42' } })
  })
})

describe('summarizeChildTurn', () => {
  it('汇总回复、用量、步数与耗时（取事件信封时间）', () => {
    expect(
      summarizeChildTurn([
        { type: 'turn.started', payload: {}, ts: 10 },
        { type: 'step.started', payload: {}, ts: 11 },
        {
          type: 'message.assistant.completed',
          payload: {
            content: [
              { type: 'text', text: 'hello ' },
              { type: 'text', text: 'world' },
            ],
          },
          ts: 12,
        },
        {
          type: 'usage.reported',
          payload: { usage: { inputTokens: 3, outputTokens: 2 } },
          ts: 13,
        },
        {
          type: 'usage.reported',
          payload: { usage: { inputTokens: 1, outputTokens: 1 } },
          ts: 14,
        },
        { type: 'turn.completed', payload: { durationMs: 1 }, ts: 25 },
      ]),
    ).toEqual({
      reply: 'hello world',
      usage: { inputTokens: 4, outputTokens: 3 },
      steps: 1,
      durationMs: 15,
    })
    expect(
      summarizeChildTurn([
        {
          type: 'message.assistant.completed',
          payload: { content: [{ type: 'text' }, { type: 'image' }] },
          ts: 2,
        },
      ]).reply,
    ).toBe('')
  })

  it('没有起止事件时耗时为 0', () => {
    expect(summarizeChildTurn([])).toEqual({
      reply: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: 0,
      durationMs: 0,
    })
  })
})

describe('briefPrompt', () => {
  it('包含目标、交付物、上下文、文件与约束', () => {
    const prompt = briefPrompt(
      delegate({
        brief: {
          goal: 'Goal',
          deliverable: 'Deliverable',
          context: 'Context',
          files: ['a.ts'],
          constraints: ['no writes'],
        },
      }),
    )
    expect(prompt).toContain('# Task\nGoal')
    expect(prompt).toContain('## Deliverable\nDeliverable')
    expect(prompt).toContain('## Context\nContext')
    expect(prompt).toContain('- a.ts')
    expect(prompt).toContain('- no writes')
  })
})

describe('runDelegation', () => {
  const workspace: WorkspaceInfo = { path: '/w' }

  async function parentRun(runtime: FakeRuntime, limits: Partial<RunLimits> = {}) {
    const supervisor = createRunSupervisor({
      runtime,
      model,
      limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000 },
      signal: new AbortController().signal,
    })
    const events: RunEvent[] = []
    supervisor.onEvent((event) => events.push(event))
    const parent = await supervisor.createRun({
      sessionId: 's1',
      runId: 'parent',
      agent: { id: 'builtin.coder', version: 1 },
      workspace,
      mode: 'interactive',
      limitsOverride: limits,
    })
    const session = new DelegationSession({
      policy: policy(),
      parent,
      chain: { agentIds: ['builtin.coder'], depth: 0 },
    })
    return { supervisor, parent, events, session }
  }

  const childContext = (runtime: FakeRuntime, extra: Partial<RunContext> = {}): RunContext => ({
    runtime,
    model,
    systemPrompt: 'child prompt',
    tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }],
    executeTool: async () => ({ status: 'ok', content: [{ type: 'text', text: 'found' }] }),
    ...extra,
  })

  it('创建子运行、等待结果并回填父运行', async () => {
    const child = new FakeRuntime({
      turns: [
        {
          steps: [
            {
              kind: 'reply',
              text: '{"status":"completed","summary":"all good","output":{"answer":"ok"}}',
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          ],
        },
      ],
    })
    const { supervisor, parent, events, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: childContext(child), workspace },
      input: delegate({ workspace: 'shared' }),
      parentRemaining: { maxStepsPerTurn: 8, maxTokensPerTurn: 1000 },
      systemPrompt: 'child prompt',
      now: () => 100,
    })
    expect(result).toMatchObject({
      status: 'completed',
      summary: 'all good',
      output: { answer: 'ok' },
      usage: { tokens: 15, steps: 1, durationMs: 0, cost: 0.000105 },
      childRunId: 'run-1',
    })
    expect(supervisor.listChildren('parent')).toHaveLength(1)
    const delegated = events.find((event) => event.type === 'run.delegated')
    expect(delegated).toMatchObject({
      runId: 'parent',
      payload: {
        childRunId: 'run-1',
        agent: { id: 'builtin.reviewer', version: 1 },
        task: 'review the diff',
        workspace: 'shared',
        workspacePath: '/w',
        budget: { maxStepsPerTurn: 4, maxTokensPerTurn: 500 },
      },
    })
    expect(events.find((event) => event.type === 'run.child.completed')).toMatchObject({
      runId: 'parent',
      payload: { childRunId: 'run-1', status: 'completed', summary: 'all good' },
    })
  })

  it('结构不合规时让子运行修正一次', async () => {
    const child = new FakeRuntime({
      turns: [
        { steps: [{ kind: 'reply', text: 'not json' }] },
        { steps: [{ kind: 'reply', text: '{"summary":"fixed"}' }] },
      ],
    })
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: {
        definition: definition(),
        context: childContext(child),
        workspace,
      },
      input: delegate({ brief: { goal: 'g', deliverable: 'd', outputSchema: { type: 'object' } } }),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result.summary).toBe('fixed')
    expect(result.status).toBe('completed')
  })

  it('子运行失败时状态为 failed，并把原文作为摘要', async () => {
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const failing = childContext(new FakeRuntime({ turns: [] }), {
      runtime: new FakeRuntime({
        turns: [{ steps: [{ kind: 'fail', error: { code: 'model.error' }, retryable: false }] }],
      }),
    })
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: failing, workspace },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result.status).toBe('failed')
    expect(result.summary).toBe('Sub-agent did not finish.')
  })

  it('子运行达到限额时状态为 limit_reached', async () => {
    const child = new FakeRuntime({
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'lookup', input: {} },
            { kind: 'reply', text: '{"summary":"late"}' },
          ],
        },
      ],
    })
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: {
        definition: { ...definition(), limits: { maxStepsPerTurn: 1 } },
        context: childContext(child),
        workspace,
      },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result.status).toBe('limit_reached')
  })

  it('子运行被中止时状态为 aborted，父运行继续', async () => {
    const child = new FakeRuntime({
      turns: [
        {
          steps: [
            {
              kind: 'reply',
              text: '{"summary":"never"}',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          ],
        },
      ],
      delayMs: 5,
    })
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    let created: { abort(reason?: 'user' | 'shutdown'): Promise<void> } | undefined
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: {
        definition: definition(),
        context: childContext(child),
        workspace,
      },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
      onChildCreated: (handle) => {
        created = handle
        setTimeout(() => void handle.abort('user'), 0)
      },
    })
    expect(created).toBeDefined()
    expect(result.status).toBe('aborted')
    expect(parent.state).not.toBe('failed')
  })

  it('父运行没有剩余预算时状态为 limit_reached 并停止其他子运行（M4-03）', async () => {
    const { supervisor, parent, events, session } = await parentRun(
      new FakeRuntime({ turns: [] }),
      { maxTokensPerTurn: 0 },
    )
    const sibling = await supervisor.createRun({
      sessionId: 's1',
      runId: 'sibling',
      parentRunId: 'parent',
      agent: { id: 'builtin.reviewer', version: 1 },
      workspace,
      mode: 'interactive',
      context: childContext(
        new FakeRuntime({
          delayMs: 30,
          turns: [{ steps: [{ kind: 'reply', text: 'slow' }] }],
        }),
      ),
    })
    const siblingDone = sibling.send({ messageId: 'm2', content: [{ type: 'text', text: 'go' }] })
    const child = new FakeRuntime({
      turns: [
        {
          steps: [
            {
              kind: 'reply',
              text: '{"summary":"done"}',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          ],
        },
      ],
    })
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: childContext(child), workspace },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    await siblingDone
    expect(result.status).toBe('limit_reached')
    expect(
      events.filter((event) => event.runId === 'sibling').map((event) => event.type),
    ).toContain('turn.aborted')
    expect(events.find((event) => event.type === 'run.child.completed')).toMatchObject({
      payload: { status: 'limit_reached' },
    })
  })

  it('needs_input 透传问题', async () => {
    const child = new FakeRuntime({
      turns: [
        {
          steps: [
            {
              kind: 'reply',
              text: '{"status":"needs_input","summary":"need info","question":"Which file?"}',
            },
          ],
        },
      ],
    })
    const { supervisor, parent, events, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: childContext(child), workspace },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result).toMatchObject({
      status: 'needs_input',
      question: 'Which file?',
      summary: 'need info',
    })
    expect(events.find((event) => event.type === 'run.child.completed')).toMatchObject({
      payload: { issues: ['Which file?'] },
    })
  })

  it('没有回复时给出说明性摘要', async () => {
    const child = new FakeRuntime({ turns: [{ steps: [{ kind: 'reply', text: '' }] }] })
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: childContext(child), workspace },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result.summary).toBe('Sub-agent finished without a textual answer.')
  })

  it('纯文本回复时把原文作为摘要', async () => {
    const child = new FakeRuntime({
      turns: [{ steps: [{ kind: 'reply', text: 'plain answer' }] }],
    })
    const { supervisor, parent, events, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: { definition: definition(), context: childContext(child), workspace },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result).toMatchObject({ status: 'completed', summary: 'plain answer' })
    expect(events.find((event) => event.type === 'run.child.completed')).toMatchObject({
      payload: { summary: 'plain answer' },
    })
  })

  it('子运行没有模型单价时不估算费用', async () => {
    const child = new FakeRuntime({
      turns: [{ steps: [{ kind: 'reply', text: '{"summary":"ok"}' }] }],
    })
    const { pricing: _pricing, ...profile } = model.profile
    const { supervisor, parent, session } = await parentRun(new FakeRuntime({ turns: [] }))
    const result = await runDelegation({
      sessionId: 's1',
      supervisor,
      parent,
      session,
      target: {
        definition: definition(),
        context: childContext(child, { model: { ...model, profile } }),
        workspace,
      },
      input: delegate(),
      parentRemaining: {},
      systemPrompt: 'child prompt',
    })
    expect(result.usage.cost).toBeUndefined()
  })
})

function definition() {
  return {
    id: 'builtin.reviewer',
    version: 1,
    source: 'builtin' as const,
    status: 'published' as const,
    name: { 'en-US': 'Reviewer' },
    description: { 'en-US': 'Reviews' },
    instructions: 'Review carefully.',
    model: { mode: 'inherit' as const },
    tools: { allow: ['*'] },
    skills: { allow: [] },
    permissions: 'read-only' as const,
    limits: { maxStepsPerTurn: 5, maxTurnDurationMs: 30_000, maxConsecutiveToolErrors: 3 },
    context: { includeProjectInstructions: true, compaction: 'auto' as const },
    memory: { scopes: [], write: 'never' as const },
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 1 as const,
  }
}
