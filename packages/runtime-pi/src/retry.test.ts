/**
 * M1-14a 验收：`RunEngine` + pi 适配器 + mock 端点，构造各类失败，验证重试次数、退避、事件与最终状态。
 */
import { RunEngine, type RetryPolicy } from '@nexus/core'
import type { UnsequencedEvent } from '@nexus/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { PiErrorCode } from './errors.js'
import { PiRuntime } from './session.js'
import { sse, startMockOpenAI, type MockOpenAI, type MockResponse } from './testing/mock-openai.js'

let mock: MockOpenAI | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const policy: RetryPolicy = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4 }
const failure = (status: number): MockResponse => ({
  kind: 'error',
  status,
  body: { error: { message: 'mock failure', type: 'x' } },
})
const ANSWER: MockResponse = {
  kind: 'stream',
  chunks: [sse.text('好的'), sse.finish('stop', { prompt: 5, completion: 2 })],
}

async function run(responses: readonly MockResponse[]) {
  mock = await startMockOpenAI(responses)
  const events: UnsequencedEvent[] = []
  const engine = await RunEngine.create({
    sessionId: 's1',
    runId: 'r1',
    agent: { id: 'builtin.coder', version: 1 },
    mode: 'interactive',
    limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
    runtime: new PiRuntime(),
    model: {
      ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
      providerKind: 'openai',
      baseUrl: mock.baseUrl,
      apiKey: 'test-key-not-real',
      profile: {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: false,
      },
    },
    retry: policy,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  })
  await engine.prompt({ messageId: 'u1', content: [{ type: 'text', text: 'hi' }] })
  const retries = events.flatMap((e) => (e.type === 'model.retry' ? [e.payload] : []))
  return { engine, events, retries, requests: mock.requests.length }
}

describe('模型请求重试（pi + mock 端点）', () => {
  it('429、5xx 后重试成功，本轮完成', async () => {
    const r = await run([failure(429), failure(503), ANSWER])
    expect(r.retries).toEqual([
      {
        attempt: 1,
        maxRetries: 3,
        delayMs: 1,
        error: { code: PiErrorCode.RateLimited, params: { status: 429 } },
      },
      {
        attempt: 2,
        maxRetries: 3,
        delayMs: 2,
        error: { code: PiErrorCode.ServerError, params: { status: 503 } },
      },
    ])
    expect(r.requests).toBe(3)
    expect(r.engine.state).toBe('completed')
    expect(r.events.at(-1)?.type).toBe('turn.completed')
    expect(r.events.filter((e) => e.type === 'message.assistant.completed')).toHaveLength(1)
  })

  it('一直 500：重试 3 次后 turn.failed(retryable)', async () => {
    const r = await run([failure(500), failure(500), failure(500), failure(500)])
    expect(r.retries.map((x) => [x.attempt, x.delayMs])).toEqual([
      [1, 1],
      [2, 2],
      [3, 4],
    ])
    expect(r.requests).toBe(4)
    expect(r.engine.state).toBe('failed')
    expect(r.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      payload: { error: { code: PiErrorCode.ServerError }, retryable: true },
    })
  })

  for (const [status, code] of [
    [401, PiErrorCode.AuthFailed],
    [400, PiErrorCode.BadRequest],
  ] as const) {
    it(`${status} 不重试`, async () => {
      const r = await run([failure(status), ANSWER])
      expect(r.retries).toEqual([])
      expect(r.requests).toBe(1)
      expect(r.events.at(-1)).toMatchObject({
        type: 'turn.failed',
        payload: { error: { code }, retryable: false },
      })
    })
  }
})
