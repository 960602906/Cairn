import { describe, expect, it } from 'vitest'
import {
  agentPickerShortcut,
  isAgentPickerKey,
  isMacPlatform,
  isNewChatKey,
  isSearchKey,
  isSettingsKey,
  newChatShortcut,
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

describe('agentPickerShortcut', () => {
  it('returns ⌘. on mac and Ctrl . on windows/other', () => {
    expect(agentPickerShortcut('MacIntel')).toBe('⌘.')
    expect(agentPickerShortcut('Win32')).toBe('Ctrl .')
    expect(agentPickerShortcut('Linux')).toBe('Ctrl .')
  })
})

describe('isAgentPickerKey', () => {
  it('detects ⌘. on Mac and Ctrl+. on Windows', () => {
    expect(
      isAgentPickerKey(
        { key: '.', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
        'MacIntel',
      ),
    ).toBe(true)
    expect(
      isAgentPickerKey(
        { key: '.', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        'Win32',
      ),
    ).toBe(true)
    expect(
      isAgentPickerKey(
        { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        'Win32',
      ),
    ).toBe(false)
    expect(
      isAgentPickerKey(
        { key: '.', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
        'Win32',
      ),
    ).toBe(false)
  })
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
})
