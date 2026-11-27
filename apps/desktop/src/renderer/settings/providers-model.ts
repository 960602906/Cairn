/**
 * 模型供应商页的纯逻辑（M2-10、ADR-0049）：来源判断、图标、目录分组、编辑中的草稿与保存的配置之间的转换、
 * 默认能力、测试目标等。
 *
 * 目录（`catalog`）是内置模板加已安装插件的模板；参数省略时只用内置模板。已保存的供应商找不到模板
 * （例如插件已卸载）时按普通的第三方中转处理，配置本身不受影响。
 */
import {
  findTemplateIn,
  GENERIC_MODEL_DEFAULTS,
  isTemplateUrl,
  preferredRegion,
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from '@cairn/core'
import {
  BASE_URL_PATTERN,
  CONFIG_ID_PATTERN,
  type IconSource,
  type ModelCompat,
  type ModelProfile,
  type ProviderCategory,
  type ProviderConfig,
  type ProviderKind,
  type ProviderPluginInfo,
  type RemoteModel,
} from '@cairn/protocol'

export { GENERIC_MODEL_DEFAULTS }

/** 模板 id 已被占用时加序号：`deepseek`、`deepseek-2`…… */
export function uniqueProviderId(base: string, providers: readonly ProviderConfig[]): string {
  const taken = new Set(providers.map((p) => p.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** 由名称得到提供方 id 的基础部分（只留字母、数字、`.`、`_`、`-`），得不到时用 `custom`。 */
export function slugId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return CONFIG_ID_PATTERN.test(slug) ? slug : 'custom'
}

/** 内置模板加插件模板；插件模板的 id 带插件前缀，不会与内置模板重名。 */
export function catalogOf(plugins: readonly ProviderPluginInfo[] | undefined) {
  if (!plugins || plugins.length === 0) return PROVIDER_TEMPLATES
  return [...PROVIDER_TEMPLATES, ...plugins.flatMap((plugin) => plugin.templates)]
}

export type ProviderSource = 'official' | 'relay'

/** 来源：用模板创建、地址仍是模板的地址（含各接入点）时为官方，否则为第三方中转。 */
export function sourceOf(
  provider: Pick<ProviderConfig, 'template' | 'baseUrl'>,
  catalog: readonly ProviderTemplate[] = PROVIDER_TEMPLATES,
): ProviderSource {
  const template = findTemplateIn(catalog, provider.template)
  return template && isTemplateUrl(template, provider.baseUrl) ? 'official' : 'relay'
}

/** 这种接口格式的模板（高级设置里的“兼容服务”）。 */
export const templatesOf = (
  kind: ProviderKind,
  catalog: readonly ProviderTemplate[] = PROVIDER_TEMPLATES,
): readonly ProviderTemplate[] => catalog.filter((t) => t.kind === kind)

export const CATEGORIES: readonly ProviderCategory[] = ['vendor', 'relay', 'local']

/** 添加对话框里的分组：按类别，组内保持目录顺序；名称包含查询词（不区分大小写）才列出。 */
export function catalogGroups(
  catalog: readonly ProviderTemplate[],
  query = '',
): readonly { readonly category: ProviderCategory; readonly templates: ProviderTemplate[] }[] {
  const q = query.trim().toLowerCase()
  const matches = (t: ProviderTemplate) =>
    q === '' ||
    t.displayName.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q) ||
    hostOf(t.baseUrl).includes(q)
  return CATEGORIES.map((category) => ({
    category,
    templates: catalog.filter((t) => t.category === category && matches(t)),
  })).filter((group) => group.templates.length > 0)
}

/** 地址的主机名（列表中显示），解析不了时原样返回。 */
export function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim())
  return (match?.[1] ?? url).toLowerCase()
}

/** 列表与编辑区的图标：名称的首字母（两个词取两个首字母，中文取第一个字），底色按模板。 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]!][0]!
  if (first.charCodeAt(0) > 0x7f) return first
  if (words.length > 1) return (first + [...words[1]!][0]!).toUpperCase()
  return first.toUpperCase()
}

const LOGO_COLORS: Readonly<Record<string, string>> = {
  deepseek: '#4d6bfe',
  anthropic: '#c96442',
  openai: '#10a37f',
  gemini: '#1a73e8',
}

export const logoColor = (template: string | undefined): string =>
  (template && LOGO_COLORS[template]) ?? '#2d2f36'

/** 有品牌图标的模板；其余模板用名称首字母。 */
export const BRAND_TEMPLATES: ReadonlySet<string> = new Set([
  'deepseek',
  'anthropic',
  'openai',
  'gemini',
])

/** 目录项的图标依据：显式图标，否则按网站、申请 Key 的页面、接口地址找网站图标。 */
export function iconSourceOf(
  template: Pick<ProviderTemplate, 'icon' | 'homepage' | 'keysUrl' | 'baseUrl' | 'regions'>,
): IconSource {
  const keysUrl = template.keysUrl ?? template.regions?.find((r) => r.keysUrl)?.keysUrl
  return {
    ...(template.icon ? { icon: template.icon } : {}),
    ...(template.homepage ? { homepage: template.homepage } : {}),
    ...(keysUrl ? { keysUrl } : {}),
    baseUrl: template.baseUrl,
  }
}

/** 官方插件目录仓库（ADR-0049）；目录内容由主进程读取，界面只用它显示来源链接。 */
export const OFFICIAL_CATALOG_PAGE = 'https://github.com/960602906/cairn-provider-plugins'

/** 插件的图标依据：插件自己的图标或网站；都没有时用第一个服务的。 */
export function pluginIconSourceOf(plugin: {
  readonly icon?: string | undefined
  readonly homepage?: string | undefined
  readonly templates?: readonly ProviderTemplate[]
}): IconSource | undefined {
  if (plugin.icon || plugin.homepage) {
    return {
      ...(plugin.icon ? { icon: plugin.icon } : {}),
      ...(plugin.homepage ? { homepage: plugin.homepage } : {}),
    }
  }
  const first = plugin.templates?.[0]
  return first ? iconSourceOf(first) : undefined
}

/** token 数的简写：`128k`、`1M`、`1.5M`。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function modelDefaults(
  templateId: string | undefined,
  catalog: readonly ProviderTemplate[] = PROVIDER_TEMPLATES,
) {
  return findTemplateIn(catalog, templateId)?.modelDefaults ?? GENERIC_MODEL_DEFAULTS
}

/** 由拉取到的模型（或手填的 id、上下文长度）得到模型配置。 */
export function profileFrom(
  remote: RemoteModel,
  templateId: string | undefined,
  catalog: readonly ProviderTemplate[] = PROVIDER_TEMPLATES,
): ModelProfile {
  const defaults = modelDefaults(templateId, catalog)
  return {
    ...defaults,
    id: remote.id,
    ...(remote.displayName && remote.displayName !== remote.id
      ? { displayName: remote.displayName }
      : {}),
    ...(remote.contextWindow ? { contextWindow: remote.contextWindow } : {}),
    ...(remote.maxOutputTokens ? { maxOutputTokens: remote.maxOutputTokens } : {}),
  }
}

/** 编辑中的供应商。`catalog` 是上次拉取到的模型列表，只作为列表的一部分展示与缓存。 */
export interface ProviderDraft {
  readonly kind: ProviderKind
  readonly displayName: string
  readonly baseUrl: string
  readonly template?: string | undefined
  readonly compat?: ModelCompat | undefined
  readonly models: readonly ModelProfile[]
  readonly catalog?: readonly RemoteModel[] | undefined
}

export function draftOf(provider: ProviderConfig): ProviderDraft {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    template: provider.template,
    compat: provider.compat,
    models: provider.models,
    catalog: provider.catalog,
  }
}

/** 新供应商的草稿：默认第一个模板（官方）。有多个接入点时按界面语言选。 */
export function newDraft(
  template: ProviderTemplate = PROVIDER_TEMPLATES[0]!,
  locale = '',
): ProviderDraft {
  return {
    kind: template.kind,
    displayName: template.displayName,
    baseUrl: preferredRegion(template, locale)?.baseUrl ?? template.baseUrl,
    template: template.id,
    compat: template.compat ? { ...template.compat } : undefined,
    models: template.models.map((m) => ({ ...m })),
  }
}

/**
 * 新建草稿，并避开已存在的显示名：第二个 DeepSeek 默认叫“DeepSeek 2”，
 * 列表里不会出现两行一模一样的名字。
 */
export function newDraftFor(providers: readonly ProviderConfig[]): ProviderDraft {
  const base = PROVIDER_TEMPLATES[0]!
  return { ...newDraft(base), displayName: uniqueDisplayName(base.displayName, providers) }
}

/** 显示名去重：`DeepSeek`、`DeepSeek 2`…… */
export function uniqueDisplayName(base: string, providers: readonly ProviderConfig[]): string {
  const taken = new Set(providers.map((provider) => provider.displayName.trim()))
  let name = base
  let n = 2
  while (taken.has(name)) name = `${base} ${n++}`
  return name
}

/** 用指定服务模板新建草稿。 */
export function newDraftForTemplate(
  template: ProviderTemplate,
  providers: readonly ProviderConfig[],
  locale = '',
): ProviderDraft {
  return {
    ...newDraft(template, locale),
    displayName: uniqueDisplayName(template.displayName, providers),
  }
}

/** 自定义/中转草稿：不套用官方模板，地址与兼容参数自己填。 */
export function genericDraftFor(
  kind: ProviderKind,
  displayName: string,
  providers: readonly ProviderConfig[],
): ProviderDraft {
  return {
    kind,
    displayName: uniqueDisplayName(displayName, providers),
    baseUrl: '',
    template: undefined,
    compat: undefined,
    models: [],
  }
}

/** 草稿中需要改正的字段。 */
export interface DraftProblems {
  readonly displayName?: true
  readonly baseUrl?: true
}

export function problemsOf(draft: ProviderDraft): DraftProblems {
  return {
    ...(draft.displayName.trim() === '' ? { displayName: true } : {}),
    ...(BASE_URL_PATTERN.test(draft.baseUrl.trim()) ? {} : { baseUrl: true }),
  }
}

const isEmpty = (compat: ModelCompat | undefined) =>
  compat === undefined || Object.keys(compat).length === 0

/** 草稿 → 要保存的配置。凭据引用由调用方给出（沿用原有的，没有时用供应商 id）。 */
export function configOf(
  draft: ProviderDraft,
  id: string,
  credentialRef: string | undefined,
): ProviderConfig {
  return {
    id,
    kind: draft.kind,
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    ...(credentialRef ? { credentialRef } : {}),
    ...(draft.template ? { template: draft.template } : {}),
    ...(draft.kind === 'openai' && !isEmpty(draft.compat) ? { compat: draft.compat } : {}),
    models: [...draft.models],
    ...(draft.catalog && draft.catalog.length > 0 ? { catalog: [...draft.catalog] } : {}),
  }
}

/**
 * 凭据引用：已保存的沿用原来的；新建时需要 Key 的服务（或用户填了 Key）用供应商 id，
 * 不需要 Key 的本机服务没有。
 */
export function credentialRefFor(
  saved: ProviderConfig | undefined,
  id: string,
  template: ProviderTemplate | undefined,
  hasSecret: boolean,
): string | undefined {
  if (saved?.credentialRef) return saved.credentialRef
  if (saved && !hasSecret) return undefined
  return hasSecret || template?.requiresKey !== false ? id : undefined
}

/** 列表中的一行：已配置的模型带 `profile`，只是拉取到、还没加入的没有。 */
export interface ModelRow {
  readonly id: string
  readonly displayName?: string | undefined
  readonly contextWindow?: number | undefined
  readonly profile?: ModelProfile | undefined
}

/** 把已配置的模型和拉取到的模型合并成一个列表：已配置的在前，其余按拉取顺序。 */
export function modelRowsOf(
  models: readonly ModelProfile[],
  catalog: readonly RemoteModel[] | undefined,
): readonly ModelRow[] {
  const seen = new Set(models.map((model) => model.id))
  return [
    ...models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      profile: model,
    })),
    ...(catalog ?? [])
      .filter((model) => !seen.has(model.id))
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
      })),
  ]
}

/** 已启用（省略 `enabled` 表示启用）的模型。 */
export const enabledModelIdsOf = (models: readonly ModelProfile[]): readonly string[] =>
  models.filter((model) => model.enabled !== false).map((model) => model.id)

/**
 * “测试连接”默认只测一个模型，避免一次向提供方发很多请求：默认模型（已启用时），否则第一个已启用的模型。
 */
export function testTargetOf(
  models: readonly ModelProfile[],
  defaultModelId: string | undefined,
): string | undefined {
  const enabled = enabledModelIdsOf(models)
  return defaultModelId !== undefined && enabled.includes(defaultModelId)
    ? defaultModelId
    : enabled[0]
}

/** 本机服务没有建议的模型时，拉取到的模型最多自动启用这么多个。 */
export const LOCAL_AUTO_ENABLE_LIMIT = 8
