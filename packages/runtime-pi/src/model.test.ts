import type { ResolvedModel } from '@nexus/core'
import { describe, expect, it } from 'vitest'
import { API_BY_KIND, bindModel, toPiModel } from './model.js'

const resolved = (over: Partial<ResolvedModel> = {}): ResolvedModel => ({
  ref: { providerId: 'p', modelId: 'm' },
  providerKind: 'openai',
  baseUrl: 'http://127.0.0.1:1/v1',
  profile: {
    contextWindow: 32_000,
    maxOutputTokens: 2_000,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
  },
  ...over,
})

describe('toPiModel', () => {
  it('三种接口格式对应 pi 的 api', () => {
    expect(API_BY_KIND).toEqual({
      openai: 'openai-completions',
      anthropic: 'anthropic-messages',
      gemini: 'google-generative-ai',
    })
    for (const kind of ['openai', 'anthropic', 'gemini'] as const) {
      expect(toPiModel(resolved({ providerKind: kind }))).toMatchObject({
        id: 'm',
        api: API_BY_KIND[kind],
        provider: 'p',
        baseUrl: 'http://127.0.0.1:1/v1',
        reasoning: false,
        contextWindow: 32_000,
        maxTokens: 2_000,
      })
    }
  })

  it('DeepSeek（openai 格式）用内置目录的兼容参数，地址与限额用配置的值（经代理也生效）', () => {
    const model = toPiModel(
      resolved({
        ref: { providerId: 'my-proxy', modelId: 'deepseek-flash' },
        baseUrl: 'http://proxy.local/v1',
      }),
    )
    expect(model).toMatchObject({
      id: 'deepseek-flash',
      provider: 'my-proxy',
      baseUrl: 'http://proxy.local/v1',
      reasoning: true,
      maxTokens: 2_000,
      compat: {
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true,
        maxTokensField: 'max_tokens',
      },
    })
  })

  it('anthropic 格式的同名模型不套用 DeepSeek 目录', () => {
    const model = toPiModel(
      resolved({ providerKind: 'anthropic', ref: { providerId: 'd', modelId: 'deepseek-flash' } }),
    )
    expect(model).not.toHaveProperty('compat')
  })
})

describe('bindModel', () => {
  it('返回 pi 模型与用于回传判断的标识；没有 Key 也能创建', () => {
    const binding = bindModel(resolved())
    expect(binding.model).toMatchObject({ id: 'm', provider: 'p', api: 'openai-completions' })
    expect(binding.identity).toEqual({
      ref: { providerId: 'p', modelId: 'm' },
      provider: 'p',
      api: 'openai-completions',
      id: 'm',
    })
    expect(typeof binding.streamFn).toBe('function')
  })
})
