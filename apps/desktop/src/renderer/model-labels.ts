/**
 * 模型引用的展示辅助：把设置里的供应商与模型配置换成用户看得懂的名称。
 *
 * 输入框的模型选择、设置页、目标判定和运行时间线共用这套命名，避免在界面上直接露出
 * `providerId · modelId`。配置缺失时退回原始 id，不丢信息。
 */
import type { ModelRef, ProviderConfig, ProviderKind } from '@cairn/protocol'

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a !== undefined && b !== undefined && a.providerId === b.providerId && a.modelId === b.modelId

/** 模型选择项：供应商名称用于分组，模型短名称用于按钮与菜单；能力字段供选择器旁注。 */
export interface ModelChoice {
  readonly ref: ModelRef
  readonly provider: string
  readonly kind: ProviderKind
  readonly name: string
  readonly contextWindow: number
  readonly supportsTools: boolean
  readonly supportsReasoning: boolean
}

/** 把设置里的供应商列表摊平成可选模型；停用的模型不列出。 */
export function enabledModelChoices(providers: readonly ProviderConfig[]): readonly ModelChoice[] {
  return providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        ref: { providerId: provider.id, modelId: model.id },
        provider: provider.displayName,
        kind: provider.kind,
        name: model.displayName ?? model.id,
        contextWindow: model.contextWindow,
        supportsTools: model.supportsTools,
        supportsReasoning: model.supportsReasoning,
      })),
  )
}

/** 新会话的默认模型：优先设置里的默认模型，否则用第一个启用的模型。 */
export function resolveDefaultModel(
  providers: readonly ProviderConfig[],
  preferred: ModelRef | undefined,
): ModelRef | undefined {
  const choices = enabledModelChoices(providers)
  return (choices.find((choice) => sameModel(preferred, choice.ref)) ?? choices[0])?.ref
}

/** 当前模型的短名称与“供应商 · 模型”全名。 */
export function modelLabels(
  model: ModelRef | undefined,
  providers: readonly ProviderConfig[],
): { readonly short: string | undefined; readonly full: string | undefined } {
  if (model === undefined) return { short: undefined, full: undefined }
  const provider = providers.find((item) => item.id === model.providerId)
  const configured = provider?.models.find((item) => item.id === model.modelId)
  const short = configured?.displayName ?? configured?.id ?? model.modelId
  const full = provider === undefined ? model.modelId : `${provider.displayName} · ${short}`
  return { short, full }
}

/**
 * 面板里的模型全名：供应商显示名 · 模型显示名。
 * 设置里找不到这个供应商时退回原始 `providerId · modelId`，和 `modelLabels` 的短名不同。
 */
export function modelLabel(model: ModelRef, providers: readonly ProviderConfig[]): string {
  const provider = providers.find((item) => item.id === model.providerId)
  if (provider === undefined) return `${model.providerId} · ${model.modelId}`
  const configured = provider.models.find((item) => item.id === model.modelId)
  return `${provider.displayName} · ${configured?.displayName ?? model.modelId}`
}
