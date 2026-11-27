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

const Price = z.number().nonnegative()

/**
 * 思考强度（M1-04c）：只对声明了 `supportsReasoning` 的模型有意义。运行时支持更多档位
 * （`off`、`minimal`、`xhigh`、`max`），但 `off` 与「不支持思考」重复，其余档位各家语义不一，
 * 界面只承诺这三档。没有设置时按 `high`。
 */
export const ReasoningEffort = z.enum(['low', 'medium', 'high'])
export type ReasoningEffort = z.infer<typeof ReasoningEffort>

/**
 * 单价（Runtime §15）：每百万 token 的价格，货币按提供方的计价（界面只显示数字）。用于估算费用与
 * `maxCostPerTurn` 限额（M1-14b）；没有填写时只统计 token。缓存命中的输入没有单独价格时按普通输入计。
 */
export const ModelPricing = z
  .object({
    inputPerMillion: Price,
    outputPerMillion: Price,
    cacheReadPerMillion: Price.optional(),
  })
  .strict()
export type ModelPricing = z.infer<typeof ModelPricing>

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
  /** 思考强度；只在 `supportsReasoning` 为真时生效，省略时按 `high`。 */
  thinkingLevel: ReasoningEffort.optional(),
  verifiedAt: Timestamp.optional(),
  /**
   * 是否在模型选择中列出（M2-10）；省略表示启用。停用的模型不能设为默认模型，已在使用它的会话不受影响。
   */
  enabled: z.boolean().optional(),
  /** 只对这个模型生效的兼容参数，逐项覆盖提供方的 `compat`。 */
  compat: ModelCompat.optional(),
  pricing: ModelPricing.optional(),
})
export type ModelProfile = z.infer<typeof ModelProfile>

/**
 * 地址只接受 http 与 https（本地服务如 Ollama 用 http），不能带用户名或密码。
 * protocol 包不依赖 DOM / Node 的类型，因此用正则检查，不用 `URL`。
 */
export const BASE_URL_PATTERN = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i
export const BaseUrl = z.string().max(2048).regex(BASE_URL_PATTERN)

/** 从提供方拉取到的模型（M2-10，`provider.models`）：能力只在接口给出时才有。 */
export const RemoteModel = z.object({
  id: Id.max(256),
  displayName: z.string().max(256).optional(),
  contextWindow: PositiveInt.optional(),
  maxOutputTokens: PositiveInt.optional(),
})
export type RemoteModel = z.infer<typeof RemoteModel>

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
    /**
     * 上次从提供方拉取到的模型列表（M2-10）。只作为缓存：保存后再次打开编辑时直接显示，
     * 不必重新拉取；其中未加入 `models` 的项以未启用状态出现。
     */
    catalog: z.array(RemoteModel).max(1000).optional(),
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

/**
 * 供应商目录（ADR-0049）：添加供应商时可选的服务。内置目录在 `@cairn/core`，其余来自用户安装的供应商插件。
 * 目录只在添加时使用：值复制进 `ProviderConfig`，之后以配置为准，卸载插件不影响已添加的供应商。
 *
 * - `vendor`：模型厂商的官方接口；`relay`：聚合平台与中转；`local`：本机运行的模型服务。
 */
export const ProviderCategory = z.enum(['vendor', 'relay', 'local'])
export type ProviderCategory = z.infer<typeof ProviderCategory>

/** 同一服务的不同接入点：国际站与中国大陆站通常是不同的账号与地址。 */
export const ProviderRegionId = z.enum(['global', 'cn'])
export type ProviderRegionId = z.infer<typeof ProviderRegionId>

/** “获取 Key”之类的外部链接只接受 https。 */
export const HTTPS_URL_PATTERN = /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i
const HttpsUrl = z.string().max(2048).regex(HTTPS_URL_PATTERN)

/**
 * 图标（ADR-0049）：界面只显示 `https` 图片或 `data:image/…;base64,` 内联图片。插件文件中还可以写相对路径
 * （如 `icons/acme.svg`），从官方目录安装时相对仓库根目录解析成 `https`；本地文件中的相对路径无法解析，
 * 会被忽略并回到网站图标（favicon）。
 */
export const ICON_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/
/** 相对路径：不以 `/` 开头、没有 `..`、只用常见字符。 */
export const RELATIVE_ASSET_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,256}$/
/** 内联图标的长度上限（约 96 KB 的图片）。 */
export const ICON_DATA_URL_MAX = 131_072
export const IconUrl = z
  .string()
  .max(ICON_DATA_URL_MAX)
  .refine((value) => HTTPS_URL_PATTERN.test(value) || ICON_DATA_URL_PATTERN.test(value), {
    message: 'icon must be an https URL or a data:image URL',
  })
/** 插件文件里的图标：`IconUrl`，或待解析的相对路径。 */
export const IconRef = z
  .string()
  .max(ICON_DATA_URL_MAX)
  .refine(
    (value) =>
      HTTPS_URL_PATTERN.test(value) ||
      ICON_DATA_URL_PATTERN.test(value) ||
      RELATIVE_ASSET_PATTERN.test(value),
    { message: 'icon must be an https URL, a data:image URL, or a relative path' },
  )

/**
 * 求图标的依据（`providerIcon.resolve`）：显式的 `icon` 优先；没有时按 `homepage`、`keysUrl`、`baseUrl`
 * 的顺序找网站图标（favicon）。
 */
export const IconSource = z.object({
  icon: IconUrl.optional(),
  homepage: z.string().max(2048).regex(HTTPS_URL_PATTERN).optional(),
  keysUrl: z.string().max(2048).regex(HTTPS_URL_PATTERN).optional(),
  baseUrl: z.string().max(2048).regex(BASE_URL_PATTERN).optional(),
})
export type IconSource = z.infer<typeof IconSource>

export const ProviderRegion = z.object({
  id: ProviderRegionId,
  baseUrl: BaseUrl,
  /** 这个接入点申请 Key 的页面；省略时用服务的 `keysUrl`。 */
  keysUrl: HttpsUrl.optional(),
})
export type ProviderRegion = z.infer<typeof ProviderRegion>

/** 模型的能力部分（不含 id 与显示名），用作手动添加或拉取到的模型的默认值。 */
export const ModelCapabilities = ModelProfile.pick({
  contextWindow: true,
  maxOutputTokens: true,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: true,
})
export type ModelCapabilities = z.infer<typeof ModelCapabilities>

/** 目录中的一项（内置或插件提供），经 `providerPlugin.*` 传给界面。 */
export const ProviderTemplateSpec = z
  .object({
    /** 模板 id；插件的模板为 `<插件 id>.<条目 id>`，不会与内置模板重名。 */
    id: z.string().regex(CONFIG_ID_PATTERN),
    kind: ProviderKind,
    category: ProviderCategory,
    displayName: z.string().min(1).max(80),
    /** 默认地址；有 `regions` 时必须是其中之一。 */
    baseUrl: BaseUrl,
    regions: z.array(ProviderRegion).min(2).max(4).optional(),
    requiresKey: z.boolean(),
    /** 申请 Key 的页面。 */
    keysUrl: HttpsUrl.optional(),
    /** 服务的网站；没有 `icon` 时优先从这里取网站图标。 */
    homepage: HttpsUrl.optional(),
    /** 图标；省略时用网站图标（favicon）。 */
    icon: IconUrl.optional(),
    compat: ModelCompat.optional(),
    models: z.array(ModelProfile).max(64),
    /**
     * 没有预置模型时，拉取到模型列表后自动启用其中的这些模型（按顺序，不存在的忽略），
     * 让用户只填 Key 就能用。
     */
    suggestedModels: z.array(Id.max(256)).max(16).optional(),
    modelDefaults: ModelCapabilities,
    /** 提供这一项的插件；内置模板没有。 */
    pluginId: z.string().regex(CONFIG_ID_PATTERN).optional(),
  })
  .refine(
    (spec) => !spec.regions || spec.regions.some((region) => region.baseUrl === spec.baseUrl),
    { message: 'baseUrl must be one of the regions', path: ['baseUrl'] },
  )
  .refine(
    (spec) => !spec.regions || new Set(spec.regions.map((r) => r.id)).size === spec.regions.length,
    { message: 'duplicate region id', path: ['regions'] },
  )
export type ProviderTemplateSpec = z.infer<typeof ProviderTemplateSpec>

/** 供应商插件与其中条目的 id：小写字母、数字与 `-`，不以 `-` 开头或结尾。 */
export const PROVIDER_PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const PluginId = z.string().regex(PROVIDER_PLUGIN_ID_PATTERN)

/** 当前支持的插件格式版本。 */
export const PROVIDER_PLUGIN_SCHEMA_VERSION = 1

/** 插件中的模型：只有 `id` 必填，其余缺省时取条目的 `modelDefaults`。 */
export const ProviderPluginModel = z.object({
  id: Id.max(256),
  displayName: z.string().max(256).optional(),
  contextWindow: PositiveInt.optional(),
  maxOutputTokens: PositiveInt.optional(),
  supportsTools: z.boolean().optional(),
  supportsParallelToolCalls: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  thinkingLevel: ReasoningEffort.optional(),
  pricing: ModelPricing.optional(),
})
export type ProviderPluginModel = z.infer<typeof ProviderPluginModel>

/** 插件中的一个服务（ADR-0049）。 */
export const ProviderPluginEntry = z.object({
  id: PluginId,
  name: z.string().trim().min(1).max(80),
  kind: ProviderKind,
  category: ProviderCategory.optional(),
  baseUrl: BaseUrl,
  regions: z.array(ProviderRegion).min(2).max(4).optional(),
  /** 省略时需要 Key。 */
  requiresKey: z.boolean().optional(),
  keysUrl: HttpsUrl.optional(),
  homepage: HttpsUrl.optional(),
  icon: IconRef.optional(),
  compat: ModelCompat.optional(),
  models: z.array(ProviderPluginModel).max(64).optional(),
  suggestedModels: z.array(Id.max(256)).max(16).optional(),
  modelDefaults: ModelCapabilities.partial().optional(),
})
export type ProviderPluginEntry = z.infer<typeof ProviderPluginEntry>

/**
 * 供应商插件（ADR-0049）：一个 JSON 文件，声明一个或多个服务。只有数据，不含代码；
 * 装在应用数据目录的 `provider-plugins/` 下。未知字段忽略，`compat` 中的未知字段报错。
 */
export const ProviderPluginManifest = z
  .object({
    schemaVersion: z.literal(PROVIDER_PLUGIN_SCHEMA_VERSION),
    id: PluginId,
    name: z.string().trim().min(1).max(80),
    version: z.string().max(32).optional(),
    description: z.string().max(280).optional(),
    homepage: HttpsUrl.optional(),
    icon: IconRef.optional(),
    providers: z.array(ProviderPluginEntry).min(1).max(32),
  })
  .refine((plugin) => new Set(plugin.providers.map((p) => p.id)).size === plugin.providers.length, {
    message: 'duplicate provider id',
    path: ['providers'],
  })
export type ProviderPluginManifest = z.infer<typeof ProviderPluginManifest>

/** 已安装的插件（界面用）：模板已展开为目录项。 */
export const ProviderPluginInfo = z.object({
  id: PluginId,
  name: z.string().min(1).max(80),
  version: z.string().max(32).optional(),
  description: z.string().max(280).optional(),
  homepage: HttpsUrl.optional(),
  icon: IconUrl.optional(),
  templates: z.array(ProviderTemplateSpec).max(32),
})
export type ProviderPluginInfo = z.infer<typeof ProviderPluginInfo>

/** 插件目录中无法加载的文件：只给文件名与错误码。 */
export const ProviderPluginSkipped = z.object({
  file: z.string().min(1).max(260),
  code: z.string().min(1),
})
export type ProviderPluginSkipped = z.infer<typeof ProviderPluginSkipped>

/**
 * 官方插件目录（ADR-0049）：`https://github.com/960602906/cairn-provider-plugins` 默认分支上的 `index.json`
 * 列出插件，插件文件在同一仓库内（`path`，省略时为 `plugins/<id>.json`）。只读这个仓库里的文件；
 * 插件声明的地址照常在安装前预览。
 */
export const PROVIDER_CATALOG_SCHEMA_VERSION = 1

/** `index.json` 中的一项；无效的项跳过，不影响其余插件。 */
export const ProviderCatalogIndexEntry = z.object({
  id: PluginId,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(280).optional(),
  version: z.string().max(32).optional(),
  homepage: HttpsUrl.optional(),
  icon: IconRef.optional(),
  /**
   * 插件文件的位置：相对 `index.json`（仓库根目录）的路径，或仓库内文件的 https 地址；指向仓库以外的项被跳过。
   * 省略时为 `plugins/<id>.json`。
   */
  url: z
    .string()
    .max(2048)
    .refine((value) => HTTPS_URL_PATTERN.test(value) || RELATIVE_ASSET_PATTERN.test(value), {
      message: 'url must be an https URL or a relative path',
    })
    .optional(),
  /** `url` 的旧名，只在没有 `url` 时使用。 */
  path: z.string().regex(RELATIVE_ASSET_PATTERN).optional(),
})
export type ProviderCatalogIndexEntry = z.infer<typeof ProviderCatalogIndexEntry>

export const ProviderCatalogIndex = z.object({
  /** 更高的版本报 `providers.catalog.unsupported_version`（需要更新 Cairn）。 */
  schemaVersion: z.literal(PROVIDER_CATALOG_SCHEMA_VERSION),
  plugins: z.array(z.unknown()).max(500),
})

/** 界面中的目录项：图标已解析。 */
export const ProviderCatalogItem = z.object({
  id: PluginId,
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional(),
  version: z.string().max(32).optional(),
  homepage: HttpsUrl.optional(),
  icon: IconUrl.optional(),
})
export type ProviderCatalogItem = z.infer<typeof ProviderCatalogItem>
