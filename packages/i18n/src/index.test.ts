import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES } from './index.js'

describe('SUPPORTED_LOCALES', () => {
  it('支持中文与英文（ADR-0013）', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US'])
  })
})
