/**
 * 提供方配置模板与模型解析（M1-04b；ADR-0011、ADR-0021、ADR-0049；架构 §12.2；S2）。
 *
 * - 内置目录（`PROVIDER_TEMPLATES`）：常见的模型厂商、聚合平台与本机服务，含默认地址、接口格式、
 *   兼容参数与申请 Key 的页面。添加时用户只需填 Key，不必知道服务用哪种接口格式。
 *   DeepSeek、Anthropic、OpenAI、Gemini 预置模型，id 与能力和 pi 1.5.0 的内置目录一致（`runtime-pi`
 *   中有测试核对）；其余没有预置模型，填 Key 后拉取模型列表，并启用 `suggestedModels` 中存在的那些。
 * - 兼容参数：运行时只按地址自动判断部分服务（如 `deepseek.com`），经代理接入时要靠模板显式给出（S2），
 *   所以模板总是写全它需要的兼容参数。
 * - 供应商插件（ADR-0049）给出的目录项与内置模板同一结构，见 `provider-plugins.ts`。
 * - 覆盖规则：用模板创建提供方时，模板的值复制进 `ProviderConfig`，之后以配置为准（用户可修改地址、
 *   模型与兼容参数）；模型自己的 `compat` 逐项覆盖提供方的 `compat`。
 */
import type {
  HostModelConfig,
  ModelCapabilities,
  ModelCompat,
  ModelProfile as ModelProfileConfig,
  ModelRef,
  ProviderConfig,
  ProviderRegion,
  ProviderRegionId,
  ProviderTemplateSpec,
} from '@cairn/protocol'
import type { ResolvedModel } from './runtime.js'

export type { ModelCapabilities } from '@cairn/protocol'

/**
 * 目录中的一项。`id` 也是用模板创建提供方时默认的提供方 id；需要 Key 时凭据引用默认为提供方 id。
 * 字段说明见 `ProviderTemplateSpec`。
 */
export type ProviderTemplate = Readonly<ProviderTemplateSpec>

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

const capabilities = (
  contextWindow: number,
  maxOutputTokens: number,
  supportsReasoning: boolean,
  supportsParallelToolCalls = true,
): ModelCapabilities => ({
  contextWindow,
  maxOutputTokens,
  supportsTools: true,
  supportsParallelToolCalls,
  supportsReasoning,
})

/** 手动添加或拉取到的模型没有给出能力、模板也没有默认值时使用。 */
export const GENERIC_MODEL_DEFAULTS: ModelCapabilities = capabilities(128_000, 16_384, false)

/** DeepSeek 的兼容参数（与 pi 内置目录一致，S2）。 */
export const DEEPSEEK_COMPAT: ModelCompat = {
  thinkingFormat: 'deepseek',
  requiresReasoningContentOnAssistantMessages: true,
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsStore: false,
}

/** 多数国内厂商与本机服务的 OpenAI 兼容接口：没有 developer 角色与 store，用 max_tokens。 */
const CHAT_COMPAT: ModelCompat = {
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsStore: false,
}

/** 智谱 GLM（bigmodel.cn 与 z.ai）：`thinking` 参数，不接受 reasoning_effort。 */
export const ZAI_COMPAT: ModelCompat = {
  ...CHAT_COMPAT,
  thinkingFormat: 'zai',
  supportsReasoningEffort: false,
}

/** 通义千问（DashScope 兼容模式）：`enable_thinking` 参数。 */
export const QWEN_COMPAT: ModelCompat = {
  ...CHAT_COMPAT,
  thinkingFormat: 'qwen',
  supportsReasoningEffort: false,
}

const MOONSHOT_COMPAT: ModelCompat = { ...CHAT_COMPAT, supportsReasoningEffort: false }

const XAI_COMPAT: ModelCompat = {
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: false,
}

export const OPENROUTER_COMPAT: ModelCompat = { thinkingFormat: 'openrouter' }

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'deepseek',
    kind: 'openai',
    category: 'vendor',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    requiresKey: true,
    keysUrl: 'https://platform.deepseek.com/api_keys',
    compat: DEEPSEEK_COMPAT,
    models: [
      model('deepseek-flash', 'DeepSeek V4.1 Flash', 1_000_000, 384_000),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, 384_000),
    ],
    modelDefaults: capabilities(1_000_000, 384_000, true),
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    category: 'vendor',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    keysUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1_000_000, 128_000),
      model('claude-opus-5-5', 'Claude Opus 5.5', 1_000_000, 128_000),
      model('claude-haiku-5-5', 'Claude Haiku 5.5', 1_000_000, 128_000),
    ],
    modelDefaults: capabilities(200_000, 64_000, true),
  },
  {
    id: 'openai',
    kind: 'openai',
    category: 'vendor',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    keysUrl: 'https://platform.openai.com/api-keys',
    models: [
      model('gpt-5.5', 'GPT-5.5', 272_000, 128_000),
      model('gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000),
    ],
    modelDefaults: capabilities(128_000, 16_384, false),
  },
  {
    id: 'gemini',
    kind: 'gemini',
    category: 'vendor',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    keysUrl: 'https://aistudio.google.com/apikey',
    models: [
      model('gemini-pro-latest', 'Gemini Pro Latest', 1_048_576, 65_536),
      model('gemini-flash-latest', 'Gemini Flash Latest', 1_048_576, 65_536),
    ],
    modelDefaults: capabilities(1_048_576, 65_536, true),
  },
  {
    id: 'qwen',
    kind: 'openai',
    category: 'vendor',
    displayName: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    regions: [
      {
        id: 'global',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        keysUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
      },
      {
        id: 'cn',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        keysUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
      },
    ],
    requiresKey: true,
    compat: QWEN_COMPAT,
    models: [],
    suggestedModels: ['qwen3-coder-plus', 'qwen-max', 'qwen-plus'],
    modelDefaults: capabilities(131_072, 16_384, true),
  },
  {
    id: 'moonshot',
    kind: 'openai',
    category: 'vendor',
    displayName: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    regions: [
      {
        id: 'global',
        baseUrl: 'https://api.moonshot.ai/v1',
        keysUrl: 'https://platform.moonshot.ai/console/api-keys',
      },
      {
        id: 'cn',
        baseUrl: 'https://api.moonshot.cn/v1',
        keysUrl: 'https://platform.moonshot.cn/console/api-keys',
      },
    ],
    requiresKey: true,
    compat: MOONSHOT_COMPAT,
    models: [],
    suggestedModels: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
    modelDefaults: capabilities(262_144, 32_768, true),
  },
  {
    id: 'zhipu',
    kind: 'openai',
    category: 'vendor',
    displayName: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresKey: true,
    keysUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    compat: ZAI_COMPAT,
    models: [],
    suggestedModels: ['glm-5.3', 'glm-5', 'glm-4.6'],
    modelDefaults: capabilities(200_000, 32_768, true),
  },
  {
    id: 'zai',
    kind: 'openai',
    category: 'vendor',
    displayName: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    requiresKey: true,
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    compat: ZAI_COMPAT,
    models: [],
    suggestedModels: ['glm-5.3', 'glm-5', 'glm-4.6'],
    modelDefaults: capabilities(200_000, 32_768, true),
  },
  {
    id: 'minimax',
    kind: 'openai',
    category: 'vendor',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    regions: [
      {
        id: 'global',
        baseUrl: 'https://api.minimax.io/v1',
        keysUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
      },
      {
        id: 'cn',
        baseUrl: 'https://api.minimaxi.com/v1',
        keysUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      },
    ],
    requiresKey: true,
    compat: CHAT_COMPAT,
    models: [],
    suggestedModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2'],
    modelDefaults: capabilities(204_800, 32_768, true),
  },
  {
    id: 'volcengine',
    kind: 'openai',
    category: 'vendor',
    displayName: 'Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresKey: true,
    keysUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    compat: CHAT_COMPAT,
    models: [],
    modelDefaults: capabilities(256_000, 32_768, true),
  },
  {
    id: 'xai',
    kind: 'openai',
    category: 'vendor',
    displayName: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    requiresKey: true,
    keysUrl: 'https://console.x.ai',
    compat: XAI_COMPAT,
    models: [],
    suggestedModels: ['grok-4.7', 'grok-4'],
    modelDefaults: capabilities(256_000, 32_768, true),
  },
  {
    id: 'openrouter',
    kind: 'openai',
    category: 'relay',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    keysUrl: 'https://openrouter.ai/keys',
    compat: OPENROUTER_COMPAT,
    models: [],
    modelDefaults: GENERIC_MODEL_DEFAULTS,
  },
  {
    id: 'siliconflow',
    kind: 'openai',
    category: 'relay',
    displayName: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    regions: [
      {
        id: 'global',
        baseUrl: 'https://api.siliconflow.com/v1',
        keysUrl: 'https://cloud.siliconflow.com/account/ak',
      },
      {
        id: 'cn',
        baseUrl: 'https://api.siliconflow.cn/v1',
        keysUrl: 'https://cloud.siliconflow.cn/account/ak',
      },
    ],
    requiresKey: true,
    compat: CHAT_COMPAT,
    models: [],
    modelDefaults: GENERIC_MODEL_DEFAULTS,
  },
  {
    id: 'vercel',
    kind: 'openai',
    category: 'relay',
    displayName: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    requiresKey: true,
    keysUrl: 'https://vercel.com/docs/ai-gateway',
    models: [],
    modelDefaults: GENERIC_MODEL_DEFAULTS,
  },
  {
    id: 'ollama',
    kind: 'openai',
    category: 'local',
    displayName: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    compat: CHAT_COMPAT,
    models: [],
    // 本地模型上下文通常较小，工具调用能力取决于具体模型（架构 §12.2）
    modelDefaults: capabilities(32_768, 4_096, false, false),
  },
  {
    id: 'lmstudio',
    kind: 'openai',
    category: 'local',
    displayName: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
    compat: CHAT_COMPAT,
    models: [],
    modelDefaults: capabilities(32_768, 4_096, false, false),
  },
]

export function findTemplate(templateId: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === templateId)
}

/** 在给定目录（内置加插件）中查找模板。 */
export function findTemplateIn(
  catalog: readonly ProviderTemplate[],
  templateId: string | undefined,
): ProviderTemplate | undefined {
  return templateId === undefined ? undefined : catalog.find((t) => t.id === templateId)
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** 地址对应的接入点；不是模板的任何接入点时为 undefined。 */
export function regionOf(template: ProviderTemplate, baseUrl: string): ProviderRegion | undefined {
  return template.regions?.find((region) => sameUrl(region.baseUrl, baseUrl))
}

/** 地址是不是模板的默认地址或某个接入点。 */
export function isTemplateUrl(template: ProviderTemplate, baseUrl: string): boolean {
  return sameUrl(template.baseUrl, baseUrl) || regionOf(template, baseUrl) !== undefined
}

/** 按界面语言选默认接入点：中文界面优先中国大陆站，其余用模板的默认地址。 */
export function preferredRegion(
  template: ProviderTemplate,
  locale: string,
): ProviderRegion | undefined {
  if (!template.regions) return undefined
  const wanted: ProviderRegionId = locale.toLowerCase().startsWith('zh') ? 'cn' : 'global'
  return (
    template.regions.find((region) => region.id === wanted) ??
    template.regions.find((region) => sameUrl(region.baseUrl, template.baseUrl))
  )
}

/** 地址对应的申请 Key 页面：接入点自己的优先。 */
export function keysUrlFor(template: ProviderTemplate, baseUrl: string): string | undefined {
  return regionOf(template, baseUrl)?.keysUrl ?? template.keysUrl
}

/**
 * 从拉取到的模型 id 中挑出模板建议启用的那些（按建议顺序，大小写不敏感），返回拉取结果中的原始 id。
 */
export function suggestedModelIds(
  template: ProviderTemplate,
  available: readonly string[],
): readonly string[] {
  const byLower = new Map(available.map((id) => [id.toLowerCase(), id] as const))
  const picked: string[] = []
  for (const wanted of template.suggestedModels ?? []) {
    const found = byLower.get(wanted.toLowerCase())
    if (found !== undefined && !picked.includes(found)) picked.push(found)
  }
  return picked
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
      ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
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
