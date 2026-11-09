import { describe, expect, it } from 'vitest'
import type { AppInfo } from '@cairn/protocol'
import { createAppInfoCommands } from './app-info-service.js'

const info: AppInfo = {
  schemaVersion: 1,
  version: '0.1.0',
  channel: 'beta',
  commit: 'abcdef1234567890',
  buildTime: '2026-11-10T00:00:00.000Z',
  electronVersion: '45.2.1',
  nodeVersion: '24.11.0',
  name: 'Cairn',
  appId: 'com.cairn.desktop',
  copyright: 'Copyright © 2026 Cairn contributors',
  packaged: false,
  databaseSchemaVersion: 17,
}

describe('app info commands', () => {
  it('returns the value supplied by startup', () => {
    const commands = createAppInfoCommands(() => info)
    expect(commands.info()).toBe(info)
  })

  it('returns the bundled license notices', () => {
    const licenses = { available: true, text: 'MIT', truncated: false }
    const commands = createAppInfoCommands(
      () => info,
      () => licenses,
    )
    expect(commands.licenses()).toBe(licenses)
  })

  it('reports missing notices by default', () => {
    const commands = createAppInfoCommands(() => info)
    expect(commands.licenses()).toEqual({ available: false, text: '', truncated: false })
  })
})
