import { describe, expect, it } from 'vitest'
import { ProviderTemplateSpec, type ProviderConfig } from '@cairn/protocol'
import {
  DEEPSEEK_COMPAT,
  findTemplate,
  findTemplateIn,
  hostModelConfig,
  isTemplateUrl,
  keysUrlFor,
  mergeCompat,
  preferredRegion,
  PROVIDER_TEMPLATES,
  providerFromTemplate,
  regionOf,
  resolveModel,
  suggestedModelIds,
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

describe('provider catalog (ADR-0050)', () => {
  it('every built-in entry satisfies the catalog schema and has a unique id', () => {
    for (const template of PROVIDER_TEMPLATES) {
      expect(ProviderTemplateSpec.safeParse(template).success, template.id).toBe(true)
      expect(template.pluginId).toBeUndefined()
    }
    expect(new Set(PROVIDER_TEMPLATES.map((t) => t.id)).size).toBe(PROVIDER_TEMPLATES.length)
  })

  it('keeps the original four templates, ids and defaults unchanged for saved providers', () => {
    expect(PROVIDER_TEMPLATES.slice(0, 4).map((t) => [t.id, t.kind, t.baseUrl])).toEqual([
      ['deepseek', 'openai', 'https://api.deepseek.com'],
      ['anthropic', 'anthropic', 'https://api.anthropic.com'],
      ['openai', 'openai', 'https://api.openai.com/v1'],
      ['gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta'],
    ])
  })

  it('uses https for remote services and only local services skip the key', () => {
    for (const template of PROVIDER_TEMPLATES) {
      const urls = [template.baseUrl, ...(template.regions ?? []).map((r) => r.baseUrl)]
      if (template.category === 'local') {
        expect(template.requiresKey, template.id).toBe(false)
        for (const url of urls) expect(url).toMatch(/^http:\/\/localhost:\d+\/v1$/)
      } else {
        expect(template.requiresKey, template.id).toBe(true)
        for (const url of urls) expect(url, template.id).toMatch(/^https:\/\//)
        expect(template.keysUrl ?? template.regions?.[0]?.keysUrl, template.id).toMatch(
          /^https:\/\//,
        )
      }
      // 每个服务都有网站，用来找网站图标；内置模板不必自带图片
      expect(template.homepage, template.id).toMatch(/^https:\/\//)
      expect(template.icon).toBeUndefined()
    }
  })

  it('covers the common vendors, relays and local servers', () => {
    expect(PROVIDER_TEMPLATES.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        'qwen',
        'moonshot',
        'zhipu',
        'zai',
        'minimax',
        'openrouter',
        'siliconflow',
        'ollama',
        'lmstudio',
      ]),
    )
    expect(findTemplate('qwen')?.compat?.thinkingFormat).toBe('qwen')
    expect(findTemplate('zhipu')?.compat?.thinkingFormat).toBe('zai')
    expect(findTemplate('zai')?.compat?.thinkingFormat).toBe('zai')
    expect(findTemplate('openrouter')?.compat?.thinkingFormat).toBe('openrouter')
  })

  it('resolves regions, key pages and preferred endpoints', () => {
    const qwen = findTemplate('qwen')!
    const cn = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    expect(regionOf(qwen, `${cn}/`)?.id).toBe('cn')
    expect(regionOf(qwen, 'https://proxy.example.com/v1')).toBeUndefined()
    expect(isTemplateUrl(qwen, cn)).toBe(true)
    expect(isTemplateUrl(qwen, 'https://proxy.example.com/v1')).toBe(false)
    expect(keysUrlFor(qwen, cn)).toBe('https://bailian.console.aliyun.com/?tab=model#/api-key')
    expect(preferredRegion(qwen, 'zh-CN')?.id).toBe('cn')
    expect(preferredRegion(qwen, 'en-US')?.id).toBe('global')
    const deepseek = findTemplate('deepseek')!
    expect(preferredRegion(deepseek, 'zh-CN')).toBeUndefined()
    expect(keysUrlFor(deepseek, 'https://proxy.example.com')).toBe(deepseek.keysUrl)
    // 只有国际站与中国大陆站以外的接入点时，回到默认地址
    const onlyCn: ProviderTemplate = {
      ...qwen,
      regions: qwen.regions!.filter((r) => r.id === 'cn'),
    }
    expect(preferredRegion({ ...onlyCn, baseUrl: cn }, 'en-US')?.id).toBe('cn')
  })

  it('picks suggested models that the service actually lists', () => {
    const kimi = findTemplate('moonshot')!
    expect(suggestedModelIds(kimi, ['moonshot-v1-8k', 'Kimi-K2.5', 'kimi-k3'])).toEqual([
      'kimi-k3',
      'Kimi-K2.5',
    ])
    expect(suggestedModelIds(kimi, ['other'])).toEqual([])
    expect(suggestedModelIds(findTemplate('openrouter')!, ['a'])).toEqual([])
  })

  it('finds templates in a merged catalog', () => {
    const extra: ProviderTemplate = { ...findTemplate('openrouter')!, id: 'acme.gw' }
    const catalog = [...PROVIDER_TEMPLATES, extra]
    expect(findTemplateIn(catalog, 'acme.gw')).toBe(extra)
    expect(findTemplateIn(catalog, undefined)).toBeUndefined()
    expect(findTemplateIn(PROVIDER_TEMPLATES, 'acme.gw')).toBeUndefined()
  })
})
