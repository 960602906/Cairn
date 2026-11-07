import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@cairn/protocol'
import {
  createProviderService,
  errorForStatus,
  parseModels,
  type Probe,
} from './provider-service.js'

const cap = {
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'relay',
  kind: 'openai',
  displayName: 'Relay',
  baseUrl: 'https://relay.example.com/v1/',
  credentialRef: 'relay',
  compat: { thinkingFormat: 'deepseek' },
  models: [{ id: 'm1', ...cap }],
  ...over,
})

const credentials = { resolve: vi.fn(async () => ({ apiKey: 'stored-key' })) }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('provider.test', () => {
  it('probes the model with the saved key, or the key typed in the form', async () => {
    const probe = vi.fn<Probe>(async () => ({ ok: true as const, latencyMs: 312 }))
    const service = createProviderService({ credentials, probe })
    await expect(service.test({ provider: provider(), modelId: 'm1' })).resolves.toEqual({
      ok: true,
      latencyMs: 312,
    })
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { providerId: 'relay', modelId: 'm1' },
        providerKind: 'openai',
        baseUrl: 'https://relay.example.com/v1/',
        apiKey: 'stored-key',
        compat: { thinkingFormat: 'deepseek' },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await service.test({ provider: provider(), modelId: 'm1', secret: ' typed ' })
    expect(probe).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'typed' }),
      expect.anything(),
    )
    const { credentialRef: _, ...noKey } = provider()
    await service.test({ provider: noKey, modelId: 'm1' })
    expect(probe.mock.calls.at(-1)![0]).not.toHaveProperty('apiKey')
  })

  it('reports a model that is not in the configuration', async () => {
    const service = createProviderService({ credentials, probe: vi.fn() })
    await expect(service.test({ provider: provider(), modelId: 'nope' })).resolves.toEqual({
      ok: false,
      error: { code: 'session.unknown_model', params: { modelId: 'nope' } },
    })
  })

  it('loads the real probe on demand', async () => {
    const service = createProviderService({ credentials, timeoutMs: 2000 })
    const result = await service.test({
      provider: provider({ baseUrl: 'http://127.0.0.1:9/v1' }),
      modelId: 'm1',
    })
    expect(result.ok).toBe(false)
  })
})

describe('provider.models', () => {
  it('lists OpenAI-format models with a bearer key', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, {}] }))
    const service = createProviderService({ credentials, fetch })
    await expect(service.models({ provider: provider() })).resolves.toEqual({
      ok: true,
      models: [{ id: 'b' }, { id: 'a' }],
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example.com/v1/models',
      expect.objectContaining({
        headers: { accept: 'application/json', authorization: 'Bearer stored-key' },
      }),
    )
  })

  it('uses the Anthropic and Gemini list endpoints', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('anthropic')
        ? json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] })
        : json({
            models: [
              {
                name: 'models/gemini-x',
                displayName: 'Gemini X',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ['generateContent'],
              },
              { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
    )
    const service = createProviderService({ credentials, fetch })
    await expect(
      service.models({
        provider: provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
        secret: 'k',
      }),
    ).resolves.toEqual({ ok: true, models: [{ id: 'claude-x', displayName: 'Claude X' }] })
    expect(fetch).toHaveBeenLastCalledWith(
      'https://api.anthropic.com/v1/models?limit=1000',
      expect.objectContaining({
        headers: {
          accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'k',
        },
      }),
    )
    await expect(
      service.models({
        provider: provider({ kind: 'gemini', baseUrl: 'https://g.example.com/v1beta' }),
      }),
    ).resolves.toEqual({
      ok: true,
      models: [
        {
          id: 'gemini-x',
          displayName: 'Gemini X',
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
        },
      ],
    })
    expect(fetch).toHaveBeenLastCalledWith(
      'https://g.example.com/v1beta/models?pageSize=1000',
      expect.objectContaining({
        headers: { accept: 'application/json', 'x-goog-api-key': 'stored-key' },
      }),
    )
  })

  it('sends no key headers when there is no key', async () => {
    const fetch = vi.fn(async () => json({ data: [] }))
    const service = createProviderService({
      credentials: { resolve: async () => undefined },
      fetch,
    })
    for (const kind of ['openai', 'anthropic', 'gemini'] as const) {
      await service.models({ provider: provider({ kind }) })
    }
    const headers = fetch.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1].headers,
    )
    expect(headers).toEqual([
      { accept: 'application/json' },
      { accept: 'application/json', 'anthropic-version': '2023-06-01' },
      { accept: 'application/json' },
    ])
  })

  it('reports HTTP, network and format failures', async () => {
    const responses: (() => Promise<Response>)[] = [
      async () => json({ error: 'no' }, 401),
      async () => {
        throw new TypeError('fetch failed')
      },
      async () => new Response('not json', { status: 200 }),
      async () => json({ unexpected: true }),
    ]
    const service = createProviderService({
      credentials,
      fetch: vi.fn(() => responses.shift()!()),
    })
    const codes = []
    for (let i = 0; i < 4; i++) codes.push(await service.models({ provider: provider() }))
    expect(codes).toEqual([
      { ok: false, error: { code: 'model.auth_failed', params: { status: 401 } } },
      { ok: false, error: { code: 'model.network_error' } },
      { ok: false, error: { code: 'provider.invalid_response' } },
      { ok: false, error: { code: 'provider.invalid_response' } },
    ])
  })
})

describe('helpers', () => {
  it('classifies HTTP statuses like the runtime does', () => {
    expect(errorForStatus(403).code).toBe('model.auth_failed')
    expect(errorForStatus(429).code).toBe('model.rate_limited')
    expect(errorForStatus(502).code).toBe('model.server_error')
    expect(errorForStatus(404)).toEqual({ code: 'model.bad_request', params: { status: 404 } })
  })

  it('ignores invalid entries and caps the list', () => {
    expect(parseModels('openai', null)).toBeUndefined()
    expect(
      parseModels('openai', { data: [1, { id: '  ' }, { id: 'x', display_name: 'X' }] }),
    ).toEqual([{ id: 'x', displayName: 'X' }])
    expect(
      parseModels('gemini', {
        models: [{ displayName: 'no name' }, { name: 'models/y', inputTokenLimit: -1 }],
      }),
    ).toEqual([{ id: 'y' }])
    const many = { data: Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}` })) }
    expect(parseModels('openai', many)).toHaveLength(1000)
  })
})
