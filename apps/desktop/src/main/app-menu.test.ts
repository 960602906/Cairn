import { describe, expect, it } from 'vitest'
import { macApplicationMenu, shouldInstallApplicationMenu } from './app-menu.js'

describe('macApplicationMenu', () => {
  it('provides the standard application, edit and window roles', () => {
    expect(macApplicationMenu()).toEqual([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ])
  })
})

describe('shouldInstallApplicationMenu', () => {
  it('installs a menu bar on macOS only', () => {
    expect(shouldInstallApplicationMenu('darwin')).toBe(true)
    expect(shouldInstallApplicationMenu('win32')).toBe(false)
    expect(shouldInstallApplicationMenu('linux')).toBe(false)
  })
})
