/**
 * 模型提供方配置（ADR-0011、ADR-0021，架构 §12.1，M1-04a）。
 *
 * 由主进程保存在数据库的 `provider_configs` 表中，经 `settings.get` / `settings.update` 读写。
 * 配置中只有凭据引用（`credentialRef`），没有 Key 本身（ADR-0010）。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'

/** 提供方 id 与凭据引用共用的格式：字母、数字、`.`、`_`、`-`，1～128 个字符。 */
export const CONFIG_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 接口格式（ADR-0021）：只描述线路协议，不绑定厂商。 */
export const ProviderKind = z.enum(['openai', 'anthropic', 'gemini'])
export type ProviderKind = z.infer<typeof ProviderKind>

const PositiveInt = z.number().int().positive()

/** 推理内容的请求格式（openai 格式的兼容服务各不相同）。 */
export const ThinkingFormat = z.enum(['openai', 'deepseek', 'qwen', 'openrouter', 'zai'])
export type ThinkingFormat = z.infer<typeof ThinkingFormat>

/**
 * 兼容参数（M1-04b，S2）：OpenAI 兼容服务之间的差异。只对 `openai` 格式生效，其他格式忽略。
 * 没有给出的项由运行时按地址自动判断（例如 `deepseek.com`）；经代理接入时需要显式给出。
 * 与具体运行时无关，由 `runtime-pi` 转换为 pi 的参数。
 */
export const ModelCompat = z
  .object({
    thinkingFormat: ThinkingFormat.optional(),
    /** 回传历史时，助手消息必须带推理内容字段（DeepSeek 思考模式下的多轮工具调用）。 */
    requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsStore: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
  })
  .strict()
export type ModelCompat = z.infer<typeof ModelCompat>

/** 一个模型的能力（架构 §12.1 的 `ModelProfile`）；`verifiedAt` 为最近一次能力探测的时间。 */
export const ModelProfile = z.object({
  /** 提供方的模型名。 */
  id: Id.max(256),
  displayName: z.string().max(256).optional(),
  contextWindow: PositiveInt,
  maxOutputTokens: PositiveInt,
  supportsTools: z.boolean(),
  supportsParallelToolCalls: z.boolean(),
  supportsReasoning: z.boolean(),
  verifiedAt: Timestamp.optional(),
  /** 只对这个模型生效的兼容参数，逐项覆盖提供方的 `compat`。 */
  compat: ModelCompat.optional(),
})
export type ModelProfile = z.infer<typeof ModelProfile>

/**
 * 地址只接受 http 与 https（本地服务如 Ollama 用 http），不能带用户名或密码。
 * protocol 包不依赖 DOM / Node 的类型，因此用正则检查，不用 `URL`。
 */
export const BASE_URL_PATTERN = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i
export const BaseUrl = z.string().max(2048).regex(BASE_URL_PATTERN)

export const ProviderConfig = z
  .object({
    id: z.string().regex(CONFIG_ID_PATTERN),
    kind: ProviderKind,
    displayName: z.string().min(1).max(256),
    baseUrl: BaseUrl,
    /** 凭据服务中的条目；本地服务（如 Ollama）可以没有。 */
    credentialRef: z.string().regex(CONFIG_ID_PATTERN).optional(),
    /** 创建时所用的配置模板（M1-04b），用于界面显示与恢复模板的默认值。 */
    template: z.string().regex(CONFIG_ID_PATTERN).optional(),
    /** 提供方所有模型的兼容参数；创建时取自模板，可在高级设置中修改。 */
    compat: ModelCompat.optional(),
    models: z.array(ModelProfile).max(256),
  })
  .refine((config) => new Set(config.models.map((m) => m.id)).size === config.models.length, {
    message: 'duplicate model id',
    path: ['models'],
  })
export type ProviderConfig = z.infer<typeof ProviderConfig>

/** 提供方列表：id 不能重复。 */
export const ProviderConfigList = z
  .array(ProviderConfig)
  .max(64)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
    message: 'duplicate provider id',
  })
