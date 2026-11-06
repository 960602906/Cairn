import { describe, expect, it } from 'vitest'
import { billedTokens, estimateCost } from './usage.js'

describe('用量与费用', () => {
  it('计费 token 为输入加输出', () => {
    expect(billedTokens({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 })).toBe(150)
  })

  it('按每百万 token 的单价估算，缓存命中有单独价格时分开计', () => {
    const pricing = { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 }
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, pricing)).toBe(6)
    expect(
      estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 }, pricing),
    ).toBeCloseTo(1.4)
    // 没有缓存价格时按普通输入计；缓存数大于输入时以输入为限
    expect(
      estimateCost(
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 2_000_000 },
        { inputPerMillion: 2, outputPerMillion: 8 },
      ),
    ).toBe(2)
  })
})
