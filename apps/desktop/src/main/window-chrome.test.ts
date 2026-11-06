import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  titleBarOverlay,
  usesTitleBarOverlay,
  windowChromeOptions,
} from './window-chrome.js'

describe('window chrome', () => {
  it('uses inset traffic lights on macOS', () => {
    const options = windowChromeOptions('darwin', false)
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 13 })
    expect(options.backgroundColor).toBe('#eeeff2')
    expect(usesTitleBarOverlay('darwin')).toBe(false)
  })

  it('overlays themed window controls elsewhere', () => {
    const options = windowChromeOptions('win32', true)
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toEqual({
      color: '#141416',
      symbolColor: '#bfc0c6',
      height: TITLE_BAR_HEIGHT,
    })
    expect(options.backgroundColor).toBe('#141416')
    expect(titleBarOverlay(false)).toMatchObject({ color: '#eeeff2', symbolColor: '#45474f' })
    expect(usesTitleBarOverlay('linux')).toBe(true)
  })
})
