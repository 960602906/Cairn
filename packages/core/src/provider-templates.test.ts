import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@cairn/protocol'
import { hostModelConfig } from './provider-templates.js'

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
})
