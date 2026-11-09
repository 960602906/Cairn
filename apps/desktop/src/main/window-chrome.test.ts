import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  resolveChromeTheme,
  titleBarOverlay,
  usesTitleBarOverlay,
  windowChromeOptions,
} from './window-chrome.js'

describe('window chrome', () => {
  it('uses inset traffic lights on macOS', () => {
    const options = windowChromeOptions('darwin', 'paper')
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 13 })
    expect(options.backgroundColor).toBe('#e6dccb')
    expect(usesTitleBarOverlay('darwin')).toBe(false)
  })

  it('overlays themed window controls elsewhere', () => {
    const options = windowChromeOptions('win32', 'obsidian')
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toEqual({
      color: '#0e0f11',
      symbolColor: '#c2bfb8',
      height: TITLE_BAR_HEIGHT,
    })
    expect(options.backgroundColor).toBe('#08090a')
    expect(titleBarOverlay('paper')).toMatchObject({
      color: '#fbf7ee',
      symbolColor: '#3c362a',
    })
    expect(usesTitleBarOverlay('linux')).toBe(true)
  })

  it('skips the overlay under headless Chromium (smoke test)', () => {
    const options = windowChromeOptions('linux', 'paper', true)
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(usesTitleBarOverlay('linux', true)).toBe(false)
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
