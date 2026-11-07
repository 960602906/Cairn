import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedModel } from '@cairn/core'
import { complete } from './complete.js'
import { sse, startMockOpenAI, type MockOpenAI } from './testing/mock-openai.js'

let mock: MockOpenAI | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const resolved = (baseUrl: string, supportsReasoning = false): ResolvedModel => ({
  ref: { providerId: 'relay', modelId: 'group/smart' },
  providerKind: 'openai',
  baseUrl,
  apiKey: 'sk-test',
  profile: {
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning,
  },
})

const fast = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 25 }

describe('complete', () => {
  it('returns text and usage, drops reasoning, and sends no tools', async () => {
    mock = await startMockOpenAI([
      {
        kind: 'stream',
        chunks: [
          sse.reasoning('先想一下'),
          sse.text('整理日志'),
          sse.finish('stop', { prompt: 11, completion: 4 }),
        ],
      },
    ])
    const result = await complete({
      model: resolved(mock.baseUrl, true),
      systemPrompt: 'You name a conversation.',
      messages: [
        { role: 'user', content: '帮我整理日志' },
        { role: 'assistant', content: '好的' },
      ],
      maxOutputTokens: 32,
    })
    expect(result).toEqual({
      ok: true,
      text: '整理日志',
      usage: { inputTokens: 11, outputTokens: 4, reasoningTokens: 0 },
    })
    expect(JSON.stringify(result)).not.toContain('先想一下')
    const body = mock.requests[0]!.body
    expect(body['tools']).toBeUndefined()
    expect(body['max_completion_tokens']).toBe(32)
    expect(JSON.stringify(body['messages'])).toContain('You name a conversation.')
    expect(JSON.stringify(body['messages'])).toContain('帮我整理日志')
    expect(JSON.stringify(body['messages'])).toContain('好的')
    expect(mock.requests[0]!.headers.authorization).toBe('Bearer sk-test')
  })

  it('retries a 429 and then returns the text', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 429, body: { error: { message: 'slow down' } } },
      { kind: 'stream', chunks: [sse.text('标题'), sse.finish('stop')] },
    ])
    const delays: number[] = []
    const result = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      retry: fast,
      sleep: async (ms) => {
        delays.push(ms)
        return true
      },
    })
    expect(result).toMatchObject({ ok: true, text: '标题' })
    expect(delays).toEqual([10])
    expect(mock.requests).toHaveLength(2)
  })

  it('does not retry auth failures or context overflow', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 401, body: { error: { message: 'invalid key sk-test' } } },
    ])
    const auth = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      retry: fast,
      sleep: async () => {
        throw new Error('should not retry')
      },
    })
    expect(auth).toMatchObject({
      ok: false,
      retryable: false,
      error: { code: 'model.auth_failed', params: { status: 401 } },
    })
    expect(JSON.stringify(auth)).not.toContain('sk-test')

    await mock.close()
    mock = await startMockOpenAI([
      {
        kind: 'error',
        status: 400,
        body: { error: { message: "This model's maximum context length is 8192 tokens" } },
      },
    ])
    const overflow = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      retry: fast,
      sleep: async () => {
        throw new Error('should not retry')
      },
    })
    expect(overflow).toMatchObject({
      ok: false,
      retryable: false,
      error: { code: 'model.context_overflow' },
    })
    expect(mock.requests).toHaveLength(1)
  })

  it('stops after the retry limit', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 503, body: { error: { message: 'down' } } },
      { kind: 'error', status: 503, body: { error: { message: 'down' } } },
      { kind: 'error', status: 503, body: { error: { message: 'down' } } },
    ])
    const result = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      retry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 5 },
      sleep: async () => true,
    })
    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      error: { code: 'model.server_error', params: { status: 503 } },
    })
    expect(mock.requests).toHaveLength(3)
  })

  it('does not retry after the wait is aborted', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 429, body: { error: { message: 'slow' } } },
      { kind: 'stream', chunks: [sse.text('late'), sse.finish('stop')] },
    ])
    const controller = new AbortController()
    const result = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      signal: controller.signal,
      retry: fast,
      sleep: async () => {
        controller.abort()
        return false
      },
    })
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      error: { code: 'model.rate_limited' },
    })
    expect(mock.requests).toHaveLength(1)
  })

  it('does not retry when the request itself is aborted', async () => {
    mock = await startMockOpenAI([{ kind: 'hang', chunks: [sse.text('x')] }])
    const controller = new AbortController()
    const pending = complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      signal: controller.signal,
      sleep: async () => {
        throw new Error('should not retry')
      },
    })
    setTimeout(() => controller.abort(), 30)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(false)
    expect(mock.requests).toHaveLength(1)
  })

  it('waits with the built-in timer and can be aborted during the wait', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 429, body: { error: { message: 'slow' } } },
      { kind: 'stream', chunks: [sse.text('late'), sse.finish('stop')] },
    ])
    const controller = new AbortController()
    const pending = complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      signal: controller.signal,
      retry: { maxRetries: 1, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    })
    setTimeout(() => controller.abort(), 20)
    const aborted = await pending
    expect(aborted).toMatchObject({
      ok: false,
      retryable: false,
      error: { code: 'model.rate_limited' },
    })
    expect(mock.requests).toHaveLength(1)

    await mock.close()
    mock = await startMockOpenAI([
      { kind: 'error', status: 429, body: { error: { message: 'slow' } } },
      { kind: 'stream', chunks: [sse.text('ok'), sse.finish('stop')] },
    ])
    const retried = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    })
    expect(retried).toMatchObject({ ok: true, text: 'ok' })
    expect(mock.requests).toHaveLength(2)
  })

  it('does not send a request when the signal is already aborted', async () => {
    mock = await startMockOpenAI([])
    const controller = new AbortController()
    controller.abort()
    const result = await complete({
      model: resolved(mock.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      signal: controller.signal,
    })
    expect(result).toEqual({ ok: false, retryable: false, error: { code: 'model.network_error' } })
    expect(mock.requests).toHaveLength(0)
  })
})
