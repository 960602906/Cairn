import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const afterPack = require('./after-pack.cjs') as ((context: {
  appOutDir: string
}) => Promise<void>) & {
  appUpdateConfig(rawUrl?: string): string
  DEFAULT_UPDATE_URL: string
}

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-after-pack-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('appUpdateConfig', () => {
  it('normalizes the update URL and keeps the generic provider', () => {
    expect(afterPack.appUpdateConfig('https://updates.example/cairn///')).toBe(
      [
        'provider: generic',
        'url: https://updates.example/cairn/',
        'updaterCacheDirName: cairn-updater',
        '',
      ].join('\n'),
    )
  })

  it('falls back to the packaged placeholder source when the URL is empty', () => {
    expect(afterPack.appUpdateConfig('   ')).toContain(`url: ${afterPack.DEFAULT_UPDATE_URL}`)
  })
})

describe('afterPack', () => {
  it('writes app-update.yml into the packaged resources', async () => {
    vi.stubEnv('CAIRN_UPDATE_URL', 'https://updates.example/beta')
    const appOutDir = temporaryDirectory()
    await afterPack({ appOutDir })
    expect(readFileSync(path.join(appOutDir, 'resources/app-update.yml'), 'utf8')).toBe(
      afterPack.appUpdateConfig('https://updates.example/beta'),
    )
  })

  it('uses the default source when the build has no update URL', async () => {
    vi.stubEnv('CAIRN_UPDATE_URL', '')
    const appOutDir = temporaryDirectory()
    await afterPack({ appOutDir })
    expect(readFileSync(path.join(appOutDir, 'resources/app-update.yml'), 'utf8')).toContain(
      afterPack.DEFAULT_UPDATE_URL,
    )
  })
})
