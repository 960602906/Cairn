import { describe, expect, it } from 'vitest'
import { isMacPlatform, isNewChatKey, newChatShortcut } from './shortcuts.js'

const key = (init: Partial<KeyboardEvent>) => ({
  key: 'n',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...init,
})

describe('shortcuts', () => {
  it('uses ⌘ on macOS and Ctrl elsewhere', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Win32')).toBe(false)
    expect(newChatShortcut('MacIntel')).toBe('⌘N')
    expect(newChatShortcut('Linux x86_64')).toBe('Ctrl N')
    expect(isNewChatKey(key({ metaKey: true }), 'MacIntel')).toBe(true)
    expect(isNewChatKey(key({ ctrlKey: true }), 'MacIntel')).toBe(false)
    expect(isNewChatKey(key({ ctrlKey: true, key: 'N' }), 'Win32')).toBe(true)
    expect(isNewChatKey(key({ ctrlKey: true, shiftKey: true }), 'Win32')).toBe(false)
    expect(isNewChatKey(key({ ctrlKey: true, altKey: true }), 'Win32')).toBe(false)
    expect(isNewChatKey(key({ ctrlKey: true, key: 'm' }), 'Win32')).toBe(false)
  })
})
