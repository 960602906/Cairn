import { describe, expect, it } from 'vitest'
import { redactSecrets } from './index.js'

describe('redactSecrets', () => {
  it('替换所有出现的长值', () => {
    expect(redactSecrets('a token-value b token-value', ['token-value'])).toBe(
      'a [redacted] b [redacted]',
    )
  })

  it('过短的值不替换，避免误伤普通文本', () => {
    expect(redactSecrets('abc abc', ['ab'])).toBe('abc abc')
  })

  it('没有凭据时原样返回', () => {
    expect(redactSecrets('plain', [])).toBe('plain')
  })
})
