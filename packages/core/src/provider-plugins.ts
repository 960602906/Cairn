/**
 * 供应商插件（ADR-0050）：一个只有数据的 JSON 文件，声明一个或多个服务，展开为与内置目录同结构的模板。
 *
 * - 模板 id 为 `<插件 id>.<条目 id>`，不会与内置模板或别的插件重名。
 * - 条目没写的能力取条目的 `modelDefaults`，再取通用默认值；没写类别时当作聚合平台 / 中转。
 * - 不读写文件；扫描与安装在主进程（`provider-plugin-service`）。
 */
import {
  HTTPS_URL_PATTERN,
  ICON_DATA_URL_PATTERN,
  PROVIDER_PLUGIN_SCHEMA_VERSION,
  PROVIDER_PLUGIN_TYPE,
  RELATIVE_ASSET_PATTERN,
  ProviderPluginManifest,
  ProviderTemplateSpec,
  type ModelCapabilities,
  type ModelProfile,
  type PluginOrigin,
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
  UnsupportedType: 'providers.plugin.unsupported_type',
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
  const type = (json as { type?: unknown } | null)?.type
  if (type !== undefined && type !== PROVIDER_PLUGIN_TYPE) {
    throw new ProviderPluginError(
      ProviderPluginErrorCode.UnsupportedType,
      `This plugin is of type ${JSON.stringify(type)}; this Cairn only installs provider plugins.`,
    )
  }
  const parsed = ProviderPluginManifest.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const path = issue.path.join('.')
    throw new ProviderPluginError(
      ProviderPluginErrorCode.Invalid,
      `Invalid plugin${path ? ` at ${path}` : ''}: ${issue.message}`,
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

/** 已经能直接显示的图标（https 或内联图片）。 */
export const isIconUrl = (value: string): boolean =>
  HTTPS_URL_PATTERN.test(value) || ICON_DATA_URL_PATTERN.test(value)

/**
 * 解析插件文件里的图标：https 与内联图片原样返回；相对路径按 `base`（https 地址）所在目录解析——官方目录
 * 传入仓库根目录下 `index.json` 的地址。没有 `base` 或无法解析时为 undefined。
 */
export function resolveAssetUrl(ref: string, base: string | undefined): string | undefined {
  if (isIconUrl(ref)) return ref
  if (!RELATIVE_ASSET_PATTERN.test(ref) || base === undefined || !HTTPS_URL_PATTERN.test(base)) {
    return undefined
  }
  const dir = base.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
  const path = ref
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
  return path === '' ? undefined : `${dir}${path}`
}

/** 把插件中的相对图标解析成 https 地址；解析不了的去掉（回到网站图标）。 */
export function resolvePluginIcons(
  manifest: ProviderPluginManifest,
  base: string | undefined,
): ProviderPluginManifest {
  const icon = manifest.icon === undefined ? undefined : resolveAssetUrl(manifest.icon, base)
  const { icon: _icon, ...rest } = manifest
  return {
    ...rest,
    ...(icon ? { icon } : {}),
    providers: manifest.providers.map((entry) => {
      const { icon: _entryIcon, ...other } = entry
      const resolved = entry.icon === undefined ? undefined : resolveAssetUrl(entry.icon, base)
      return { ...other, ...(resolved ? { icon: resolved } : {}) }
    }),
  }
}

const displayIcon = (icon: string | undefined) =>
  icon !== undefined && isIconUrl(icon) ? { icon } : {}

/** 服务没有自己的图标或网站时用插件的（都没有图标时界面再找网站图标）。 */
function templateOf(
  pluginId: string,
  entry: ProviderPluginEntry,
  plugin: { readonly icon?: string | undefined; readonly homepage?: string | undefined },
): ProviderTemplate {
  const homepage = entry.homepage ?? plugin.homepage
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
    ...(homepage ? { homepage } : {}),
    ...displayIcon(entry.icon !== undefined && isIconUrl(entry.icon) ? entry.icon : plugin.icon),
    ...(entry.compat ? { compat: entry.compat } : {}),
    models,
    ...(entry.suggestedModels ? { suggestedModels: entry.suggestedModels } : {}),
    modelDefaults,
    pluginId,
  }
  const checked = ProviderTemplateSpec.safeParse(template)
  if (!checked.success) {
    const issue = checked.error.issues[0]!
    throw new ProviderPluginError(
      ProviderPluginErrorCode.Invalid,
      `Invalid provider "${entry.id}": ${issue.message}`,
      ['providers', entry.id, ...issue.path].join('.'),
    )
  }
  return template
}

/** 插件声明的来源是否为官方（只是声明；能否显示“官方”由安装来源决定）。 */
export const claimsOfficial = (source: string | undefined): boolean => source === 'official'

/**
 * 插件 → 界面使用的信息（模板已展开）。还没解析的相对图标不显示。`origin` 由调用方按安装来源给出，
 * 不取自插件内容，插件无法自称官方。
 */
export function providerPluginInfo(
  manifest: ProviderPluginManifest,
  origin: PluginOrigin = 'local',
): ProviderPluginInfo {
  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.author ? { author: manifest.author } : {}),
    origin,
    ...(manifest.version ? { version: manifest.version } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...displayIcon(manifest.icon),
    templates: manifest.providers.map((entry) => templateOf(manifest.id, entry, manifest)),
  }
}
