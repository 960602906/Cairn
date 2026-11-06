import { describe, expect, it } from 'vitest'
import { summarizeTests } from './test-summary.js'

describe('summarizeTests', () => {
  it.each([
    [
      'vitest',
      ' Test Files  2 passed (2)\n      Tests  12 passed | 1 failed | 2 skipped (15)\n   Start at  08:39:13',
      { passed: 12, failed: 1, skipped: 2 },
    ],
    [
      'jest',
      'Test Suites: 1 failed, 1 total\nTests:       1 failed, 2 skipped, 12 passed, 15 total\nTime: 1s',
      { passed: 12, failed: 1, skipped: 2 },
    ],
    [
      'pytest',
      '..F.s\n==== 3 passed, 1 failed, 1 skipped, 1 error in 0.12s ====',
      { passed: 3, failed: 2, skipped: 1 },
    ],
    [
      'pytest（带耗时说明）',
      '======= 5 passed, 1 xfailed in 1.20s (0:00:01) =======',
      { passed: 5, failed: 0, skipped: 1 },
    ],
    [
      'cargo',
      'test result: FAILED. 12 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out',
      { passed: 12, failed: 1, skipped: 2 },
    ],
  ])('%s', (_name, text, expected) => {
    expect(summarizeTests(text)).toEqual(expected)
  })

  it('有多处汇总时取最后一处', () => {
    const text =
      'test result: ok. 1 passed; 0 failed; 0 ignored\n...\ntest result: ok. 4 passed; 0 failed; 1 ignored'
    expect(summarizeTests(text)).toEqual({ passed: 4, failed: 0, skipped: 1 })
  })

  it('识别不了时返回 undefined', () => {
    expect(summarizeTests('hello')).toBeUndefined()
    expect(summarizeTests('Tests:  none found')).toBeUndefined()
  })
})
