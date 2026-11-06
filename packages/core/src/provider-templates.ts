/**
 * 提供方配置模板与模型解析（M1-04b；ADR-0011、ADR-0021；架构 §12.2；S2）。
 *
 * - 四个模板：DeepSeek、Anthropic、OpenAI、Gemini，含默认地址、模型列表与兼容参数（首批只支持
 *   Anthropic、OpenAI、Gemini 三种协议格式，DeepSeek 用 OpenAI 格式；Ollama 模板已去掉，2026-11-06）。
 *   模型 id 与能力和 pi 1.5.0 的内置目录一致（`runtime-pi` 中有测试核对）。
 * - DeepSeek 模板带兼容参数（`thinkingFormat: 'deepseek'` 等）：运行时只按 `deepseek.com` 地址或
 *   提供方 id 自动设置这些参数，经代理接入时要靠模板显式给出（S2）。
 * - 覆盖规则：用模板创建提供方时，模板的值复制进 `ProviderConfig`，之后以配置为准（用户可修改地址、
 *   模型与兼容参数）；模型自己的 `compat` 逐项覆盖提供方的 `compat`。
 */
import type {
  HostModelConfig,
  ModelCompat,
  ModelProfile as ModelProfileConfig,
  ModelRef,
  ProviderConfig,
  ProviderKind,
} from '@nexus/protocol'
import type { ResolvedModel } from './runtime.js'

/** 模型的能力部分（不含 id 与显示名）。 */
export type ModelCapabilities = Pick<
  ModelProfileConfig,
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'supportsTools'
  | 'supportsParallelToolCalls'
  | 'supportsReasoning'
>

export interface ProviderTemplate {
  /** 模板 id，也是用模板创建提供方时默认的提供方 id。 */
  readonly id: string
  readonly kind: ProviderKind
  readonly displayName: string
  readonly baseUrl: string
  /** 是否需要 Key；需要时提供方的凭据引用默认为提供方 id。 */
  readonly requiresKey: boolean
  readonly compat?: ModelCompat
  readonly models: readonly ModelProfileConfig[]
  /** 用户手动添加模型时的默认能力。 */
  readonly modelDefaults: ModelCapabilities
}

const model = (
  id: string,
  displayName: string,
  contextWindow: number,
  maxOutputTokens: number,
  supportsReasoning = true,
): ModelProfileConfig => ({
  id,
  displayName,
  contextWindow,
  maxOutputTokens,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning,
})

/** DeepSeek 的兼容参数（与 pi 内置目录一致，S2）。 */
export const DEEPSEEK_COMPAT: ModelCompat = {
  thinkingFormat: 'deepseek',
  requiresReasoningContentOnAssistantMessages: true,
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsStore: false,
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'deepseek',
    kind: 'openai',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    requiresKey: true,
    compat: DEEPSEEK_COMPAT,
    models: [
      model('deepseek-flash', 'DeepSeek V4.1 Flash', 1_000_000, 384_000),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, 384_000),
    ],
    modelDefaults: {
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
    },
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    models: [
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1_000_000, 128_000),
      model('claude-opus-5-5', 'Claude Opus 5.5', 1_000_000, 128_000),
      model('claude-haiku-5-5', 'Claude Haiku 5.5', 1_000_000, 128_000),
    ],
    modelDefaults: {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
    },
  },
  {
    id: 'openai',
    kind: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    models: [
      model('gpt-5.5', 'GPT-5.5', 272_000, 128_000),
      model('gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000),
    ],
    modelDefaults: {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: false,
    },
  },
  {
    id: 'gemini',
    kind: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    models: [
      model('gemini-pro-latest', 'Gemini Pro Latest', 1_048_576, 65_536),
      model('gemini-flash-latest', 'Gemini Flash Latest', 1_048_576, 65_536),
    ],
    modelDefaults: {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
    },
  },
]

export function findTemplate(templateId: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === templateId)
}

export interface ProviderFromTemplateOptions {
  /** 提供方 id，默认用模板 id；同一模板配置多个提供方（如官方与代理）时需要不同的 id。 */
  readonly id?: string
  readonly displayName?: string
  /** 代理或兼容服务的地址。 */
  readonly baseUrl?: string
}

/** 用模板创建提供方配置。模板的值复制进配置，之后以配置为准。 */
export function providerFromTemplate(
  template: ProviderTemplate,
  options: ProviderFromTemplateOptions = {},
): ProviderConfig {
  const id = options.id ?? template.id
  return {
    id,
    kind: template.kind,
    displayName: options.displayName ?? template.displayName,
    baseUrl: options.baseUrl ?? template.baseUrl,
    ...(template.requiresKey ? { credentialRef: id } : {}),
    template: template.id,
    ...(template.compat ? { compat: { ...template.compat } } : {}),
    models: template.models.map((m) => ({ ...m })),
  }
}

/** 合并两级兼容参数：模型的逐项覆盖提供方的；都没有时为 undefined。 */
export function mergeCompat(
  provider: ModelCompat | undefined,
  model: ModelCompat | undefined,
): ModelCompat | undefined {
  const merged = { ...provider, ...model }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** 由提供方配置得到宿主构造模型所需的配置；模型不在配置中时为 undefined。 */
export function hostModelConfig(
  provider: ProviderConfig,
  modelId: string,
): HostModelConfig | undefined {
  const profile = provider.models.find((m) => m.id === modelId)
  if (!profile) return undefined
  const compat = mergeCompat(provider.compat, profile.compat)
  return {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    profile: {
      id: profile.id,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      supportsTools: profile.supportsTools,
      supportsParallelToolCalls: profile.supportsParallelToolCalls,
      supportsReasoning: profile.supportsReasoning,
      ...(profile.pricing ? { pricing: profile.pricing } : {}),
    },
    ...(compat ? { compat } : {}),
  }
}

/** 宿主据模型配置与凭据得到运行时使用的模型。 */
export function resolveModel(
  ref: ModelRef,
  config: HostModelConfig,
  apiKey?: string,
): ResolvedModel {
  const { profile } = config
  return {
    ref,
    providerKind: config.kind,
    baseUrl: config.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    profile: {
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      supportsTools: profile.supportsTools,
      supportsParallelToolCalls: profile.supportsParallelToolCalls,
      supportsReasoning: profile.supportsReasoning,
      ...(profile.pricing ? { pricing: profile.pricing } : {}),
    },
    ...(config.compat ? { compat: config.compat } : {}),
  }
}
