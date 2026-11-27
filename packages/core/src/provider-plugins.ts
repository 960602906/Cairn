/**
 * 供应商插件（ADR-0049）：一个只有数据的 JSON 文件，声明一个或多个服务，展开为与内置目录同结构的模板。
 *
 * - 模板 id 为 `<插件 id>.<条目 id>`，不会与内置模板或别的插件重名。
 * - 条目没写的能力取条目的 `modelDefaults`，再取通用默认值；没写类别时当作聚合平台 / 中转。
 * - 不读写文件；扫描与安装在主进程（`provider-plugin-service`）。
 */
import {
  PROVIDER_PLUGIN_SCHEMA_VERSION,
  ProviderPluginManifest,
  ProviderTemplateSpec,
  type ModelCapabilities,
  type ModelProfile,
  type ProviderPluginEntry,
  type ProviderPluginInfo,
} from '@cairn/protocol'
import { GENERIC_MODEL_DEFAULTS, type ProviderTemplate } from './provider-templates.js'

export const ProviderPluginErrorCode = {
  Invalid: 'providers.plugin.invalid',
  UnsupportedVersion: 'providers.plugin.unsupported_version',
  TooLarge: 'providers.plugin.too_large',
  Duplicate: 'providers.plugin.duplicate',
  NotFound: 'providers.plugin.not_found',
} as const
export type ProviderPluginErrorCode =
  (typeof ProviderPluginErrorCode)[keyof typeof ProviderPluginErrorCode]

/** 插件文件的大小上限。 */
export const PROVIDER_PLUGIN_MAX_BYTES = 256 * 1024

export class ProviderPluginError extends Error {
  constructor(
    readonly code: ProviderPluginErrorCode,
    message: string,
    /** 出错的字段路径（如 `providers.0.baseUrl`），便于插件作者定位。 */
    readonly path?: string,
  ) {
    super(message)
    this.name = 'ProviderPluginError'
  }
}

/** 解析并校验插件文件的文本。 */
export function parseProviderPlugin(text: string): ProviderPluginManifest {
  if (text.length > PROVIDER_PLUGIN_MAX_BYTES) {
    throw new ProviderPluginError(ProviderPluginErrorCode.TooLarge, 'The plugin file is too large.')
  }
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new ProviderPluginError(ProviderPluginErrorCode.Invalid, 'The plugin is not valid JSON.')
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof version === 'number' && version !== PROVIDER_PLUGIN_SCHEMA_VERSION) {
    throw new ProviderPluginError(
      ProviderPluginErrorCode.UnsupportedVersion,
      `Unsupported plugin schemaVersion ${version}.`,
    )
  }
  const parsed = ProviderPluginManifest.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.')
    throw new ProviderPluginError(
      ProviderPluginErrorCode.Invalid,
      `Invalid plugin${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unknown error'}`,
      path || undefined,
    )
  }
  return parsed.data
}

type MaybeCapabilities = {
  readonly [K in keyof ModelCapabilities]?: ModelCapabilities[K] | undefined
}

function capabilitiesOf(
  given: MaybeCapabilities | undefined,
  base: ModelCapabilities,
): ModelCapabilities {
  return {
    contextWindow: given?.contextWindow ?? base.contextWindow,
    maxOutputTokens: given?.maxOutputTokens ?? base.maxOutputTokens,
    supportsTools: given?.supportsTools ?? base.supportsTools,
    supportsParallelToolCalls: given?.supportsParallelToolCalls ?? base.supportsParallelToolCalls,
    supportsReasoning: given?.supportsReasoning ?? base.supportsReasoning,
  }
}

function templateOf(pluginId: string, entry: ProviderPluginEntry): ProviderTemplate {
  const modelDefaults = capabilitiesOf(entry.modelDefaults, GENERIC_MODEL_DEFAULTS)
  const models: ModelProfile[] = (entry.models ?? []).map((m) => ({
    id: m.id,
    ...(m.displayName ? { displayName: m.displayName } : {}),
    ...capabilitiesOf(m, modelDefaults),
    ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
    ...(m.pricing ? { pricing: m.pricing } : {}),
  }))
  const template: ProviderTemplate = {
    id: `${pluginId}.${entry.id}`,
    kind: entry.kind,
    category: entry.category ?? 'relay',
    displayName: entry.name,
    baseUrl: entry.baseUrl,
    ...(entry.regions ? { regions: entry.regions } : {}),
    requiresKey: entry.requiresKey ?? true,
    ...(entry.keysUrl ? { keysUrl: entry.keysUrl } : {}),
    ...(entry.compat ? { compat: entry.compat } : {}),
    models,
    ...(entry.suggestedModels ? { suggestedModels: entry.suggestedModels } : {}),
    modelDefaults,
    pluginId,
  }
  const checked = ProviderTemplateSpec.safeParse(template)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    throw new ProviderPluginError(
      ProviderPluginErrorCode.Invalid,
      `Invalid provider "${entry.id}": ${issue?.message ?? 'unknown error'}`,
      ['providers', entry.id, ...(issue?.path ?? [])].join('.'),
    )
  }
  return template
}

/** 插件 → 界面使用的信息（模板已展开）。 */
export function providerPluginInfo(manifest: ProviderPluginManifest): ProviderPluginInfo {
  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    templates: manifest.providers.map((entry) => templateOf(manifest.id, entry)),
  }
}
