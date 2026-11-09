/**
 * 模型供应商页的纯逻辑（M2-10）：来源判断、图标、编辑中的草稿与保存的配置之间的转换、默认能力等。
 */
import { findTemplate, PROVIDER_TEMPLATES, type ProviderTemplate } from '@cairn/core'
import {
  BASE_URL_PATTERN,
  CONFIG_ID_PATTERN,
  type ModelCompat,
  type ModelProfile,
  type ModelRef,
  type ProviderConfig,
  type ProviderKind,
  type RemoteModel,
} from '@cairn/protocol'

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

export type ProviderSource = 'official' | 'relay'

/** 来源：用模板创建、地址仍是模板的地址时为官方，否则为第三方中转。 */
export function sourceOf(provider: Pick<ProviderConfig, 'template' | 'baseUrl'>): ProviderSource {
  const template = provider.template ? findTemplate(provider.template) : undefined
  return template && sameUrl(template.baseUrl, provider.baseUrl) ? 'official' : 'relay'
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** 这种接口格式的模板（官方服务）。 */
export const templatesOf = (kind: ProviderKind): readonly ProviderTemplate[] =>
  PROVIDER_TEMPLATES.filter((t) => t.kind === kind)

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

/** token 数的简写：`128k`、`1M`、`1.5M`。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** 手动添加或拉取到的模型没有给出能力时使用的默认值。 */
export const GENERIC_MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
} as const

export function modelDefaults(templateId: string | undefined) {
  return (templateId && findTemplate(templateId)?.modelDefaults) || GENERIC_MODEL_DEFAULTS
}

/** 由拉取到的模型（或手填的 id、上下文长度）得到模型配置。 */
export function profileFrom(remote: RemoteModel, templateId: string | undefined): ModelProfile {
  const defaults = modelDefaults(templateId)
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

/** 编辑中的供应商。 */
export interface ProviderDraft {
  readonly kind: ProviderKind
  readonly displayName: string
  readonly baseUrl: string
  readonly template?: string | undefined
  readonly compat?: ModelCompat | undefined
  readonly models: readonly ModelProfile[]
}

export function draftOf(provider: ProviderConfig): ProviderDraft {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    template: provider.template,
    compat: provider.compat,
    models: provider.models,
  }
}

/** 新供应商的草稿：默认第一个模板（官方）。 */
export function newDraft(template: ProviderTemplate = PROVIDER_TEMPLATES[0]!): ProviderDraft {
  return {
    kind: template.kind,
    displayName: template.displayName,
    baseUrl: template.baseUrl,
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
): ProviderDraft {
  return { ...newDraft(template), displayName: uniqueDisplayName(template.displayName, providers) }
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
  }
}

/** 测试连接用的模型：默认模型在这个供应商中且启用时用它，否则用第一个启用的模型。 */
export function testModelOf(
  providerId: string,
  models: readonly ModelProfile[],
  defaultModel: ModelRef | undefined,
): string | undefined {
  const enabled = models.filter((m) => m.enabled !== false)
  if (
    defaultModel?.providerId === providerId &&
    enabled.some((m) => m.id === defaultModel.modelId)
  ) {
    return defaultModel.modelId
  }
  return enabled[0]?.id
}
