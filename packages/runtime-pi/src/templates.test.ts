/**
 * 配置模板与 pi 的对接（M1-04b）：模板的模型与 pi 内置目录一致；模板的兼容参数经代理地址时
 * 确实进入请求（S2）。
 */
import {
  findTemplate,
  hostModelConfig,
  PROVIDER_TEMPLATES,
  providerFromTemplate,
  resolveModel,
  type ProviderTemplate,
  type RuntimeEvent,
} from '@cairn/core'
import type { ProviderConfig } from '@cairn/protocol'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { afterEach, describe, expect, it } from 'vitest'
import { toPiModel } from './model.js'
import { PiRuntime } from './session.js'
import { sse, startMockOpenAI, type MockOpenAI } from './testing/mock-openai.js'

interface CatalogEntry {
  readonly id: string
  readonly baseUrl: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly reasoning: boolean
  readonly compat?: object
}

const CATALOGS: Readonly<Record<string, readonly CatalogEntry[]>> = {
  deepseek: Object.values(DEEPSEEK_MODELS),
  anthropic: Object.values(ANTHROPIC_MODELS),
  openai: Object.values(OPENAI_MODELS),
  gemini: Object.values(GOOGLE_MODELS),
}

const template = (id: string): ProviderTemplate => findTemplate(id)!

describe('配置模板', () => {
  it('预置模型的四个模板在前，id 不重复；只有本机服务不需要 Key', () => {
    expect(PROVIDER_TEMPLATES.slice(0, 4).map((t) => t.id)).toEqual([
      'deepseek',
      'anthropic',
      'openai',
      'gemini',
    ])
    expect(new Set(PROVIDER_TEMPLATES.map((t) => t.id)).size).toBe(PROVIDER_TEMPLATES.length)
    expect(PROVIDER_TEMPLATES.filter((t) => !t.requiresKey).map((t) => t.id)).toEqual([
      'ollama',
      'lmstudio',
    ])
    // 其余模板不预置模型，填 Key 后从服务拉取
    expect(PROVIDER_TEMPLATES.slice(4).every((t) => t.models.length === 0)).toBe(true)
    expect(findTemplate('missing')).toBeUndefined()
  })

  it.each(['deepseek', 'anthropic', 'openai', 'gemini'])(
    '%s 模板的地址与模型和 pi 1.5.0 目录一致',
    (id) => {
      const t = template(id)
      const catalog = CATALOGS[id]!
      for (const m of t.models) {
        const entry = catalog.find((c) => c.id === m.id)
        expect(entry, m.id).toBeDefined()
        expect(t.baseUrl).toBe(entry!.baseUrl)
        expect([m.contextWindow, m.maxOutputTokens, m.supportsReasoning]).toEqual([
          entry!.contextWindow,
          entry!.maxTokens,
          entry!.reasoning,
        ])
      }
    },
  )

  it('DeepSeek 模板的兼容参数与目录一致', () => {
    for (const entry of CATALOGS['deepseek']!) {
      expect(entry.compat).toMatchObject(template('deepseek').compat!)
    }
  })

  it('用模板创建提供方：复制模板的值，需要 Key 时凭据引用为提供方 id', () => {
    const deepseek = providerFromTemplate(template('deepseek'), {
      id: 'gateway',
      displayName: '本地网关',
      baseUrl: 'http://127.0.0.1:3425/v1',
    })
    expect(deepseek).toMatchObject({
      id: 'gateway',
      kind: 'openai',
      displayName: '本地网关',
      baseUrl: 'http://127.0.0.1:3425/v1',
      credentialRef: 'gateway',
      template: 'deepseek',
      compat: { thinkingFormat: 'deepseek' },
    })
    // 修改配置不影响模板
    deepseek.models.pop()
    expect(template('deepseek').models).toHaveLength(2)

    expect(providerFromTemplate(template('anthropic'))).not.toHaveProperty('compat')
  })
})

describe('兼容参数进入 pi 的模型定义', () => {
  const proxy = (): ProviderConfig => {
    const base = providerFromTemplate(template('deepseek'), {
      id: 'gateway',
      baseUrl: 'http://127.0.0.1:3425/v1',
    })
    return {
      ...base,
      models: [...base.models, { id: 'group/smart-split', ...template('deepseek').modelDefaults }],
    }
  }

  it('目录外的模型 id 经代理时用模板的兼容参数', () => {
    const config = hostModelConfig(proxy(), 'group/smart-split')!
    const model = toPiModel(
      resolveModel({ providerId: 'gateway', modelId: 'group/smart-split' }, config),
    )
    expect(model.compat).toEqual(template('deepseek').compat)
  })

  it('模型自己的兼容参数逐项覆盖提供方的，并覆盖目录中的值', () => {
    const provider = proxy()
    const config = hostModelConfig(
      {
        ...provider,
        models: provider.models.map((m) =>
          m.id === 'deepseek-flash'
            ? { ...m, compat: { maxTokensField: 'max_completion_tokens' } }
            : m,
        ),
      },
      'deepseek-flash',
    )!
    expect(config.compat).toEqual({
      ...template('deepseek').compat,
      maxTokensField: 'max_completion_tokens',
    })
    const model = toPiModel(
      resolveModel({ providerId: 'gateway', modelId: 'deepseek-flash' }, config),
    )
    expect(model.compat).toMatchObject({
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_completion_tokens',
      // 目录中有、配置中没有的项保留
      supportsStrictMode: true,
    })
    expect(hostModelConfig(provider, 'missing')).toBeUndefined()
  })

  it('模型的单价传给宿主与运行时', () => {
    const provider = proxy()
    const pricing = { inputPerMillion: 0.5, outputPerMillion: 2 }
    const config = hostModelConfig(
      { ...provider, models: provider.models.map((m) => ({ ...m, pricing })) },
      'deepseek-flash',
    )!
    expect(config.profile.pricing).toEqual(pricing)
    const model = resolveModel({ providerId: 'gateway', modelId: 'deepseek-flash' }, config)
    expect(model.profile.pricing).toEqual(pricing)
    expect(
      resolveModel(
        { providerId: 'gateway', modelId: 'deepseek-flash' },
        hostModelConfig(provider, 'deepseek-flash')!,
      ).profile.pricing,
    ).toBeUndefined()
  })

  it('openai 以外的格式忽略兼容参数', () => {
    const config = hostModelConfig(
      { ...providerFromTemplate(template('anthropic')), compat: { thinkingFormat: 'deepseek' } },
      'claude-sonnet-5-5',
    )!
    const model = toPiModel(
      resolveModel({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }, config),
    )
    expect(model.compat).toBeUndefined()
  })
})

describe('经代理地址的请求（mock 端点）', () => {
  let mock: MockOpenAI | undefined
  afterEach(async () => {
    await mock?.close()
    mock = undefined
  })

  const ANSWER = {
    kind: 'stream' as const,
    chunks: [
      sse.reasoning('想一想。'),
      sse.text('好的'),
      sse.finish('stop', { prompt: 5, completion: 2 }),
    ],
  }

  async function send(provider: ProviderConfig, modelId: string) {
    mock = await startMockOpenAI([ANSWER, ANSWER])
    const config = hostModelConfig({ ...provider, baseUrl: mock.baseUrl }, modelId)!
    const session = await new PiRuntime().createSession({
      model: resolveModel({ providerId: provider.id, modelId }, config, 'test-key-not-real'),
      systemPrompt: '你是助手。',
      tools: [],
      history: [],
      signal: new AbortController().signal,
      hooks: {
        beforeToolCall: async () => ({ action: 'allow' }),
        executeTool: async () => ({ status: 'ok', content: [] }),
      },
    })
    const events: RuntimeEvent[] = []
    session.onEvent((e) => events.push(e))
    await session.prompt({ role: 'user', content: [{ type: 'text', text: '你好' }], ts: 1 })
    await session.prompt({ role: 'user', content: [{ type: 'text', text: '再说一次' }], ts: 2 })
    return { requests: mock.requests, events }
  }

  const withModel = (provider: ProviderConfig): ProviderConfig => ({
    ...provider,
    models: [{ id: 'group/smart-split', ...template('deepseek').modelDefaults }],
  })

  it('DeepSeek 模板：请求带 thinking 与 max_tokens，回传历史带推理内容', async () => {
    const provider = withModel(providerFromTemplate(template('deepseek'), { id: 'gateway' }))
    const { requests, events } = await send(provider, 'group/smart-split')
    expect(events.at(-1)).toEqual({ type: 'loop.ended', outcome: 'completed' })
    const first = requests[0]!.body
    expect(first['model']).toBe('group/smart-split')
    expect(first['thinking']).toEqual({ type: 'enabled' })
    expect(first).toHaveProperty('max_tokens')
    expect(first).not.toHaveProperty('max_completion_tokens')
    const history = requests[1]!.body['messages'] as { role: string; reasoning_content?: string }[]
    expect(history.find((m) => m.role === 'assistant')?.reasoning_content).toBe('想一想。')
  })

  it('Qwen 模板：经代理地址请求带 enable_thinking 与 max_tokens', async () => {
    const provider = {
      ...providerFromTemplate(template('qwen'), { id: 'gateway' }),
      models: [{ id: 'qwen-plus', ...template('qwen').modelDefaults }],
    }
    const { requests } = await send(provider, 'qwen-plus')
    const first = requests[0]!.body
    expect(first['enable_thinking']).toBe(true)
    expect(first).not.toHaveProperty('reasoning_effort')
    expect(first).toHaveProperty('max_tokens')
    expect(first).not.toHaveProperty('store')
  })

  it('智谱 GLM 模板：经代理地址请求带 thinking 参数', async () => {
    const provider = {
      ...providerFromTemplate(template('zhipu'), { id: 'gateway' }),
      models: [{ id: 'glm-5', ...template('zhipu').modelDefaults }],
    }
    const { requests } = await send(provider, 'glm-5')
    const first = requests[0]!.body
    expect(first['thinking']).toMatchObject({ type: 'enabled' })
    expect(first).not.toHaveProperty('reasoning_effort')
    expect(first).toHaveProperty('max_tokens')
  })

  it('不用模板（普通 openai 配置）时代理地址上没有这些参数', async () => {
    const provider = withModel({
      id: 'gateway',
      kind: 'openai',
      displayName: 'Gateway',
      baseUrl: 'http://placeholder.local/v1',
      models: [],
    })
    const { requests } = await send(provider, 'group/smart-split')
    const first = requests[0]!.body
    expect(first).not.toHaveProperty('thinking')
    expect(first).toHaveProperty('max_completion_tokens')
  })
})
