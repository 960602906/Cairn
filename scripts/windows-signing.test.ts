import { describe, expect, it } from 'vitest'
import { main } from './windows-signing.mjs'

describe('sign:verify CLI', () => {
  it('exposes the verification entry point', () => {
    expect(typeof main).toBe('function')
  })
})
