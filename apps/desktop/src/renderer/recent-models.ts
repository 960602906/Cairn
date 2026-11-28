/**
 * 最近选用的模型（本地偏好）：只存 `providerId/modelId`，界面再按启用列表过滤。
 * 与 `session-store` 里的 `cairn.recentAgents` 同一套 localStorage 写法；不可用时只在本次会话保留。
 */
import type { ModelRef } from '@cairn/protocol'
import { sameModel, type ModelChoice } from './model-labels.js'

export const RECENT_MODELS_KEY = 'cairn.recentModels'
export const RECENT_MODELS_MAX = 5

export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
}

function parseRef(raw: unknown): ModelRef | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const providerId = (raw as { providerId?: unknown }).providerId
  const modelId = (raw as { modelId?: unknown }).modelId
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined
  if (providerId === '' || modelId === '') return undefined
  return { providerId, modelId }
}

export function readRecentModels(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): ModelRef[] {
  try {
    const raw = storage?.getItem(RECENT_MODELS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const out: ModelRef[] = []
    for (const item of parsed) {
      const ref = parseRef(item)
      if (ref === undefined) continue
      if (out.some((existing) => sameModel(existing, ref))) continue
      out.push(ref)
      if (out.length >= RECENT_MODELS_MAX) break
    }
    return out
  } catch {
    return []
  }
}

export function writeRecentModels(refs: readonly ModelRef[]): void {
  try {
    globalThis.localStorage?.setItem(
      RECENT_MODELS_KEY,
      JSON.stringify(refs.slice(0, RECENT_MODELS_MAX)),
    )
  } catch {
    // 隐私模式或测试环境里 localStorage 不可用
  }
}

/** 把选用过的模型记到最近列表最前；同一模型只保留一条。 */
export function rememberRecentModel(ref: ModelRef): ModelRef[] {
  const next = [ref, ...readRecentModels().filter((item) => !sameModel(item, ref))].slice(
    0,
    RECENT_MODELS_MAX,
  )
  writeRecentModels(next)
  return next
}

/** 最近列表 ∩ 当前启用模型；顺序跟最近记录一致。空则返回空数组。 */
export function resolveRecentChoices(
  choices: readonly ModelChoice[],
  recent: readonly ModelRef[],
): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const ref of recent) {
    const match = choices.find((choice) => sameModel(choice.ref, ref))
    if (match !== undefined) out.push(match)
  }
  return out
}
