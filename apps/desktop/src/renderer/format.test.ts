import { describe, expect, it } from 'vitest'
import { formatCompactTokens } from './format.js'

describe('formatCompactTokens', () => {
  it('keeps values below one thousand unchanged', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(999)).toBe('999')
  })

  it('uses one decimal place below one hundred thousand', () => {
    expect(formatCompactTokens(1_000)).toBe('1.0K')
    expect(formatCompactTokens(12_345)).toBe('12.3K')
  })

  it('rounds larger values to whole thousands', () => {
    expect(formatCompactTokens(100_000)).toBe('100K')
    expect(formatCompactTokens(999_500)).toBe('1000K')
  })
})
