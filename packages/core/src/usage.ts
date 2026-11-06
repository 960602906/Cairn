/**
 * 用量与费用（M1-14b，Runtime §15）。不依赖 DOM 与 Node 类型。
 */
import type { ModelPricing, TokenUsage } from '@cairn/protocol'

/** 一次调用计费的 token：输入（含缓存命中）加输出。 */
export function billedTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens
}

/**
 * 按单价估算一次调用的费用。`inputTokens` 含缓存命中的部分（`cacheReadTokens`），缓存命中没有单独
 * 价格时按普通输入计。
 */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing): number {
  const cached = Math.min(usage.cacheReadTokens ?? 0, usage.inputTokens)
  const cachedPrice = pricing.cacheReadPerMillion ?? pricing.inputPerMillion
  return (
    ((usage.inputTokens - cached) * pricing.inputPerMillion +
      cached * cachedPrice +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000
  )
}
