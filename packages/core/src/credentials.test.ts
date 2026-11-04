import { describe, expect, it } from 'vitest'
import { isCredentialRef } from './credentials.js'

describe('isCredentialRef', () => {
  it('接受字母、数字、点、下划线、连字符，1～128 个字符', () => {
    for (const ref of ['deepseek', 'provider.openai-2', 'A_b', 'x'.repeat(128)]) {
      expect(isCredentialRef(ref), ref).toBe(true)
    }
    for (const ref of ['', 'a b', 'a/b', '..\\x', '密钥', 'x'.repeat(129)]) {
      expect(isCredentialRef(ref), ref).toBe(false)
    }
  })
})
