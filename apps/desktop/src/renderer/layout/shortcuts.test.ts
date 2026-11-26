import { describe, expect, it } from 'vitest'
import {
  adjacentSessionId,
  agentPickerShortcut,
  focusComposerShortcut,
  isAgentPickerKey,
  isFocusComposerKey,
  isMacPlatform,
  isNewChatKey,
  isNextSessionKey,
  isPlanModeKey,
  isPreviousSessionKey,
  isSearchKey,
  isSettingsKey,
  isToggleSidebarKey,
  isToggleWorkbenchKey,
  newChatShortcut,
  planShortcut,
  searchShortcut,
  sessionCycleShortcut,
  settingsShortcut,
  toggleSidebarShortcut,
  toggleWorkbenchShortcut,
  zoomShortcut,
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
  it('opens the agent picker with ⌘. or Ctrl+. (M6-08)', () => {
    expect(agentPickerShortcut('MacIntel')).toBe('⌘.')
    expect(agentPickerShortcut('Win32')).toBe('Ctrl .')
    expect(isAgentPickerKey(key({ key: '.', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isAgentPickerKey(key({ key: '.', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isAgentPickerKey(key({ key: '.', ctrlKey: true }), 'MacIntel')).toBe(false)
    expect(isAgentPickerKey(key({ key: '.', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(false)
    expect(isAgentPickerKey(key({ key: ',', ctrlKey: true }), 'Win32')).toBe(false)
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

  it('focuses the composer (⌘L), toggles the sidebar (⌘B) and workbench (⌘J)', () => {
    expect(focusComposerShortcut('MacIntel')).toBe('⌘L')
    expect(focusComposerShortcut('Win32')).toBe('Ctrl L')
    expect(isFocusComposerKey(key({ key: 'l', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isFocusComposerKey(key({ key: 'L', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isFocusComposerKey(key({ key: 'l', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(
      false,
    )

    expect(toggleSidebarShortcut('MacIntel')).toBe('⌘B')
    expect(toggleSidebarShortcut('Win32')).toBe('Ctrl B')
    expect(isToggleSidebarKey(key({ key: 'b', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isToggleSidebarKey(key({ key: 'b', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isToggleSidebarKey(key({ key: 'b', ctrlKey: true, altKey: true }), 'Win32')).toBe(false)

    expect(toggleWorkbenchShortcut('MacIntel')).toBe('⌘J')
    expect(toggleWorkbenchShortcut('Win32')).toBe('Ctrl J')
    expect(isToggleWorkbenchKey(key({ key: 'j', metaKey: true }), 'MacIntel')).toBe(true)
    expect(isToggleWorkbenchKey(key({ key: 'j', ctrlKey: true }), 'Win32')).toBe(true)
    expect(isToggleWorkbenchKey(key({ key: 'j', ctrlKey: true, altKey: true }), 'Win32')).toBe(
      false,
    )
  })

  it('switches sessions with ⌘⇧[ / ⌘⇧] and wraps around', () => {
    expect(sessionCycleShortcut('MacIntel')).toBe('⌘⇧[ / ⌘⇧]')
    expect(sessionCycleShortcut('Win32')).toBe('Ctrl Shift [ / ]')
    // 带 Shift 时多数布局给出花括号，同样要认
    expect(isPreviousSessionKey(key({ key: '{', metaKey: true, shiftKey: true }), 'MacIntel')).toBe(
      true,
    )
    expect(isPreviousSessionKey(key({ key: '[', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(
      true,
    )
    expect(isNextSessionKey(key({ key: '}', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(true)
    expect(isNextSessionKey(key({ key: ']', metaKey: true, shiftKey: true }), 'MacIntel')).toBe(
      true,
    )
    expect(isNextSessionKey(key({ key: ']', metaKey: true }), 'MacIntel')).toBe(false)
    expect(isPreviousSessionKey(key({ key: '[', ctrlKey: true }), 'Win32')).toBe(false)

    const sessions = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]
    expect(adjacentSessionId(sessions, 'b', 1)).toBe('c')
    expect(adjacentSessionId(sessions, 'c', 1)).toBe('a')
    expect(adjacentSessionId(sessions, 'a', -1)).toBe('c')
    expect(adjacentSessionId(sessions, undefined, -1)).toBe('a')
    expect(adjacentSessionId(sessions, 'gone', 1)).toBe('a')
    expect(adjacentSessionId([], 'a', 1)).toBeUndefined()
  })

  it('shows the zoom shortcuts for help', () => {
    expect(zoomShortcut('MacIntel')).toBe('⌘+ / ⌘- / ⌘0')
    expect(zoomShortcut('Win32')).toBe('Ctrl + / - / 0')
  })
})
