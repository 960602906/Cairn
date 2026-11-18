import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
interface PackContext {
  appOutDir: string
  packager?: { platform?: { name?: string }; appInfo?: { productFilename?: string } }
}

const afterPack = require('./after-pack.cjs') as ((context: PackContext) => Promise<void>) & {
  appUpdateConfig(rawUrl?: string): string
  resourcesDirectory(context: PackContext): string
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

  it('writes the GitHub provider for a repository source', () => {
    expect(afterPack.appUpdateConfig('https://github.com/960602906/Cairn/')).toBe(
      [
        'provider: github',
        'owner: 960602906',
        'repo: Cairn',
        'updaterCacheDirName: cairn-updater',
        '',
      ].join('\n'),
    )
  })
})

describe('afterPack', () => {
  // 发布流水线给所有 job 注入 CAIRN_UPDATE_URL；这里显式清空，避免测试依赖外部环境。
  beforeEach(() => {
    vi.stubEnv('CAIRN_UPDATE_URL', '')
  })

  it('writes app-update.yml into the packaged resources', async () => {
    vi.stubEnv('CAIRN_UPDATE_URL', 'https://updates.example/beta')
    const appOutDir = temporaryDirectory()
    await afterPack({ appOutDir })
    expect(readFileSync(path.join(appOutDir, 'resources/app-update.yml'), 'utf8')).toBe(
      afterPack.appUpdateConfig('https://updates.example/beta'),
    )
  })

  it('writes app-update.yml into the macOS app bundle resources', async () => {
    const appOutDir = temporaryDirectory()
    const context = {
      appOutDir,
      packager: { platform: { name: 'mac' }, appInfo: { productFilename: 'Cairn' } },
    }
    await afterPack(context)
    expect(afterPack.resourcesDirectory(context)).toBe(
      path.join(appOutDir, 'Cairn.app/Contents/Resources'),
    )
    expect(
      readFileSync(path.join(appOutDir, 'Cairn.app/Contents/Resources/app-update.yml'), 'utf8'),
    ).toContain(afterPack.DEFAULT_UPDATE_URL)
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
