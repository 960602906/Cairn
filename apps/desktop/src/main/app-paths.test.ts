import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredDirectories, resolveAppPaths } from './app-paths.js'

const appData = join('base', 'AppData', 'Roaming')

describe('resolveAppPaths', () => {
  it('uses <appData>/NEXUS-OS in production', () => {
    const root = join(appData, 'NEXUS-OS')
    expect(resolveAppPaths({ appData, dev: false })).toEqual({
      root,
      data: join(root, 'data'),
      database: join(root, 'data', 'nexus.db'),
      blobs: join(root, 'data', 'blobs'),
      checkpoints: join(root, 'checkpoints'),
      settings: join(root, 'settings.json'),
      logs: join(root, 'logs'),
      session: join(root, 'session'),
    })
  })

  it('uses a separate directory in development', () => {
    const paths = resolveAppPaths({ appData, dev: true })
    expect(paths.root).toBe(join(appData, 'NEXUS-OS-dev'))
    expect(paths.database).toBe(join(appData, 'NEXUS-OS-dev', 'data', 'nexus.db'))
  })

  it('honours NEXUS_USER_DATA_DIR and ignores a blank value', () => {
    const custom = resolveAppPaths({ appData, dev: true, env: { NEXUS_USER_DATA_DIR: ' tmp/x ' } })
    expect(custom.root).toBe(resolve('tmp/x'))
    expect(custom.logs).toBe(join(resolve('tmp/x'), 'logs'))

    const blank = resolveAppPaths({ appData, dev: false, env: { NEXUS_USER_DATA_DIR: '  ' } })
    expect(blank.root).toBe(join(appData, 'NEXUS-OS'))
  })
})

describe('requiredDirectories', () => {
  it('lists directories only, not files', () => {
    const paths = resolveAppPaths({ appData, dev: false })
    expect(requiredDirectories(paths)).toEqual([
      paths.root,
      paths.data,
      paths.blobs,
      paths.checkpoints,
      paths.logs,
    ])
  })
})
