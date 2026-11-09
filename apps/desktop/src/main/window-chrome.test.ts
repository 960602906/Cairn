import { describe, expect, it } from 'vitest'
import {
  resolveChromeTheme,
  usesCustomWindowControls,
  windowChromeOptions,
} from './window-chrome.js'

describe('window chrome', () => {
  it('uses inset traffic lights on macOS', () => {
    const options = windowChromeOptions('darwin', 'paper')
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 13 })
    expect(options.backgroundColor).toBe('#e6dccb')
    expect(usesCustomWindowControls('darwin')).toBe(false)
  })

  it('leaves window controls to the renderer elsewhere', () => {
    const options = windowChromeOptions('win32', 'obsidian')
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.backgroundColor).toBe('#08090a')
    expect(windowChromeOptions('linux', 'paper').backgroundColor).toBe('#e6dccb')
    expect(usesCustomWindowControls('win32')).toBe(true)
    expect(usesCustomWindowControls('linux')).toBe(true)
  })

  it('resolves the stored theme, including system and legacy values', () => {
    expect(resolveChromeTheme('bluestone', true)).toBe('bluestone')
    expect(resolveChromeTheme('system', true)).toBe('slate')
    expect(resolveChromeTheme('system', false)).toBe('paper')
    expect(resolveChromeTheme('light', true)).toBe('tundra')
    expect(resolveChromeTheme('dark', false)).toBe('obsidian')
    expect(resolveChromeTheme('graphite', false)).toBe('obsidian')
    expect(resolveChromeTheme(undefined, true)).toBe('slate')
    expect(resolveChromeTheme(undefined, false)).toBe('paper')
  })
})
