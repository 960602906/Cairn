import { FakeRuntime } from '@nexus/core'
import { PiRuntime } from '@nexus/runtime-pi'
import { describe, expect, it } from 'vitest'
import {
  MODEL_ENV,
  RUNTIME_ENV,
  modelFromEnv,
  runtimeKind,
  selectHostRuntime,
} from './runtime-select.js'

const ref = { providerId: 'deepseek', modelId: 'deepseek-flash' }
const piEnv = {
  [RUNTIME_ENV]: 'pi',
  [MODEL_ENV.kind]: 'openai',
  [MODEL_ENV.baseUrl]: 'https://api.deepseek.com',
  [MODEL_ENV.apiKey]: 'k',
  [MODEL_ENV.reasoning]: '1',
}

describe('runtimeKind', () => {
  it('只有 NEXUS_RUNTIME=pi 时用 pi，其他情况用 FakeRuntime', () => {
    expect(runtimeKind({})).toBe('fake')
    expect(runtimeKind({ [RUNTIME_ENV]: 'fake' })).toBe('fake')
    expect(runtimeKind({ [RUNTIME_ENV]: 'PI' })).toBe('fake')
    expect(runtimeKind({ [RUNTIME_ENV]: 'pi' })).toBe('pi')
  })
})

describe('modelFromEnv', () => {
  it('由环境变量构造模型；模型 id 默认取 host.init 中的值', () => {
    expect(modelFromEnv(ref, piEnv)).toEqual({
      ref,
      providerKind: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      profile: {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: true,
      },
    })
  })

  it('可覆盖模型 id；没有 Key 时不带 apiKey；默认不开推理', () => {
    const model = modelFromEnv(ref, {
      [MODEL_ENV.kind]: 'gemini',
      [MODEL_ENV.baseUrl]: 'http://127.0.0.1:3425',
      [MODEL_ENV.id]: 'group/smart-split',
    })
    expect(model.ref).toEqual({ providerId: 'deepseek', modelId: 'group/smart-split' })
    expect(model).not.toHaveProperty('apiKey')
    expect(model.profile.supportsReasoning).toBe(false)
  })

  it('格式或地址缺失时抛出', () => {
    expect(() => modelFromEnv(ref, { [MODEL_ENV.baseUrl]: 'x' })).toThrow(MODEL_ENV.kind)
    expect(() =>
      modelFromEnv(ref, { [MODEL_ENV.kind]: 'responses', [MODEL_ENV.baseUrl]: 'x' }),
    ).toThrow(MODEL_ENV.kind)
    expect(() => modelFromEnv(ref, { [MODEL_ENV.kind]: 'anthropic' })).toThrow(MODEL_ENV.baseUrl)
  })
})

describe('selectHostRuntime', () => {
  it('默认返回 FakeRuntime', () => {
    const host = selectHostRuntime({})(ref)
    expect(host.runtime).toBeInstanceOf(FakeRuntime)
    expect(host.model.ref).toEqual(ref)
  })

  it('优先使用 host.init 带来的凭据', () => {
    expect(selectHostRuntime(piEnv)(ref, { apiKey: 'from-init' }).model.apiKey).toBe('from-init')
    expect(modelFromEnv(ref, piEnv, { apiKey: 'from-init' }).apiKey).toBe('from-init')
    const fake = selectHostRuntime({})(ref, { apiKey: 'from-init' })
    expect(fake.runtime).toBeInstanceOf(FakeRuntime)
  })

  it('NEXUS_RUNTIME=pi 时返回 PiRuntime 与环境变量中的模型', () => {
    const host = selectHostRuntime(piEnv)(ref)
    expect(host.runtime).toBeInstanceOf(PiRuntime)
    expect(host.runtime.id).toBe('pi')
    expect(host.model).toMatchObject({ providerKind: 'openai', apiKey: 'k' })
  })

  it('host.init 带有模型配置时用 PiRuntime 与配置构造的模型，不看环境变量', () => {
    const config = {
      kind: 'openai' as const,
      baseUrl: 'http://127.0.0.1:3425/v1',
      profile: {
        id: 'group/smart-split',
        contextWindow: 1_000,
        maxOutputTokens: 100,
        supportsTools: true,
        supportsParallelToolCalls: false,
        supportsReasoning: true,
      },
      compat: { thinkingFormat: 'deepseek' as const },
    }
    const proxyRef = { providerId: 'gateway', modelId: 'group/smart-split' }
    for (const env of [{}, piEnv]) {
      const host = selectHostRuntime(env)(proxyRef, { apiKey: 'from-init' }, config)
      expect(host.runtime).toBeInstanceOf(PiRuntime)
      expect(host.model).toEqual({
        ref: proxyRef,
        providerKind: 'openai',
        baseUrl: 'http://127.0.0.1:3425/v1',
        apiKey: 'from-init',
        profile: {
          contextWindow: 1_000,
          maxOutputTokens: 100,
          supportsTools: true,
          supportsParallelToolCalls: false,
          supportsReasoning: true,
        },
        compat: { thinkingFormat: 'deepseek' },
      })
    }
    expect(selectHostRuntime({})(proxyRef, undefined, config).model).not.toHaveProperty('apiKey')
  })
})
