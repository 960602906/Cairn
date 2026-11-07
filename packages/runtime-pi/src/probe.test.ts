import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedModel } from '@cairn/core'
import { probeModel, PROBE_MAX_TOKENS } from './probe.js'
import { sse, startMockOpenAI, type MockOpenAI } from './testing/mock-openai.js'

let mock: MockOpenAI | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const resolved = (baseUrl: string): ResolvedModel => ({
  ref: { providerId: 'relay', modelId: 'group/smart' },
  providerKind: 'openai',
  baseUrl,
  apiKey: 'sk-test',
  profile: {
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: false,
  },
})

describe('probeModel', () => {
  it('sends one small request and reports the latency', async () => {
    mock = await startMockOpenAI([
      { kind: 'stream', chunks: [sse.text('pong'), sse.finish('stop')] },
    ])
    let clock = 1000
    const result = await probeModel(resolved(mock.baseUrl), { now: () => (clock += 120) - 120 })
    expect(result).toEqual({ ok: true, latencyMs: 120 })
    expect(mock.requests).toHaveLength(1)
    const [request] = mock.requests
    expect(request!.path).toBe('/v1/chat/completions')
    expect(request!.headers.authorization).toBe('Bearer sk-test')
    expect(request!.body).toMatchObject({
      model: 'group/smart',
      max_completion_tokens: PROBE_MAX_TOKENS,
    })
    expect(request!.body['tools']).toBeUndefined()
  })

  it('classifies a failed request without returning the provider text', async () => {
    mock = await startMockOpenAI([
      { kind: 'error', status: 401, body: { error: { message: 'invalid key sk-test' } } },
    ])
    const result = await probeModel(resolved(mock.baseUrl))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'model.auth_failed', params: { status: 401 } },
    })
    expect(JSON.stringify(result)).not.toContain('sk-test')
  })

  it('reports an aborted request as a failure', async () => {
    mock = await startMockOpenAI([{ kind: 'hang', chunks: [sse.text('p')] }])
    const controller = new AbortController()
    const pending = probeModel(resolved(mock.baseUrl), { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    expect(result.ok).toBe(false)
  })
})
