/**
 * S1：同一宿主进程内的多个 pi 运行。
 *
 * 假设：同一个 `PiRuntime` 可以同时持有 3 个独立会话；每个会话有自己的模型、事件流、历史与中止信号，
 * 事件不会串会话；中止一个会话不影响其他会话。
 *
 * 测量：3 个会话并行完成一次的耗时、RSS 增量、CPU 时间；结果以 `M4_S1_RESULT` JSON 行输出，
 * 由 `README.md` 记录。
 */
import type { ResolvedModel, RuntimeEvent, UserMessage } from '@cairn/core'
import { PiRuntime } from '@cairn/runtime-pi'
import { sse, startMockOpenAI, type MockOpenAI } from '@cairn/runtime-pi/testing'
import { afterEach, describe, expect, it } from 'vitest'

const opened: MockOpenAI[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((mock) => mock.close()))
})

function model(baseUrl: string, modelId: string): ResolvedModel {
  return {
    ref: { providerId: 'spike', modelId },
    providerKind: 'openai',
    baseUrl,
    apiKey: 'spike-key-not-real',
    profile: {
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: false,
    },
  }
}

const user = (text: string): UserMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ts: 1,
})

const answer = (text: string) => ({
  kind: 'stream' as const,
  chunks: [sse.text(text), sse.finish('stop')],
})

interface SessionHarness {
  events: RuntimeEvent[]
  prompt(text: string): Promise<void>
  historyLength(): number
  dispose(): Promise<void>
}

async function openSession(
  runtime: PiRuntime,
  resolved: ResolvedModel,
  controller: AbortController,
): Promise<SessionHarness> {
  const session = await runtime.createSession({
    model: resolved,
    systemPrompt: 'You are a spike child agent.',
    tools: [],
    history: [],
    signal: controller.signal,
    hooks: {
      beforeToolCall: async () => ({ action: 'allow' }),
      executeTool: async () => ({ status: 'ok', content: [] }),
    },
  })
  const events: RuntimeEvent[] = []
  session.onEvent((event) => events.push(event))
  return {
    events,
    prompt: (text) => session.prompt(user(text)),
    historyLength: () => session.exportHistory().length,
    dispose: () => session.dispose(),
  }
}

describe('S1 同一宿主多运行', () => {
  it('三个会话并行运行，模型、事件与历史互不干扰', async () => {
    const texts = ['explorer-result', 'reviewer-result', 'tester-result']
    const mock = await startMockOpenAI([answer(texts[0]!), answer(texts[1]!), answer(texts[2]!)])
    opened.push(mock)

    const runtime = new PiRuntime()
    const controllers = texts.map(() => new AbortController())
    const sessions = await Promise.all(
      texts.map((_, index) =>
        openSession(runtime, model(mock.baseUrl, `spike-model-${index}`), controllers[index]!),
      ),
    )

    const before = process.memoryUsage().rss
    const cpuBefore = process.cpuUsage()
    const started = performance.now()
    await Promise.all(sessions.map((session, index) => session.prompt(texts[index]!)))
    const durationMs = Math.round(performance.now() - started)
    const cpu = process.cpuUsage(cpuBefore)
    const rssDeltaBytes = process.memoryUsage().rss - before

    for (const [index, session] of sessions.entries()) {
      const ended = session.events.filter((event) => event.type === 'loop.ended')
      expect(ended).toEqual([{ type: 'loop.ended', outcome: 'completed' }])
      const deltas = session.events.flatMap((event) =>
        event.type === 'text.delta' ? [event.text] : [],
      )
      expect(deltas.join('')).toBe(texts[index])
      expect(session.events.filter((event) => event.type === 'message.completed')).toHaveLength(1)
      expect(session.historyLength()).toBe(2)
    }

    expect(mock.requests).toHaveLength(3)
    expect(new Set(mock.requests.map((request) => request.body.model))).toEqual(
      new Set(['spike-model-0', 'spike-model-1', 'spike-model-2']),
    )

    console.log(
      `M4_S1_RESULT ${JSON.stringify({
        sessions: sessions.length,
        durationMs,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        rssDeltaBytes,
        requests: mock.requests.length,
      })}`,
    )

    await Promise.all(sessions.map((session) => session.dispose()))
  })

  it('中止一个会话不影响其他会话', async () => {
    const fastMock = await startMockOpenAI([answer('fast-done')])
    const hangMock = await startMockOpenAI([{ kind: 'hang', chunks: [sse.text('partial')] }])
    opened.push(fastMock, hangMock)

    const runtime = new PiRuntime()
    const fastController = new AbortController()
    const hangController = new AbortController()
    const fast = await openSession(runtime, model(fastMock.baseUrl, 'fast'), fastController)
    const hang = await openSession(runtime, model(hangMock.baseUrl, 'hang'), hangController)

    const fastRun = fast.prompt('go')
    const hangRun = hang.prompt('go')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await hangController.abort()
    await Promise.all([fastRun, hangRun])

    expect(fast.events.filter((event) => event.type === 'loop.ended')).toEqual([
      { type: 'loop.ended', outcome: 'completed' },
    ])
    expect(hang.events.filter((event) => event.type === 'loop.ended')).toEqual([
      { type: 'loop.ended', outcome: 'aborted' },
    ])
    expect(hang.historyLength()).toBe(1)

    await Promise.all([fast.dispose(), hang.dispose()])
  })
})
