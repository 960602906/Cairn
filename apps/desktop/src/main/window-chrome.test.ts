import { describe, expect, it } from 'vitest'
import {
  resolveChromeTheme,
  usesCustomWindowControls,
  windowChromeOptions,
} from './window-chrome.js'

describe('window chrome', () => {
  it('uses inset traffic lights on macOS', () => {
    const options = windowChromeOptions('darwin', 'light')
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 13 })
    expect(options.backgroundColor).toBe('#f5f5f6')
    expect(usesCustomWindowControls('darwin')).toBe(false)
  })

  it('leaves window controls to the renderer elsewhere', () => {
    const options = windowChromeOptions('win32', 'dark')
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.backgroundColor).toBe('#0a0c10')
    expect(windowChromeOptions('linux', 'light').backgroundColor).toBe('#f5f5f6')
    expect(usesCustomWindowControls('win32')).toBe(true)
    expect(usesCustomWindowControls('linux')).toBe(true)
  })

  it('resolves the stored theme, including system and legacy values', () => {
    expect(resolveChromeTheme('system', true)).toBe('dark')
    expect(resolveChromeTheme('system', false)).toBe('light')
    expect(resolveChromeTheme('light', true)).toBe('light')
    expect(resolveChromeTheme('dark', false)).toBe('dark')
    expect(resolveChromeTheme(undefined, true)).toBe('dark')
    expect(resolveChromeTheme(undefined, false)).toBe('light')
    // 旧版本的配色名按明暗归并
    for (const legacy of ['bluestone', 'obsidian', 'slate', 'graphite'] as const) {
      expect(resolveChromeTheme(legacy, false)).toBe('dark')
    }
    for (const legacy of ['paper', 'tundra'] as const) {
      expect(resolveChromeTheme(legacy, true)).toBe('light')
    }
  })
})
