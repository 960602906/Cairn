import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@cairn/protocol'
import {
  DEEPSEEK_COMPAT,
  findTemplate,
  hostModelConfig,
  mergeCompat,
  PROVIDER_TEMPLATES,
  providerFromTemplate,
  resolveModel,
  type ProviderTemplate,
} from './provider-templates.js'

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p1',
  kind: 'openai',
  displayName: '测试供应商',
  baseUrl: 'https://example.com',
  models: [
    {
      id: 'm1',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
    },
  ],
  ...over,
})

describe('providerFromTemplate', () => {
  it('sets a credential reference only when the template needs a key', () => {
    const base = PROVIDER_TEMPLATES[0]!
    const withKey = providerFromTemplate(base, { id: 'custom' })
    expect(withKey).toMatchObject({ id: 'custom', credentialRef: 'custom', template: base.id })

    const noKey: ProviderTemplate = { ...base, id: 'local', requiresKey: false }
    const withoutKey = providerFromTemplate(noKey)
    expect(withoutKey).toMatchObject({ id: 'local', template: 'local' })
    expect(withoutKey).not.toHaveProperty('credentialRef')
  })

  it('finds templates by id and copies compat only when present', () => {
    expect(findTemplate('deepseek')?.kind).toBe('openai')
    expect(findTemplate('missing')).toBeUndefined()

    const deep = providerFromTemplate(PROVIDER_TEMPLATES[0]!)
    expect(deep.compat).toEqual(DEEPSEEK_COMPAT)
    expect(deep.compat).not.toBe(DEEPSEEK_COMPAT)

    const anthropic = providerFromTemplate(findTemplate('anthropic')!)
    expect(anthropic).not.toHaveProperty('compat')
  })

  it('returns undefined when neither level has compat', () => {
    expect(mergeCompat(undefined, undefined)).toBeUndefined()
    expect(mergeCompat({ maxTokensField: 'max_tokens' }, { supportsStore: false })).toEqual({
      maxTokensField: 'max_tokens',
      supportsStore: false,
    })
  })
})

describe('hostModelConfig', () => {
  it('把模型的思考档位带给宿主；没设置时不出现', () => {
    const withLevel = hostModelConfig(
      provider({
        models: [{ ...provider().models[0]!, thinkingLevel: 'medium' }],
      }),
      'm1',
    )
    expect(withLevel?.profile.thinkingLevel).toBe('medium')

    expect(hostModelConfig(provider(), 'm1')?.profile.thinkingLevel).toBeUndefined()
  })

  it('模型不在配置里时返回 undefined', () => {
    expect(hostModelConfig(provider(), 'missing')).toBeUndefined()
  })

  it('carries pricing and compat when configured', () => {
    const pricing = { inputPerMillion: 1, outputPerMillion: 2 }
    const config = hostModelConfig(
      provider({
        compat: { maxTokensField: 'max_tokens' },
        models: [{ ...provider().models[0]!, pricing }],
      }),
      'm1',
    )
    expect(config?.profile.pricing).toEqual(pricing)
    expect(config?.compat).toEqual({ maxTokensField: 'max_tokens' })
  })

  it('resolves a runtime model with and without the optional key and compat', () => {
    const ref = { providerId: 'p1', modelId: 'm1' }
    const base = hostModelConfig(provider(), 'm1')!
    const plain = resolveModel(ref, base)
    expect(plain).not.toHaveProperty('apiKey')
    expect(plain).not.toHaveProperty('compat')
    expect(plain.profile).not.toHaveProperty('pricing')

    const pricing = { inputPerMillion: 3, outputPerMillion: 4 }
    const full = resolveModel(
      ref,
      {
        ...base,
        compat: { maxTokensField: 'max_tokens' },
        profile: { ...base.profile, pricing },
      },
      'secret',
    )
    expect(full).toMatchObject({
      apiKey: 'secret',
      compat: { maxTokensField: 'max_tokens' },
      profile: { pricing },
    })
  })
})
