import type { RunLimits } from '@nexus/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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

  it('M0 只允许一个运行；释放后可以再创建', async () => {
    const { supervisor } = setup(fake({ turns: [] }))
    const run = await supervisor.createRun(init)
    await expect(supervisor.createRun(init)).rejects.toMatchObject({
      code: RunSupervisorErrorCode.TooManyRuns,
    })
    await run.dispose()
    expect(supervisor.getRun(run.runId)).toBeUndefined()
    const next = await supervisor.createRun(init)
    expect(next.runId).toBe('run-2')
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
