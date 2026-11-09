import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, appUserModelId } from './app-identity.js'

describe('app identity', () => {
  it('keeps the packaging identity stable', () => {
    expect(APP_IDENTITY).toEqual({
      appId: 'com.cairn.desktop',
      productName: 'Cairn',
      copyright: 'Copyright © 2026 Cairn contributors',
    })
  })

  it('separates installed and development AppUserModelIDs', () => {
    expect(appUserModelId(true)).toBe('com.cairn.desktop')
    expect(appUserModelId(false)).toBe('com.cairn.desktop.dev')
  })
})
