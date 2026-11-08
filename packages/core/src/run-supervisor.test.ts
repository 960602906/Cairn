import type { RunLimits } from '@cairn/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeChildLimits,
  FakeRuntime,
  RunEngineErrorCode,
  RunSupervisorErrorCode,
  TOOL_RESULT_NOTICE,
  createRunSupervisor,
  type AgentRuntime,
  type CreateRunInput,
  type FakeScript,
  type ResolvedModel,
  type RunEvent,
  type RunSupervisorOptions,
  type ToolPipeline,
} from './index.js'

const ref = { providerId: 'fake', modelId: 'fake-1' }
const model: ResolvedModel = {
  ref,
  providerKind: 'anthropic',
  baseUrl: 'http://localhost:0',
  profile: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
  },
}
const limits: RunLimits = {
  maxStepsPerTurn: 10,
  maxTurnDurationMs: 60_000,
  maxConsecutiveToolErrors: 3,
}
const text = (t: string) => [{ type: 'text' as const, text: t }]
const input = (id: string, t = id) => ({ messageId: id, content: text(t) })
const init: CreateRunInput = {
  sessionId: 's1',
  agent: { id: 'builtin.coder', version: 1 },
  workspace: { path: '/code/demo' },
  mode: 'interactive',
}

afterEach(() => {
  vi.useRealTimers()
})

function setup(runtime: AgentRuntime, extra: Partial<RunSupervisorOptions> = {}) {
  const controller = new AbortController()
  const supervisor = createRunSupervisor({
    runtime,
    model,
    limits,
    signal: controller.signal,
    now: () => 5,
    ...extra,
  })
  const events: RunEvent[] = []
  supervisor.onEvent((e) => events.push(e))
  return { supervisor, events, controller }
}

const fake = (script: FakeScript) => new FakeRuntime(script, { now: () => 5 })
const types = (events: readonly RunEvent[]) => events.map((e) => e.type)
const turnEnds = (events: readonly RunEvent[]) =>
  events.flatMap((e) =>
    e.type === 'turn.completed' || e.type === 'turn.aborted' || e.type === 'turn.failed'
      ? [e.type]
      : [],
  )

describe('RunSupervisor：创建与事件', () => {
  it('创建运行、转发事件、按 id 查找', async () => {
    const { supervisor, events } = setup(fake({ turns: [] }))
    const run = await supervisor.createRun(init)
    expect(run.runId).toBe('run-1')
    expect(run.workspace).toEqual({ path: '/code/demo' })
    expect(run.state).toBe('idle')
    expect(supervisor.getRun('run-1')).toBe(run)
    expect(supervisor.getRun('nope')).toBeUndefined()
    expect(types(events)).toEqual(['run.created'])

    const own: RunEvent[] = []
    const off = run.onEvent((e) => own.push(e))
    await run.send(input('u1'))
    expect(run.state).toBe('completed')
    expect(turnEnds(events)).toEqual(['turn.completed'])
    expect(own.map((e) => e.type)).toEqual(types(events).slice(1))
    off()
    await run.send(input('u2'))
    expect(turnEnds(own)).toHaveLength(1)
  })

  it('指定 runId、parentRunId 与限额覆盖', async () => {
    const { supervisor, events } = setup(fake({ turns: [] }))
    await supervisor.createRun({
      ...init,
      runId: 'r-main',
      parentRunId: 'p',
      limitsOverride: { maxStepsPerTurn: 3 },
    })
    expect(events[0]).toMatchObject({
      runId: 'r-main',
      parentRunId: 'p',
      payload: { limits: { ...limits, maxStepsPerTurn: 3 } },
    })
  })

  it('支持多个运行：按 id 区分，释放后从管理器中清理', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const a = await supervisor.createRun(init)
    const b = await supervisor.createRun({ ...init, runId: 'r-b' })
    expect(a.runId).toBe('run-1')
    expect(b.runId).toBe('r-b')
    expect(supervisor.getRun(a.runId)).toBe(a)
    expect(supervisor.getRun(b.runId)).toBe(b)
    await a.dispose()
    expect(supervisor.getRun(a.runId)).toBeUndefined()
    expect(supervisor.getRun(b.runId)).toBe(b)
  })

  it('重复 runId 抛出 DuplicateRun', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    await supervisor.createRun({ ...init, runId: 'r1' })
    await expect(supervisor.createRun({ ...init, runId: 'r1' })).rejects.toMatchObject({
      code: RunSupervisorErrorCode.DuplicateRun,
    })
  })

  it('达到 maxRuns 时抛出 TooManyRuns', async () => {
    const { supervisor } = setup(fake({ turns: [] }), { maxRuns: 1 })
    await supervisor.createRun(init)
    await expect(supervisor.createRun(init)).rejects.toMatchObject({
      code: RunSupervisorErrorCode.TooManyRuns,
    })
  })

  it('listRuns 与 listChildren', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const parent = await supervisor.createRun(init)
    const child = await supervisor.createRun({
      ...init,
      runId: 'c1',
      parentRunId: parent.runId,
    })
    expect(supervisor.listRuns().map((r) => r.runId)).toEqual([parent.runId, child.runId])
    expect(supervisor.listChildren(parent.runId).map((r) => r.runId)).toEqual([child.runId])
    expect(supervisor.listChildren('missing')).toEqual([])
  })

  it('默认使用当前时间', async () => {
    const supervisor = createRunSupervisor({
      runtime: fake({ turns: [] }),
      model,
      limits,
      signal: new AbortController().signal,
    })
    const seen: RunEvent[] = []
    supervisor.onEvent((e) => seen.push(e))
    const before = Date.now()
    await supervisor.createRun(init)
    expect(seen[0]!.ts).toBeGreaterThanOrEqual(before)
  })

  it('取消订阅后不再收到事件', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const seen: RunEvent[] = []
    const off = supervisor.onEvent((e) => seen.push(e))
    off()
    await supervisor.createRun(init)
    expect(seen).toEqual([])
  })
})

describe('RunSupervisor：恢复', () => {
  it('带历史恢复：沿用原 runId，不发出 run.created，可以继续对话', async () => {
    let seenHistory: readonly unknown[] = []
    const inner = fake({ turns: [] })
    const spy: AgentRuntime = {
      id: 'spy',
      createSession: (i) => {
        seenHistory = i.history
        return inner.createSession(i)
      },
    }
    const { supervisor, events } = setup(spy)
    const history = [{ role: 'user' as const, content: text('之前'), ts: 1 }]
    const run = await supervisor.createRun({
      ...init,
      runId: 'ignored',
      restoreFrom: { runId: 'r-old', history, state: 'tooling' },
    })
    expect(run.runId).toBe('r-old')
    expect(run.state).toBe('interrupted')
    expect(events).toEqual([])
    expect(seenHistory).toEqual(history)
    await run.send(input('u1', '继续'))
    expect(run.state).toBe('completed')
  })
})

describe('RunSupervisor：运行中继续输入', () => {
  const slow: FakeScript = {
    delayMs: 10,
    turns: [
      { steps: [{ kind: 'reply', text: 'aaaa' }] },
      { steps: [{ kind: 'reply', text: 'bbbb' }] },
      { steps: [{ kind: 'reply', text: 'cccc' }] },
    ],
  }

  it('queue：按顺序依次执行', async () => {
    vi.useFakeTimers()
    const { supervisor, events } = setup(fake(slow))
    const run = await supervisor.createRun(init)
    const order: string[] = []
    const a = run.send(input('u1')).then(() => order.push('u1'))
    const b = run.send(input('u2')).then(() => order.push('u2'))
    const c = run.send(input('u3'), 'queue').then(() => order.push('u3'))
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([a, b, c])
    expect(order).toEqual(['u1', 'u2', 'u3'])
    expect(turnEnds(events)).toEqual(['turn.completed', 'turn.completed', 'turn.completed'])
    const replies = events.flatMap((e) =>
      e.type === 'message.assistant.completed' ? [e.payload.content] : [],
    )
    expect(replies).toEqual([text('aaaa'), text('bbbb'), text('cccc')])
  })

  it('interrupt：中止当前轮次后执行新输入', async () => {
    vi.useFakeTimers()
    const { supervisor, events } = setup(fake(slow))
    const run = await supervisor.createRun(init)
    const first = run.send(input('u1'))
    await vi.advanceTimersByTimeAsync(15)
    const second = run.send(input('u2'), 'interrupt')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([first, second])
    expect(turnEnds(events)).toEqual(['turn.aborted', 'turn.completed'])
  })

  it('steer：运行中交给运行时，不开始新一轮；空闲时按 queue 处理', async () => {
    vi.useFakeTimers()
    const steered: unknown[] = []
    const inner = fake(slow)
    const spy: AgentRuntime = {
      id: 'spy',
      async createSession(i) {
        const session = await inner.createSession(i)
        const steer = session.steer.bind(session)
        session.steer = async (m) => {
          steered.push(m.content)
          return steer(m)
        }
        return session
      },
    }
    const { supervisor, events } = setup(spy)
    const run = await supervisor.createRun(init)
    const first = run.send(input('u1'))
    await vi.advanceTimersByTimeAsync(15)
    await run.send(input('u2', '补充'), 'steer')
    expect(steered).toEqual([text('补充')])
    await vi.advanceTimersByTimeAsync(1000)
    await first
    expect(turnEnds(events)).toEqual(['turn.completed'])

    const idle = run.send(input('u3', '空闲时引导'), 'steer')
    await vi.advanceTimersByTimeAsync(1000)
    await idle
    expect(steered).toHaveLength(1)
    expect(turnEnds(events)).toEqual(['turn.completed', 'turn.completed'])
  })

  it('一次输入失败不影响之后的排队输入', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const run = await supervisor.createRun(init)
    await run.dispose()
    await expect(run.send(input('u1'))).rejects.toMatchObject({ code: RunEngineErrorCode.Disposed })
    await expect(run.send(input('u2'))).rejects.toMatchObject({ code: RunEngineErrorCode.Disposed })
  })
})

describe('RunSupervisor：限额、中止与释放', () => {
  it('updateLimits：超出限额后提高限额继续', async () => {
    const tools: FakeScript = {
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'a', input: {} },
            { kind: 'reply', text: '一' },
          ],
        },
        {
          steps: [
            { kind: 'tool', name: 'a', input: {} },
            { kind: 'reply', text: '二' },
          ],
        },
      ],
    }
    const { supervisor, events } = setup(fake(tools), { limits: { ...limits, maxStepsPerTurn: 1 } })
    const run = await supervisor.createRun(init)
    await run.send(input('u1'))
    expect(run.state).toBe('failed')
    expect(types(events)).toContain('turn.limit_reached')
    run.updateLimits({ maxStepsPerTurn: 5 })
    await run.send(input('u2', '继续'))
    expect(run.state).toBe('completed')
  })

  it('重试策略传给运行', async () => {
    const fail = { kind: 'fail', error: { code: 'model.server_error' }, retryable: true } as const
    const { supervisor, events } = setup(fake({ turns: [{ steps: [fail, fail] }] }), {
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    })
    const run = await supervisor.createRun(init)
    await run.send(input('u1'))
    expect(types(events).filter((t) => t === 'model.retry')).toHaveLength(1)
    expect(turnEnds(events)).toEqual(['turn.failed'])
  })

  it('abortAll 中止所有运行中的轮次', async () => {
    vi.useFakeTimers()
    const { supervisor, events } = setup(
      fake({ delayMs: 10, turns: [{ steps: [{ kind: 'reply', text: 'abcdef' }] }] }),
    )
    const run = await supervisor.createRun(init)
    const done = run.send(input('u1'))
    await vi.advanceTimersByTimeAsync(15)
    await supervisor.abortAll('shutdown')
    await done
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted', payload: { reason: 'shutdown' } })
    // 空闲时 abort 无效果
    await run.abort()
    expect(events.at(-1)).toMatchObject({ type: 'turn.aborted' })
  })

  it('dispose 释放所有运行，发出 run.disposed(shutdown)', async () => {
    const { supervisor, events } = setup(fake({ turns: [] }))
    const run = await supervisor.createRun(init)
    await supervisor.dispose()
    expect(run.state).toBe('disposed')
    expect(events.at(-1)).toMatchObject({ type: 'run.disposed', payload: { reason: 'shutdown' } })
    expect(supervisor.getRun(run.runId)).toBeUndefined()
  })

  it('resolveApproval 在 M0 不支持', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const run = await supervisor.createRun(init)
    expect(() => run.resolveApproval('a1', 'allow_once')).toThrow(
      expect.objectContaining({ code: RunSupervisorErrorCode.Unsupported }),
    )
  })

  it('传入系统提示词、工具与执行器', async () => {
    let seen: { systemPrompt?: string; tools?: readonly unknown[] } = {}
    const inner = fake({
      turns: [
        {
          steps: [
            { kind: 'tool', name: 'echo', input: 1 },
            { kind: 'reply', text: 'ok' },
          ],
        },
      ],
    })
    const spy: AgentRuntime = {
      id: 'spy',
      createSession: (i) => {
        seen = { systemPrompt: i.systemPrompt, tools: i.tools }
        return inner.createSession(i)
      },
    }
    const executeTool = vi.fn(async () => ({ status: 'ok' as const, content: text('done') }))
    const tool = { name: 'echo', description: 'echo', inputSchema: {} }
    const { supervisor, events } = setup(spy, {
      systemPrompt: '你是助手',
      tools: [tool],
      executeTool,
      createId: (() => {
        let n = 0
        return () => `id${++n}`
      })(),
    })
    const run = await supervisor.createRun(init)
    expect(run.runId).toBe('id1')
    await run.send(input('u1'))
    expect(seen).toEqual({ systemPrompt: `你是助手\n\n${TOOL_RESULT_NOTICE}`, tools: [tool] })
    expect(executeTool).toHaveBeenCalledOnce()
    expect(types(events)).toContain('tool.completed')
  })
})

describe('RunSupervisor：父子运行取消树（M4-01）', () => {
  const slow: FakeScript = {
    delayMs: 10,
    turns: [{ steps: [{ kind: 'reply', text: 'working' }] }],
  }

  it('父运行中止级联子运行', async () => {
    vi.useFakeTimers()
    const { supervisor, events } = setup(fake(slow))
    const parent = await supervisor.createRun(init)
    const child = await supervisor.createRun({
      ...init,
      runId: 'c1',
      parentRunId: parent.runId,
    })
    const parentDone = parent.send(input('u1'))
    const childDone = child.send(input('u1'))
    await vi.advanceTimersByTimeAsync(15)
    await parent.abort('user')
    await Promise.all([parentDone, childDone])
    expect(turnEnds(events.filter((e) => e.runId === parent.runId))).toEqual(['turn.aborted'])
    expect(turnEnds(events.filter((e) => e.runId === child.runId))).toEqual(['turn.aborted'])
  })

  it('子运行单独中止不影响父运行', async () => {
    vi.useFakeTimers()
    const { supervisor, events } = setup(fake(slow))
    const parent = await supervisor.createRun(init)
    const child = await supervisor.createRun({
      ...init,
      runId: 'c1',
      parentRunId: parent.runId,
    })
    const parentDone = parent.send(input('u1'))
    const childDone = child.send(input('u1'))
    await vi.advanceTimersByTimeAsync(15)
    await child.abort('user')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([parentDone, childDone])
    expect(turnEnds(events.filter((e) => e.runId === parent.runId))).toEqual(['turn.completed'])
    expect(turnEnds(events.filter((e) => e.runId === child.runId))).toEqual(['turn.aborted'])
  })

  it('dispose 级联释放子运行', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const parent = await supervisor.createRun(init)
    const child = await supervisor.createRun({
      ...init,
      runId: 'c1',
      parentRunId: parent.runId,
    })
    await parent.dispose()
    expect(supervisor.getRun(parent.runId)).toBeUndefined()
    expect(supervisor.getRun(child.runId)).toBeUndefined()
  })
})

describe('RunSupervisor：awaiting_children 与子运行用量（M4-01）', () => {
  const tool = { kind: 'tool', name: 'a', input: {} } as const
  const reply = { kind: 'reply', text: 'done' } as const
  const gatedTool = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      release: () => release(),
      executeTool: async () => {
        await gate
        return { status: 'ok' as const, content: text('ok') }
      },
    }
  }

  it('awaitChildren：包裹期间进入 awaiting_children，结束后恢复 tooling', async () => {
    const gated = gatedTool()
    const { supervisor, events } = setup(fake({ turns: [{ steps: [tool, reply] }] }), {
      executeTool: gated.executeTool,
    })
    const run = await supervisor.createRun(init)
    const done = run.send(input('u1'))
    await vi.waitFor(() => expect(run.state).toBe('tooling'))
    let sawAwaitingChildren = false
    await run.awaitChildren(async () => {
      expect(run.state).toBe('awaiting_children')
      sawAwaitingChildren = true
    })
    expect(sawAwaitingChildren).toBe(true)
    expect(run.state).toBe('tooling')
    gated.release()
    await done
    expect(
      events.some((e) => e.type === 'run.state.changed' && e.payload.to === 'awaiting_children'),
    ).toBe(true)
  })

  it('recordChildUsage：委托给运行引擎计入本轮', async () => {
    const gated = gatedTool()
    const { supervisor, events } = setup(fake({ turns: [{ steps: [tool, reply] }] }), {
      limits: { ...limits, maxTokensPerTurn: 100 },
      executeTool: gated.executeTool,
    })
    const run = await supervisor.createRun(init)
    const done = run.send(input('u1'))
    await vi.waitFor(() => expect(run.state).toBe('tooling'))
    run.recordChildUsage({ inputTokens: 60, outputTokens: 50 })
    gated.release()
    await done
    expect(events.find((e) => e.type === 'turn.limit_reached')).toMatchObject({
      payload: { limit: 'maxTokensPerTurn', value: 100 },
    })
    expect(run.state).toBe('failed')
  })
})

describe('RunSupervisor：按运行创建上下文（M4-01）', () => {
  it('createRunContext 优先于全局配置', async () => {
    const childModel: ResolvedModel = {
      ...model,
      ref: { providerId: 'fake', modelId: 'child' },
    }
    const calls: CreateRunInput[] = []
    const { supervisor } = setup(fake({ turns: [] }), {
      createRunContext: (i) => {
        calls.push(i)
        return { model: childModel, limits: { ...limits, maxStepsPerTurn: 7 } }
      },
    })
    const run = await supervisor.createRun({ ...init, runId: 'r-child', parentRunId: 'p' })
    expect(calls).toEqual([{ ...init, runId: 'r-child', parentRunId: 'p' }])
    expect(run.runId).toBe('r-child')
    expect(run.parentRunId).toBe('p')
    expect(run.remainingLimits).toMatchObject({ maxStepsPerTurn: 7 })
  })

  it('没有运行时或模型时抛出 Unsupported', async () => {
    const controller = new AbortController()
    const supervisor = createRunSupervisor({ signal: controller.signal })
    await expect(supervisor.createRun(init)).rejects.toMatchObject({
      code: RunSupervisorErrorCode.Unsupported,
    })
  })

  it('createRunContext 提供完整上下文时优先使用', async () => {
    const echoTool = { name: 'echo', description: 'echo', inputSchema: {} }
    const pipeline: ToolPipeline = {
      run: async () => ({ status: 'ok', content: text('ok'), truncated: false }),
    }
    const { supervisor } = setup(fake({ turns: [] }), {
      createRunContext: () => ({
        runtime: fake({ turns: [] }),
        model,
        limits,
        systemPrompt: 'child prompt',
        prepareTurn: async () => undefined,
        summarize: async () => undefined,
        sessionBrief: async () => undefined,
        tools: [echoTool],
        executeTool: async () => ({ status: 'ok', content: text('ok') }),
        toolPipeline: pipeline,
        checkpoints: { create: async () => 'cp1' },
        onCheckpointError: () => {},
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    })
    const run = await supervisor.createRun(init)
    expect(run.state).toBe('idle')
    expect(run.remainingLimits).toEqual(limits)
  })

  it('createRunContext 省略的字段回退到全局配置', async () => {
    const pipeline: ToolPipeline = {
      run: async () => ({ status: 'ok', content: text('ok'), truncated: false }),
    }
    const { supervisor } = setup(fake({ turns: [] }), {
      createRunContext: () => ({ runtime: fake({ turns: [] }), model, limits }),
      prepareTurn: async () => undefined,
      summarize: async () => undefined,
      sessionBrief: async () => undefined,
      toolPipeline: pipeline,
      checkpoints: { create: async () => 'cp1' },
      onCheckpointError: () => {},
    })
    const run = await supervisor.createRun(init)
    expect(run.state).toBe('idle')
  })

  it('没有任何限额来源时使用空限额', async () => {
    const controller = new AbortController()
    const supervisor = createRunSupervisor({
      signal: controller.signal,
      createRunContext: () => ({ runtime: fake({ turns: [] }), model }),
      createId: () => 'r-empty',
    })
    const events: RunEvent[] = []
    supervisor.onEvent((e) => events.push(e))
    const run = await supervisor.createRun(init)
    expect(run.runId).toBe('r-empty')
    expect(events[0]).toMatchObject({ type: 'run.created', payload: { limits: {} } })
  })
})

describe('computeChildLimits', () => {
  it('取子 Agent、任务书与父剩余预算 × share 的最小值', () => {
    expect(
      computeChildLimits({
        childAgentLimits: { maxStepsPerTurn: 5, maxTokensPerTurn: 5000 },
        taskLimits: { maxStepsPerTurn: 3, maxTurnDurationMs: 10_000 },
        parentRemainingLimits: {
          maxStepsPerTurn: 10,
          maxTokensPerTurn: 10_000,
          maxTurnDurationMs: 60_000,
        },
        childBudgetShare: 0.5,
      }),
    ).toEqual({
      maxStepsPerTurn: 3,
      maxTokensPerTurn: 5000,
      maxTurnDurationMs: 10_000,
    })
  })

  it('share 默认 1，越界钳到 [0, 1]', () => {
    expect(
      computeChildLimits({ parentRemainingLimits: { maxStepsPerTurn: 4 }, childBudgetShare: 2 }),
    ).toEqual({ maxStepsPerTurn: 4 })
    expect(
      computeChildLimits({ parentRemainingLimits: { maxStepsPerTurn: 4 }, childBudgetShare: -1 }),
    ).toEqual({ maxStepsPerTurn: 1 })
    expect(computeChildLimits({ parentRemainingLimits: { maxStepsPerTurn: 4 } })).toEqual({
      maxStepsPerTurn: 4,
    })
  })

  it('空输入返回空限额', () => {
    expect(computeChildLimits({})).toEqual({})
  })

  it('连续工具失败优先取子 Agent，其次任务书', () => {
    expect(
      computeChildLimits({
        childAgentLimits: { maxConsecutiveToolErrors: 2 },
        taskLimits: { maxConsecutiveToolErrors: 9 },
      }),
    ).toEqual({ maxConsecutiveToolErrors: 2 })
    expect(computeChildLimits({ taskLimits: { maxConsecutiveToolErrors: 9 } })).toEqual({
      maxConsecutiveToolErrors: 9,
    })
  })

  it('费用上限取三者最小值', () => {
    expect(
      computeChildLimits({
        childAgentLimits: { maxCostPerTurn: 2 },
        taskLimits: { maxCostPerTurn: 5 },
        parentRemainingLimits: { maxCostPerTurn: 8 },
        childBudgetShare: 0.5,
      }),
    ).toEqual({ maxCostPerTurn: 2 })
  })

  it('步数与 token 最低不低于 1', () => {
    expect(
      computeChildLimits({ parentRemainingLimits: { maxStepsPerTurn: 0, maxTokensPerTurn: 0 } }),
    ).toEqual({ maxStepsPerTurn: 1, maxTokensPerTurn: 1 })
  })
})
