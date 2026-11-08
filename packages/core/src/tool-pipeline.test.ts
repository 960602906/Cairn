import type { EventPayload } from '@cairn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeRuntime } from './fake-runtime.js'
import { TOOL_OUTPUT_MAX_TOKENS } from './context-budget.js'
import type { Logger } from './logger.js'
import { RunEngine } from './run-engine.js'
import {
  combinePermissionDecisions,
  combinePermissionGates,
  createToolPipeline,
  truncateOutput,
  type ApprovalGate,
  type PermissionDecision,
  type PermissionGate,
  type ToolCallObserver,
  type ToolPipelineOptions,
} from './tool-pipeline.js'
import {
  createToolRegistry,
  ToolError,
  type ToolCheckpoints,
  type ToolContext,
  type ToolDefinition,
} from './tools.js'
import type { ResolvedModel } from './runtime.js'

type Input = { path: string }

const noopLogger: Logger = {
  level: 'error',
  setLevel: () => {},
  isEnabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

const text = (t: string) => [{ type: 'text' as const, text: t }]

function tool(over: Partial<ToolDefinition<Input>> = {}): ToolDefinition<Input> {
  return {
    name: 'write_file',
    description: 'Write a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    category: 'write',
    source: { kind: 'builtin' },
    trust: 'builtin',
    execute: async ({ path }, ctx) => {
      ctx.progress('writing\n')
      ctx.progress('warn\n', 'stderr')
      return { content: text(`wrote ${path}`) }
    },
    ...over,
  }
}

interface Harness {
  options: ToolPipelineOptions
  observer: ToolCallObserver
  log: string[]
  decide: ReturnType<typeof vi.fn<PermissionGate['decide']>>
  request: ReturnType<typeof vi.fn<ApprovalGate['request']>>
  checkpoint: ReturnType<typeof vi.fn<ToolCheckpoints['create']>>
}

function setup(
  definitions: ToolDefinition<Input>[] = [tool()],
  over: Partial<ToolPipelineOptions> = {},
  decision: PermissionDecision = { decision: 'allow' },
): Harness {
  const registry = createToolRegistry()
  for (const d of definitions) registry.register(d)
  const log: string[] = []
  const decide = vi.fn<PermissionGate['decide']>(async () => decision)
  const request = vi.fn<ApprovalGate['request']>(async () => ({ decision: 'allow_once' }))
  const checkpoint = vi.fn<ToolCheckpoints['create']>(async () => 'cp1')
  let id = 0
  const options: ToolPipelineOptions = {
    registry,
    permissions: { decide },
    approvals: { request },
    checkpoints: { create: checkpoint },
    workspaceRoot: '/work',
    resolvePath: async (input) => ({
      ok: true,
      path: { absolute: `/work/${input}`, relative: input },
    }),
    log: noopLogger,
    createId: () => `a${++id}`,
    ...over,
  }
  const observer: ToolCallObserver = {
    started: () => log.push('started'),
    output: (t, stream) => log.push(`${stream}:${t}`),
    awaitingApproval: (waiting) => log.push(waiting ? 'wait' : 'resume'),
    emit: (type, payload) => log.push(`${type}:${JSON.stringify(payload)}`),
  }
  return { options, observer, log, decide, request, checkpoint }
}

const call = (input: unknown, name = 'write_file') => ({ id: 'c1', name, input })
const signal = () => new AbortController().signal

describe('ToolPipeline：成功路径', () => {
  it('依次经过各阶段，流式输出，返回结果', async () => {
    const h = setup()
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'a.ts' }),
      signal(),
      h.observer,
    )
    expect(outcome).toEqual({ status: 'ok', content: text('wrote a.ts'), truncated: false })
    expect(h.decide).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'c1', input: { path: 'a.ts' }, targets: {} }),
    )
    // 写文件类工具依靠改动记录撤销，不单独创建检查点
    expect(h.checkpoint).not.toHaveBeenCalled()
    expect(h.log).toEqual(['started', 'stdout:writing\n', 'stderr:warn\n'])
  })

  it('工具给出的 display 原样带出（M2-06）', async () => {
    const display = {
      kind: 'terminal' as const,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      shell: 'bash',
      cwd: '/work',
      chunks: [],
      omittedChars: 0,
    }
    const h = setup([tool({ execute: async () => ({ content: text('ok'), display }) })])
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'a.ts' }),
      signal(),
      h.observer,
    )
    expect(outcome).toEqual({ status: 'ok', content: text('ok'), truncated: false, display })
  })

  it('7. 执行命令前创建检查点并发出 checkpoint.created；不可用时直接执行', async () => {
    const h = setup([tool({ name: 'run_command', category: 'execute' })])
    const pipeline = createToolPipeline(h.options)
    expect(
      await pipeline.run(call({ path: 'a' }, 'run_command'), signal(), h.observer),
    ).toMatchObject({ status: 'ok' })
    expect(h.checkpoint).toHaveBeenCalledWith('before_command')
    expect(h.log[0]).toBe('checkpoint.created:{"checkpointId":"cp1","reason":"before_command"}')
    h.checkpoint.mockResolvedValueOnce(undefined)
    h.log.length = 0
    expect(
      await pipeline.run(call({ path: 'a' }, 'run_command'), signal(), h.observer),
    ).toMatchObject({ status: 'ok' })
    expect(h.log.some((entry) => entry.startsWith('checkpoint.created'))).toBe(false)
    expect(h.request).not.toHaveBeenCalled()
  })

  it('只读工具不创建检查点；normalize 的结果用于权限判定与执行', async () => {
    const execute = vi.fn(async ({ path }: Input, _ctx: ToolContext) => ({ content: text(path) }))
    const h = setup([
      tool({
        name: 'read_file',
        category: 'read',
        normalize: async (input, ctx) => {
          const resolved = await ctx.resolvePath(input.path)
          if (!resolved.ok) throw new ToolError(resolved.code, 'bad path')
          return {
            input: { path: resolved.path.absolute },
            targets: { paths: [resolved.path.relative] },
          }
        },
        execute,
      }),
    ])
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'src/a.ts' }, 'read_file'),
      signal(),
      h.observer,
    )
    expect(outcome).toMatchObject({ status: 'ok', content: text('/work/src/a.ts') })
    expect(h.decide.mock.calls[0]![0].targets).toEqual({ paths: ['src/a.ts'] })
    expect(h.checkpoint).not.toHaveBeenCalled()
    expect(execute.mock.calls[0]![1]).toMatchObject({
      workspaceRoot: '/work',
      toolCallId: 'c1',
      maxOutputTokens: TOOL_OUTPUT_MAX_TOKENS,
    })
  })

  it('输出超过上限时保留开头和结尾', async () => {
    const h = setup(
      [tool({ execute: async () => ({ content: text('a'.repeat(50) + 'b'.repeat(50)) }) })],
      { maxOutputTokens: 5 },
    )
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'x' }),
      signal(),
      h.observer,
    )
    expect(outcome).toMatchObject({ status: 'ok', truncated: true })
    expect(outcome).not.toHaveProperty('display')
    const result = (outcome as unknown as { content: { text: string }[] }).content[0]!.text
    // 按估算的 token：开头 3 个（12 个英文字符）、结尾 2 个（8 个）
    expect(result.startsWith(`${'a'.repeat(12)}\n\n[... 80 characters truncated:`)).toBe(true)
    expect(result).toContain('about 5 tokens')
    expect(result).toContain('read_file with offset and limit')
    expect(result.endsWith(`]\n\n${'b'.repeat(8)}`)).toBe(true)
  })
})

describe('ToolPipeline：各阶段的失败', () => {
  it('1. 工具不存在', async () => {
    const h = setup()
    expect(await createToolPipeline(h.options).run(call({}, 'nope'), signal(), h.observer)).toEqual(
      {
        status: 'error',
        content: text('Unknown tool: nope'),
        error: { code: 'tool.not_found', params: { name: 'nope' } },
      },
    )
  })

  it('2. 参数非法，附问题说明', async () => {
    const h = setup()
    const outcome = await createToolPipeline(h.options).run(call({ path: 1 }), signal(), h.observer)
    expect(outcome).toMatchObject({
      status: 'error',
      error: { code: 'tool.invalid_input', params: { name: 'write_file' } },
    })
    expect(outcome.content[0]).toMatchObject({ text: expect.stringContaining('- path:') })
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('3. 不在 Agent 的允许列表内', async () => {
    const h = setup([tool()], { isAvailable: (d) => d.category === 'read' })
    expect(
      await createToolPipeline(h.options).run(call({ path: 'a' }), signal(), h.observer),
    ).toMatchObject({
      status: 'error',
      error: { code: 'tool.not_available' },
    })
  })

  it('4. 规范化失败（如路径越界）', async () => {
    const h = setup([
      tool({
        normalize: async () => {
          throw new ToolError('path.outside_workspace', 'Path is outside the workspace: ../x', {
            path: '../x',
          })
        },
      }),
    ])
    expect(
      await createToolPipeline(h.options).run(call({ path: '../x' }), signal(), h.observer),
    ).toEqual({
      status: 'error',
      content: text('Path is outside the workspace: ../x'),
      error: { code: 'path.outside_workspace', params: { path: '../x' } },
    })
  })

  it('5. 权限拒绝，理由交给模型', async () => {
    const h = setup(
      [tool()],
      {},
      {
        decision: 'deny',
        reasonCode: 'rule.deny',
        reason: 'Writing to .env is not allowed.',
      },
    )
    expect(
      await createToolPipeline(h.options).run(call({ path: '.env' }), signal(), h.observer),
    ).toEqual({
      status: 'denied',
      content: text('Writing to .env is not allowed.'),
      error: { code: 'tool.denied', params: { reason: 'Writing to .env is not allowed.' } },
    })
    const fallback = setup([tool()], {}, { decision: 'deny', reasonCode: 'rule.deny' })
    const outcome = await createToolPipeline(fallback.options).run(
      call({ path: 'a' }),
      signal(),
      fallback.observer,
    )
    expect(outcome.content).toEqual(text('Tool call denied (rule.deny).'))
  })

  it('6. 审批：先生成预览，等待中发出审批事件；拒绝时附用户说明', async () => {
    const h = setup(
      [
        tool({
          describeForApproval: async ({ path }) => ({ summary: `write ${path}`, diff: '+x' }),
        }),
      ],
      {},
      { decision: 'ask', reasonCode: 'rule.ask', matchedRuleIds: ['r1'] },
    )
    h.request.mockResolvedValueOnce({ decision: 'deny', feedback: 'use b.ts instead' })
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'a.ts' }),
      signal(),
      h.observer,
    )
    expect(outcome).toEqual({
      status: 'denied',
      content: text('The user denied this tool call. User feedback: use b.ts instead'),
      error: { code: 'tool.denied', params: { reason: 'The user denied this tool call.' } },
    })
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'a1',
        kind: 'tool',
        preview: { summary: 'write a.ts', diff: '+x' },
        reasonCode: 'rule.ask',
        matchedRuleIds: ['r1'],
      }),
    )
    expect(h.log).toEqual([
      'wait',
      'approval.requested:{"approvalId":"a1","toolCallId":"c1","matchedRuleIds":["r1"],"reasonCode":"rule.ask"}',
      'approval.resolved:{"approvalId":"a1","decision":"deny","decidedBy":"user","feedback":"use b.ts instead"}',
      'resume',
    ])
  })

  it('6. 审批通过后执行（没有预览函数时不带预览）', async () => {
    const h = setup([tool()], {}, { decision: 'ask', reasonCode: 'rule.ask' })
    const outcome = await createToolPipeline(h.options).run(
      call({ path: 'a.ts' }),
      signal(),
      h.observer,
    )
    expect(outcome.status).toBe('ok')
    expect(h.request.mock.calls[0]![0]).not.toHaveProperty('preview')
    expect(h.log.slice(0, 4)).toEqual([
      'wait',
      'approval.requested:{"approvalId":"a1","toolCallId":"c1","matchedRuleIds":[],"reasonCode":"rule.ask"}',
      'approval.resolved:{"approvalId":"a1","decision":"allow_once","decidedBy":"user"}',
      'resume',
    ])
  })

  it('7. 检查点失败时请用户确认；不继续则拒绝，继续则执行', async () => {
    const h = setup([tool({ category: 'execute' })])
    h.checkpoint.mockRejectedValue(new Error('disk full'))
    h.request.mockResolvedValueOnce({ decision: 'deny' })
    const pipeline = createToolPipeline(h.options)
    expect(await pipeline.run(call({ path: 'a' }), signal(), h.observer)).toMatchObject({
      status: 'denied',
      error: { code: 'tool.denied' },
    })
    expect(h.request.mock.calls[0]![0]).toMatchObject({
      kind: 'no_checkpoint',
      reasonCode: 'checkpoint.failed',
    })
    expect(await pipeline.run(call({ path: 'a' }), signal(), h.observer)).toMatchObject({
      status: 'ok',
    })
  })

  it('8. 工具报告的错误与意外异常', async () => {
    const h = setup([
      tool({
        execute: async () => {
          throw new ToolError('file.not_found', 'File not found: a.ts')
        },
      }),
      tool({
        name: 'broken',
        execute: async () => {
          throw new Error('boom')
        },
      }),
    ])
    const pipeline = createToolPipeline(h.options)
    expect(await pipeline.run(call({ path: 'a.ts' }), signal(), h.observer)).toEqual({
      status: 'error',
      content: text('File not found: a.ts'),
      error: { code: 'file.not_found' },
    })
    expect(await pipeline.run(call({ path: 'a' }, 'broken'), signal(), h.observer)).toEqual({
      status: 'error',
      content: text('Tool broken failed unexpectedly.'),
      error: { code: 'tool.execution_failed', params: { name: 'broken' } },
    })
  })
})

describe('ToolPipeline：取消', () => {
  it('开始前已取消', async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    expect(
      await createToolPipeline(h.options).run(call({ path: 'a' }), controller.signal, h.observer),
    ).toEqual({
      status: 'cancelled',
      content: text('Tool call was cancelled.'),
    })
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('执行中取消：不等工具结束', async () => {
    const controller = new AbortController()
    const h = setup([tool({ execute: () => new Promise(() => undefined) })])
    const pending = createToolPipeline(h.options).run(
      call({ path: 'a' }),
      controller.signal,
      h.observer,
    )
    await vi.waitFor(() => expect(h.log).toContain('started'))
    controller.abort()
    expect((await pending).status).toBe('cancelled')
  })

  it('等待审批时取消：审批记为 cancelled', async () => {
    const controller = new AbortController()
    const h = setup([tool()], {}, { decision: 'ask', reasonCode: 'rule.ask' })
    h.request.mockReturnValue(new Promise(() => undefined))
    const pending = createToolPipeline(h.options).run(
      call({ path: 'a' }),
      controller.signal,
      h.observer,
    )
    await vi.waitFor(() => expect(h.log).toContain('wait'))
    controller.abort()
    expect((await pending).status).toBe('cancelled')
    expect(h.log).toEqual([
      'wait',
      expect.stringContaining('approval.requested'),
      'approval.resolved:{"approvalId":"a1","decision":"cancelled","decidedBy":"system"}',
      'resume',
    ])
  })

  it('工具在取消后抛错也按取消处理', async () => {
    const controller = new AbortController()
    const h = setup([
      tool({
        execute: async () => {
          controller.abort()
          throw new Error('aborted by signal')
        },
      }),
    ])
    expect(
      (await createToolPipeline(h.options).run(call({ path: 'a' }), controller.signal, h.observer))
        .status,
    ).toBe('cancelled')
  })

  it('检查点阶段取消不再询问', async () => {
    const controller = new AbortController()
    const h = setup([tool({ category: 'execute' })])
    h.checkpoint.mockImplementation(async () => {
      controller.abort()
      throw new Error('interrupted')
    })
    expect(
      (await createToolPipeline(h.options).run(call({ path: 'a' }), controller.signal, h.observer))
        .status,
    ).toBe('cancelled')
    expect(h.request).not.toHaveBeenCalled()
  })
})

describe('combinePermissionDecisions（M4-03）', () => {
  it('两边都允许才允许', () => {
    expect(combinePermissionDecisions({ decision: 'allow' }, { decision: 'allow' })).toEqual({
      decision: 'allow',
    })
  })

  it('deny 优先于任何结果', () => {
    const parentDeny = {
      decision: 'deny' as const,
      reasonCode: 'parent.deny',
      reason: 'Parent is read-only.',
    }
    const childDeny = { decision: 'deny' as const, reasonCode: 'child.deny' }
    expect(combinePermissionDecisions(parentDeny, { decision: 'allow' })).toBe(parentDeny)
    expect(combinePermissionDecisions({ decision: 'allow' }, childDeny)).toBe(childDeny)
    expect(combinePermissionDecisions(parentDeny, childDeny)).toBe(parentDeny)
  })

  it('只有一方 ask 时保留 ask', () => {
    expect(
      combinePermissionDecisions(
        { decision: 'ask', reasonCode: 'parent.ask' },
        { decision: 'allow' },
      ),
    ).toEqual({ decision: 'ask', reasonCode: 'parent.ask' })
    expect(
      combinePermissionDecisions(
        { decision: 'allow' },
        { decision: 'ask', reasonCode: 'child.ask' },
      ),
    ).toEqual({ decision: 'ask', reasonCode: 'child.ask' })
  })

  it('两边都 ask 时合并规则 id 并去掉重复', () => {
    expect(
      combinePermissionDecisions(
        { decision: 'ask', reasonCode: 'parent.ask', matchedRuleIds: ['p1', 'shared'] },
        { decision: 'ask', reasonCode: 'child.ask', matchedRuleIds: ['shared', 'c1'] },
      ),
    ).toEqual({
      decision: 'ask',
      reasonCode: 'parent.ask',
      matchedRuleIds: ['p1', 'shared', 'c1'],
    })
    expect(
      combinePermissionDecisions(
        { decision: 'ask', reasonCode: 'parent.ask' },
        { decision: 'ask', reasonCode: 'child.ask' },
      ),
    ).toEqual({ decision: 'ask', reasonCode: 'parent.ask', matchedRuleIds: [] })
  })

  it('组合两个权限门时取更严格的一方', async () => {
    const request = {
      toolCallId: 'c1',
      definition: tool(),
      input: { path: 'a.ts' },
      targets: {},
    }
    const gate = combinePermissionGates(
      { decide: async () => ({ decision: 'allow' }) },
      { decide: async () => ({ decision: 'deny', reasonCode: 'child.deny' }) },
    )
    await expect(gate.decide(request)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'child.deny',
    })
  })
})

describe('ToolPipeline：父运行权限上限（M4-03）', () => {
  const parentGate = (decision: PermissionDecision) => ({
    decide: vi.fn<PermissionGate['decide']>(async () => decision),
  })

  it('父运行的 deny 覆盖子 Agent 的 allow', async () => {
    const restriction = parentGate({
      decision: 'deny',
      reasonCode: 'parent.deny',
      reason: 'Parent is read-only.',
    })
    const h = setup([tool()], { restriction })
    expect(
      await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), h.observer),
    ).toMatchObject({
      status: 'denied',
      content: text('Parent is read-only.'),
      error: { code: 'tool.denied' },
    })
    expect(h.request).not.toHaveBeenCalled()
    expect(restriction.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'c1',
        input: { path: 'a.ts' },
        definition: expect.objectContaining({ name: 'write_file' }),
      }),
    )
  })

  it('父运行的 ask 与子 Agent 的 allow 取 ask', async () => {
    const restriction = parentGate({
      decision: 'ask',
      reasonCode: 'parent.ask',
      matchedRuleIds: ['p1'],
    })
    const h = setup([tool()], { restriction })
    expect(
      (await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), h.observer))
        .status,
    ).toBe('ok')
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'parent.ask',
        matchedRuleIds: ['p1'],
      }),
    )
  })

  it('子 Agent 的 ask 不会被父运行的 allow 放宽', async () => {
    const restriction = parentGate({ decision: 'allow' })
    const h = setup(
      [tool()],
      { restriction },
      { decision: 'ask', reasonCode: 'child.ask', matchedRuleIds: ['c1'] },
    )
    h.request.mockResolvedValueOnce({ decision: 'deny' })
    expect(
      (await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), h.observer))
        .status,
    ).toBe('denied')
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'child.ask',
        matchedRuleIds: ['c1'],
      }),
    )
  })

  it('两边都 ask 时把两边的规则 id 一起交给审批', async () => {
    const restriction = parentGate({
      decision: 'ask',
      reasonCode: 'parent.ask',
      matchedRuleIds: ['p1'],
    })
    const h = setup(
      [tool()],
      { restriction },
      { decision: 'ask', reasonCode: 'child.ask', matchedRuleIds: ['c1'] },
    )
    await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), h.observer)
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'parent.ask',
        matchedRuleIds: ['p1', 'c1'],
      }),
    )
  })
})

describe('truncateOutput', () => {
  it('不超过上限时原样返回（非文本部分不计）', () => {
    const content = [
      ...text('abc'),
      { type: 'image' as const, blobRef: 'b', mimeType: 'image/png' },
    ]
    expect(truncateOutput(content, 3)).toEqual({ content, truncated: false })
  })
})

describe('RunEngine 接入流水线', () => {
  const model: ResolvedModel = {
    ref: { providerId: 'fake', modelId: 'fake' },
    providerKind: 'openai',
    baseUrl: 'http://x',
    profile: {
      contextWindow: 1000,
      maxOutputTokens: 100,
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
    },
  }

  async function runWith(
    decision: PermissionDecision,
    over: Partial<ToolPipelineOptions> = {},
    definitions = [tool()],
  ) {
    const h = setup(definitions, over, decision)
    const events: { type: string; payload: unknown; turnId?: string }[] = []
    const engine = await RunEngine.create({
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'default', version: 1 },
      mode: 'interactive',
      limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
      runtime: new FakeRuntime({
        turns: [
          {
            steps: [
              { kind: 'tool', name: 'write_file', input: { path: 'a.ts' } },
              { kind: 'reply', text: 'done' },
            ],
          },
        ],
      }),
      model,
      tools: [{ name: 'write_file', description: 'Write a file.', inputSchema: {} }],
      toolPipeline: createToolPipeline(h.options),
      signal: new AbortController().signal,
      emit: (e: { type: string; payload: unknown; turnId?: string | undefined }) =>
        events.push({
          type: e.type,
          payload: e.payload,
          ...(e.turnId ? { turnId: e.turnId } : {}),
        }),
      now: () => 1,
    })
    await engine.prompt({ messageId: 'm1', content: text('go') })
    return { events, h }
  }

  it('改动记录带上当前轮次；file.changed 在 tool.started 与 tool.completed 之间', async () => {
    const record = vi.fn(async () => ({ changeId: 'ch1' }))
    const writer = tool({
      execute: async ({ path }, ctx) => {
        await ctx.recordChange({
          path,
          kind: 'create',
          after: new Uint8Array(),
          hunks: [],
          added: 0,
          removed: 0,
        })
        return { content: text('ok') }
      },
    })
    const { events } = await runWith({ decision: 'allow' }, { changes: { record } }, [writer])
    const turnId = events.find((e) => e.type === 'turn.started')!.turnId
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ turnId, toolCallId: expect.any(String) }),
    )
    const types = events.map((e) => e.type)
    expect(types.indexOf('file.changed')).toBeGreaterThan(types.indexOf('tool.started'))
    expect(types.indexOf('file.changed')).toBeLessThan(types.indexOf('tool.completed'))
    expect(events.find((e) => e.type === 'file.changed')).toMatchObject({
      payload: { changeId: 'ch1', path: 'a.ts', kind: 'create' },
      turnId,
    })
  })

  const toolEvents = (events: { type: string; payload: unknown }[]) =>
    events
      .filter(
        (e) =>
          e.type.startsWith('tool.') ||
          e.type.startsWith('approval.') ||
          e.type === 'run.state.changed',
      )
      .map((e) =>
        e.type === 'run.state.changed'
          ? `state:${(e.payload as EventPayload<'run.state.changed'>).to}`
          : e.type,
      )

  it('审批时进入 awaiting_approval，事件依次为 requested → 审批 → started → 输出 → completed', async () => {
    const { events } = await runWith({ decision: 'ask', reasonCode: 'rule.ask' })
    expect(toolEvents(events)).toEqual([
      'state:thinking',
      'state:tooling',
      'tool.requested',
      'state:awaiting_approval',
      'approval.requested',
      'approval.resolved',
      'state:tooling',
      'tool.started',
      'tool.output.delta',
      'tool.output.delta',
      'tool.completed',
      'state:thinking',
      'state:completed',
    ])
    expect(events.find((e) => e.type === 'tool.output.delta')?.payload).toEqual({
      toolCallId: expect.any(String),
      stream: 'stdout',
      text: 'writing\n',
    })
  })

  it('被拒绝时没有 tool.started，发出 tool.failed', async () => {
    const { events } = await runWith({ decision: 'deny', reasonCode: 'rule.deny', reason: 'no' })
    expect(toolEvents(events)).toContain('tool.failed')
    expect(toolEvents(events)).not.toContain('tool.started')
    expect(events.find((e) => e.type === 'tool.failed')?.payload).toMatchObject({
      error: { code: 'tool.denied', params: { reason: 'no' } },
    })
  })

  it('输出被截断时 tool.completed 带 truncated', async () => {
    const { events } = await runWith({ decision: 'allow' }, { maxOutputTokens: 1 })
    expect(events.find((e) => e.type === 'tool.completed')?.payload).toMatchObject({
      truncated: true,
    })
  })
})

describe('ToolPipeline：并发上限', () => {
  function gated() {
    const releases: (() => void)[] = []
    const running: string[] = []
    const definition = tool({
      name: 'read_file',
      category: 'read',
      execute: ({ path }) =>
        new Promise((resolve) => {
          running.push(path)
          releases.push(() => resolve({ content: text(path) }))
        }),
    })
    return { definition, releases, running }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('同时执行的调用不超过 maxParallel，完成一个再开始下一个', async () => {
    const g = gated()
    const h = setup([g.definition], { maxParallel: 2 })
    const pipeline = createToolPipeline(h.options)
    const runs = ['a', 'b', 'c'].map((path, i) =>
      pipeline.run({ id: `c${i}`, name: 'read_file', input: { path } }, signal(), h.observer),
    )
    await tick()
    expect(g.running).toEqual(['a', 'b'])
    g.releases[0]!()
    await tick()
    expect(g.running).toEqual(['a', 'b', 'c'])
    g.releases[1]!()
    g.releases[2]!()
    expect((await Promise.all(runs)).map((o) => o.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('等待名额时取消：返回 cancelled，不占用名额', async () => {
    const g = gated()
    const h = setup([g.definition], { maxParallel: 1 })
    const pipeline = createToolPipeline(h.options)
    const first = pipeline.run(
      { id: 'c1', name: 'read_file', input: { path: 'a' } },
      signal(),
      h.observer,
    )
    const controller = new AbortController()
    const second = pipeline.run(
      { id: 'c2', name: 'read_file', input: { path: 'b' } },
      controller.signal,
      h.observer,
    )
    await tick()
    controller.abort()
    expect(await second).toMatchObject({ status: 'cancelled' })
    g.releases[0]!()
    expect(await first).toMatchObject({ status: 'ok' })
    const third = pipeline.run(
      { id: 'c3', name: 'read_file', input: { path: 'c' } },
      signal(),
      h.observer,
    )
    await tick()
    expect(g.running).toEqual(['a', 'c'])
    g.releases[1]!()
    expect(await third).toMatchObject({ status: 'ok' })
  })
})

describe('RunEngine：一步多个工具调用（Runtime §6.2）', () => {
  const model: ResolvedModel = {
    ref: { providerId: 'fake', modelId: 'fake' },
    providerKind: 'openai',
    baseUrl: 'http://x',
    profile: {
      contextWindow: 1000,
      maxOutputTokens: 100,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: false,
    },
  }
  const readFile = tool({
    name: 'read_file',
    category: 'read',
    execute: async ({ path }) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { content: text(path) }
    },
  })

  async function run(
    paths: string[],
    decide: PermissionGate['decide'],
    approvals?: ApprovalGate['request'],
  ) {
    const h = setup([readFile, tool()])
    const registry = h.options.registry
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const engine = await RunEngine.create({
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'default', version: 1 },
      mode: 'interactive',
      limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
      runtime: new FakeRuntime({
        turns: [
          {
            steps: [
              {
                kind: 'tools',
                calls: paths.map((path) => ({ name: 'read_file', input: { path } })),
              },
              { kind: 'reply', text: 'done' },
            ],
          },
        ],
      }),
      model,
      tools: registry.specs(),
      toolPipeline: createToolPipeline({
        ...h.options,
        permissions: { decide },
        ...(approvals ? { approvals: { request: approvals } } : {}),
      }),
      signal: new AbortController().signal,
      emit: (e: { type: string; payload: unknown }) =>
        events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
      now: () => 1,
    })
    await engine.prompt({ messageId: 'm1', content: text('go') })
    return events
  }

  it('只读调用并行执行；部分被拒绝时其余照常完成', async () => {
    const events = await run(['a', 'b', 'c'], async ({ input }) =>
      (input as Input).path === 'b'
        ? { decision: 'deny', reasonCode: 'rule.deny' }
        : { decision: 'allow' },
    )
    const tools = events.filter((e) => e.type.startsWith('tool.'))
    // 三个调用先全部请求，再陆续开始，说明是并行执行
    expect(tools.slice(0, 3).map((e) => e.type)).toEqual([
      'tool.requested',
      'tool.requested',
      'tool.requested',
    ])
    const ends = tools.filter((e) => e.type === 'tool.completed' || e.type === 'tool.failed')
    expect(ends.map((e) => [e.type, e.payload['toolCallId']])).toEqual(
      expect.arrayContaining([
        ['tool.completed', 'fake-call-1'],
        ['tool.failed', 'fake-call-2'],
        ['tool.completed', 'fake-call-3'],
      ]),
    )
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed' })
  })

  it('多个调用同时等待审批：只进入一次 awaiting_approval，全部决定后回到 tooling', async () => {
    const pending: ((decision: 'allow_once' | 'deny') => void)[] = []
    const events = await run(
      ['a', 'b'],
      async () => ({ decision: 'ask', reasonCode: 'rule.ask' }),
      (request) =>
        new Promise((resolve) => {
          pending.push((decision) => resolve({ decision }))
          if (pending.length === 2) {
            pending[0]!('allow_once')
            setTimeout(() => pending[1]!('deny'), 1)
          }
          void request
        }),
    )
    const states = events.filter((e) => e.type === 'run.state.changed').map((e) => e.payload['to'])
    expect(states).toEqual([
      'thinking',
      'tooling',
      'awaiting_approval',
      'tooling',
      'thinking',
      'completed',
    ])
    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(2)
  })
})

describe('ToolPipeline：改动记录（M1-08b）', () => {
  const change = {
    path: 'a.ts',
    kind: 'modify' as const,
    before: new Uint8Array([97]),
    after: new Uint8Array([98]),
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    added: 1,
    removed: 1,
  }
  const writer = (results: unknown[]) =>
    tool({
      execute: async (_input, ctx) => {
        results.push(await ctx.recordChange(change).catch((e: Error) => e.message))
        return { content: text('ok') }
      },
    })

  it('记录改动（带工具调用与轮次），随后发出 file.changed', async () => {
    const results: unknown[] = []
    const record = vi.fn(async () => ({ changeId: 'ch1' }))
    const h = setup([writer(results)], { changes: { record } })
    const observer = { ...h.observer, turnId: 't1' }
    await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), observer)
    expect(record).toHaveBeenCalledWith({ ...change, toolCallId: 'c1', turnId: 't1' })
    expect(results).toEqual([undefined])
    expect(h.log).toContain('file.changed:{"changeId":"ch1","path":"a.ts","kind":"modify"}')
  })

  it('没有配置改动记录时什么也不做；记录失败时交给工具处理，不发出事件', async () => {
    const results: unknown[] = []
    const h = setup([writer(results)])
    await createToolPipeline(h.options).run(call({ path: 'a.ts' }), signal(), h.observer)
    const record = vi.fn(async () => {
      throw new Error('disk full')
    })
    const failing = setup([writer(results)], { changes: { record } })
    await createToolPipeline(failing.options).run(
      call({ path: 'a.ts' }),
      signal(),
      failing.observer,
    )
    expect(record).toHaveBeenCalledWith({ ...change, toolCallId: 'c1' })
    expect(results).toEqual([undefined, 'disk full'])
    expect([...h.log, ...failing.log].some((l) => l.startsWith('file.changed'))).toBe(false)
  })
})
