import { describe, expect, it } from 'vitest'
import { ModelCompat, ModelProfile, ProviderConfig } from './providers.js'

const model = {
  id: 'deepseek-chat',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}
const provider = {
  id: 'deepseek',
  kind: 'openai',
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  credentialRef: 'deepseek',
  models: [model],
}

describe('ProviderConfig', () => {
  it('accepts the three formats with http(s) addresses', () => {
    for (const kind of ['openai', 'anthropic', 'gemini']) {
      expect(ProviderConfig.safeParse({ ...provider, kind }).success).toBe(true)
    }
    expect(
      ProviderConfig.safeParse({ ...provider, baseUrl: 'http://127.0.0.1:3425/v1' }).success,
    ).toBe(true)
  })

  it('rejects bad addresses, ids and duplicate models', () => {
    for (const bad of [
      { baseUrl: 'not a url' },
      { baseUrl: 'ftp://example.com' },
      { baseUrl: 'https://user:pass@example.com' },
      { baseUrl: 'https://' },
      { baseUrl: 'https://a b' },
      { id: '' },
      { credentialRef: 'a/b' },
      { displayName: '' },
      { models: [model, model] },
    ]) {
      expect(ProviderConfig.safeParse({ ...provider, ...bad }).success).toBe(false)
    }
  })

  it('requires positive limits', () => {
    expect(ModelProfile.safeParse({ ...model, contextWindow: 0 }).success).toBe(false)
    expect(ModelProfile.safeParse({ ...model, maxOutputTokens: 1.5 }).success).toBe(false)
    expect(ModelProfile.safeParse({ ...model, verifiedAt: 1 }).success).toBe(true)
  })
})

describe('ModelCompat', () => {
  it('accepts known options on providers and models, rejects unknown keys', () => {
    const compat = { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' }
    expect(ProviderConfig.safeParse({ ...provider, compat, template: 'deepseek' }).success).toBe(
      true,
    )
    expect(ProviderConfig.safeParse({ ...provider, models: [{ ...model, compat }] }).success).toBe(
      true,
    )
    expect(ModelCompat.safeParse({ thinkingFormat: 'other' }).success).toBe(false)
    expect(ModelCompat.safeParse({ openRouterRouting: {} }).success).toBe(false)
  })
})
