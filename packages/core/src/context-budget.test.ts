import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  prefixWithinTokens,
  TOOL_OUTPUT_MAX_TOKENS,
  TOOL_OUTPUT_MIN_TOKENS,
  toolOutputBudget,
  truncateMiddle,
} from './context-budget.js'

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['abcd', 1],
    ['abcde', 2],
    ['你好', 2],
    ['你好abcd', 3],
    ['テスト한국', 5],
    ['😀', 1],
  ])('%j ≈ %i tokens', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens)
  })
})

describe('toolOutputBudget', () => {
  it.each([
    // [上下文窗口, 最大输出, 上限]
    [128_000, 8_192, TOOL_OUTPUT_MAX_TOKENS],
    [32_000, 4_000, 7_000],
    [16_000, 4_000, 3_000],
    [8_192, 2_048, 1_536],
    // 最大输出与窗口相同时最多预留一半
    [8_000, 8_000, 1_000],
    [4_096, 1_024, 768],
    [2_048, 512, TOOL_OUTPUT_MIN_TOKENS],
  ])('window %i, output %i → %i', (contextWindow, maxOutputTokens, expected) => {
    expect(toolOutputBudget({ contextWindow, maxOutputTokens })).toBe(expected)
  })

  it('never exceeds the absolute limit or falls below the minimum', () => {
    expect(toolOutputBudget({ contextWindow: 2_000_000, maxOutputTokens: 1 })).toBe(
      TOOL_OUTPUT_MAX_TOKENS,
    )
    expect(toolOutputBudget({ contextWindow: 100, maxOutputTokens: 50 })).toBe(
      TOOL_OUTPUT_MIN_TOKENS,
    )
  })
})

describe('prefixWithinTokens', () => {
  it('counts by estimated tokens and keeps surrogate pairs whole', () => {
    expect(prefixWithinTokens('abcdefgh', 1)).toBe(4)
    expect(prefixWithinTokens('你好世界', 2)).toBe(2)
    expect(prefixWithinTokens('😀😀', 1)).toBe(2)
    expect(prefixWithinTokens('ab', 10)).toBe(2)
  })
})

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('abcd', 1)).toEqual({ text: 'abcd', omitted: 0 })
  })

  it('keeps the head and tail by tokens', () => {
    const text = 'a'.repeat(40) + 'b'.repeat(40)
    expect(truncateMiddle(text, 4)).toEqual({
      text: `${'a'.repeat(8)}\n[... 64 characters omitted ...]\n${'b'.repeat(8)}`,
      omitted: 64,
    })
  })

  it('counts CJK characters as one token each', () => {
    const text = '中'.repeat(10) + '文'.repeat(10)
    const result = truncateMiddle(text, 4, (n) => `[${n}]`)
    expect(result).toEqual({ text: '中中[16]文文', omitted: 16 })
  })

  it('does not split surrogate pairs at the tail', () => {
    const text = 'x'.repeat(40) + '😀😀😀'
    const result = truncateMiddle(text, 4, () => '|')
    expect(result.text).toBe(`${'x'.repeat(8)}|😀😀`)
  })
})
