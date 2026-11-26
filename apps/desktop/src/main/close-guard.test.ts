import { describe, expect, it } from 'vitest'
import { shouldConfirmClose } from './close-guard.js'

describe('shouldConfirmClose', () => {
  it('asks on Windows and Linux while a chat is still running', () => {
    expect(shouldConfirmClose('win32', 1)).toBe(true)
    expect(shouldConfirmClose('linux', 3)).toBe(true)
  })

  it('does not ask without running chats or on macOS', () => {
    expect(shouldConfirmClose('win32', 0)).toBe(false)
    expect(shouldConfirmClose('linux', 0)).toBe(false)
    expect(shouldConfirmClose('darwin', 2)).toBe(false)
  })
})
