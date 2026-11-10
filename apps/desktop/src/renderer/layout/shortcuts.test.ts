import { describe, expect, it } from 'vitest'
import {
  isMacPlatform,
  isNewChatKey,
  isPlanModeKey,
  isSearchKey,
  isSettingsKey,
  newChatShortcut,
  planShortcut,
  searchShortcut,
  settingsShortcut,
} from './shortcuts.js'

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
  it('opens the settings with ⌘, or Ctrl+, (M2-09)', () => {
    expect(settingsShortcut('MacIntel')).toBe('⌘,')
    expect(settingsShortcut('Win32')).toBe('Ctrl ,')
    expect(isSettingsKey(key({ key: ',', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isSettingsKey(key({ key: ',', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isSettingsKey(key({ key: ',', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(false)
    expect(isSettingsKey(key({ key: '.', ctrlKey: true }), 'Win32')).toBe(false)
  })
  it('searches the sessions with ⌘K or Ctrl+K (M2-12)', () => {
    expect(searchShortcut('MacIntel')).toBe('⌘K')
    expect(searchShortcut('Win32')).toBe('Ctrl K')
    expect(isSearchKey(key({ key: 'k', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isSearchKey(key({ key: 'K', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isSearchKey(key({ key: 'k', ctrlKey: true, altKey: true }), 'Win32')).toBe(false)
    expect(isSearchKey(key({ key: 'k' }), 'Win32')).toBe(false)
  })

  it('toggles plan mode with ⌘⇧P or Ctrl+Shift+P', () => {
    expect(planShortcut('MacIntel')).toBe('⌘⇧P')
    expect(planShortcut('Win32')).toBe('Ctrl Shift P')
    expect(isPlanModeKey(key({ key: 'P', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(true)
    expect(isPlanModeKey(key({ key: 'p', metaKey: true, shiftKey: true }), 'MacIntel')).toBe(true)
    expect(isPlanModeKey(key({ key: 'p', ctrlKey: true }), 'Win32')).toBe(false)
    expect(
      isPlanModeKey(key({ key: 'p', ctrlKey: true, shiftKey: true, altKey: true }), 'Win32'),
    ).toBe(false)
    expect(isPlanModeKey(key({ key: 'p', metaKey: true, shiftKey: true }), 'Win32')).toBe(false)
  })
})
