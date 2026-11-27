import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  main,
  mergeReleases,
  platformDirectories,
  readPlatformNotes,
  renderCombinedReleaseNotes,
  signingSummaryLine,
} from './merge-release.mjs'
import { readJson } from './release-artifacts.mjs'

const dirs: string[] = []
const VERSION = '0.1.1'
const COMMIT = 'abcdef1234567890'

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-merge-release-'))
  dirs.push(directory)
  return directory
}

interface PlatformNotes {
  platform: string
  label: string
  version: string
  channel: string
  commit: string
  buildTime: string
  signing: Record<string, unknown>
  metadata: string
  support: string[]
  install: string[]
  knownIssues: string[]
  changelogSection: string
  downloads: { name: string; sha256: string; size: number }[]
}

interface PlatformFixture {
  readonly directory: string
  readonly notes: PlatformNotes
}

function platformFixture(
  platform: 'windows' | 'mac' | 'linux',
  overrides: Record<string, unknown> = {},
): PlatformFixture {
  const directory = temporaryDirectory()
  const label = platform === 'windows' ? 'Windows x64' : platform === 'mac' ? 'macOS' : 'Linux x64'
  const metadata =
    platform === 'windows' ? 'beta.yml' : platform === 'mac' ? 'beta-mac.yml' : 'beta-linux.yml'
  const artifact =
    platform === 'windows'
      ? `Cairn-${VERSION}-x64-setup.exe`
      : platform === 'mac'
        ? `Cairn-${VERSION}-arm64.dmg`
        : `Cairn-${VERSION}-x64.AppImage`
  const notes = {
    schemaVersion: 1,
    platform,
    label,
    version: VERSION,
    channel: 'beta',
    commit: COMMIT,
    buildTime: '2026-11-10T08:30:00.000Z',
    signing:
      platform === 'linux'
        ? { mode: 'none', integrity: 'sha256+https' }
        : platform === 'mac'
          ? { mode: 'adhoc', notarized: false }
          : { mode: 'none' },
    metadata,
    support: [`${label} support`],
    install: [`${label} install`],
    knownIssues: [`${label} issue`],
    changelogSection: '- change',
    downloads: [{ name: artifact, sha256: 'abc', size: 1 }],
    ...overrides,
  }
  writeFileSync(path.join(directory, 'platform-notes.json'), JSON.stringify(notes))
  writeFileSync(path.join(directory, artifact), `${platform}-artifact`)
  writeFileSync(path.join(directory, metadata), 'version: "0.1.1"\n')
  writeFileSync(path.join(directory, 'THIRD_PARTY_NOTICES.txt'), `${platform} notices\n`)
  writeFileSync(path.join(directory, 'dependencies.json'), JSON.stringify({ platform }))
  return { directory, notes }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('platform notes', () => {
  it('reads and validates platform notes', () => {
    const windows = platformFixture('windows')
    expect(readPlatformNotes(windows.directory)['platform']).toBe('windows')

    const missing = temporaryDirectory()
    expect(() => readPlatformNotes(missing)).toThrow(/missing/)

    const badSchema = temporaryDirectory()
    writeFileSync(
      path.join(badSchema, 'platform-notes.json'),
      JSON.stringify({ schemaVersion: 9, platform: 'windows' }),
    )
    expect(() => readPlatformNotes(badSchema)).toThrow(/schema/)

    const unknown = temporaryDirectory()
    writeFileSync(
      path.join(unknown, 'platform-notes.json'),
      JSON.stringify({ schemaVersion: 1, platform: 'solaris' }),
    )
    expect(() => readPlatformNotes(unknown)).toThrow(/unknown platform/)
  })

  it('finds platform directories below a root', () => {
    const root = temporaryDirectory()
    const windows = platformFixture('windows')
    const mac = platformFixture('mac')
    mkdirSync(path.join(root, 'windows'))
    mkdirSync(path.join(root, 'mac'))
    writeFileSync(
      path.join(root, 'windows/platform-notes.json'),
      readFileSync(path.join(windows.directory, 'platform-notes.json')),
    )
    writeFileSync(
      path.join(root, 'mac/platform-notes.json'),
      readFileSync(path.join(mac.directory, 'platform-notes.json')),
    )
    mkdirSync(path.join(root, 'empty'))
    writeFileSync(path.join(root, 'README.txt'), 'not a platform')
    expect(platformDirectories(root).map((directory) => path.basename(directory))).toEqual([
      'mac',
      'windows',
    ])
    expect(() => platformDirectories(path.join(root, 'missing'))).toThrow(/does not exist/)
  })
})

describe('combined release notes', () => {
  it('describes every platform, download and signing state', () => {
    const notes = renderCombinedReleaseNotes({
      version: VERSION,
      channel: 'beta',
      commit: COMMIT,
      platforms: [
        platformFixture('linux').notes,
        platformFixture('windows').notes,
        platformFixture('mac').notes,
      ],
    })
    expect(notes).toContain('支持平台：Windows x64、macOS、Linux x64')
    expect(notes).toContain('### Windows x64')
    expect(notes).toContain('### macOS')
    expect(notes).toContain('### Linux x64')
    expect(notes).toContain('未签名（SHA-256 校验和与 HTTPS 更新源）')
    expect(notes).toContain('`beta-mac.yml`')
    expect(notes).toContain('- change')
    expect(notes).toContain('THIRD_PARTY_NOTICES-<platform>.txt')
  })

  it('summarizes signing per platform', () => {
    expect(signingSummaryLine('linux', { mode: 'none' })).toMatch(/HTTPS/)
    expect(signingSummaryLine('mac', { mode: 'adhoc' })).toBe('ad-hoc 签名（未公证）')
    expect(signingSummaryLine('mac', { mode: 'developer-id' })).toBe('已签名（developer-id）并公证')
    expect(signingSummaryLine('windows', { mode: 'pfx' })).toBe('已签名（pfx）')
    expect(signingSummaryLine('windows', { mode: 'none' })).toBe('unsigned beta')
  })
})

describe('mergeReleases', () => {
  it('merges three platforms, dedupes shared files and checksums the result', () => {
    const windows = platformFixture('windows')
    const mac = platformFixture('mac')
    const linux = platformFixture('linux')
    mkdirSync(path.join(linux.directory, 'nested'))
    const out = path.join(temporaryDirectory(), 'merged')
    const result = mergeReleases({
      dirs: [windows.directory, mac.directory, linux.directory],
      outDir: out,
      env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '7' },
    })
    expect(result.platforms).toHaveLength(3)
    expect(result.files).toEqual(
      expect.arrayContaining([
        `Cairn-${VERSION}-x64-setup.exe`,
        `Cairn-${VERSION}-arm64.dmg`,
        `Cairn-${VERSION}-x64.AppImage`,
        'beta.yml',
        'beta-mac.yml',
        'beta-linux.yml',
        'THIRD_PARTY_NOTICES-windows.txt',
        'THIRD_PARTY_NOTICES-mac.txt',
        'THIRD_PARTY_NOTICES-linux.txt',
        'dependencies-windows.json',
        'dependencies-mac.json',
        'dependencies-linux.json',
        'release-notes.md',
        'provenance.json',
        'SHA256SUMS',
      ]),
    )
    const provenance = readJson(path.join(out, 'provenance.json'))
    expect(provenance['repository']).toBe('owner/repo')
    expect(provenance['runId']).toBe('7')
    expect(provenance['platforms']).toHaveLength(3)
    const checksums = readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n')
    expect(checksums).toHaveLength(result.files.length - 1)
    expect(readFileSync(path.join(out, 'release-notes.md'), 'utf8')).toContain('Cairn 0.1.1')
  })

  it('accepts identical shared artifacts and rejects conflicting ones', () => {
    const first = platformFixture('windows')
    const second = platformFixture('mac')
    writeFileSync(path.join(second.directory, 'shared.txt'), 'same')
    writeFileSync(path.join(first.directory, 'shared.txt'), 'same')
    const out = path.join(temporaryDirectory(), 'merged')
    expect(() =>
      mergeReleases({ dirs: [first.directory, second.directory], outDir: out }),
    ).not.toThrow()

    const third = platformFixture('linux')
    writeFileSync(path.join(third.directory, 'shared.txt'), 'different')
    expect(() =>
      mergeReleases({
        dirs: [first.directory, second.directory, third.directory],
        outDir: path.join(temporaryDirectory(), 'merged'),
      }),
    ).toThrow(/conflicting release artifact/)
  })

  it('fails closed on duplicate platforms and inconsistent release metadata', () => {
    const windows = platformFixture('windows')
    expect(() =>
      mergeReleases({
        dirs: [windows.directory, windows.directory],
        outDir: path.join(temporaryDirectory(), 'merged'),
      }),
    ).toThrow(/duplicate/)

    for (const field of ['version', 'channel', 'commit', 'changelogSection'] as const) {
      const drifted = platformFixture('mac', { [field]: 'drifted' })
      expect(() =>
        mergeReleases({
          dirs: [windows.directory, drifted.directory],
          outDir: path.join(temporaryDirectory(), 'merged'),
        }),
      ).toThrow(new RegExp(`mac release ${field} does not match`))
    }

    expect(() => mergeReleases({ dirs: [], outDir: 'unused' })).toThrow(/at least one/)
  })
})

describe('CLI', () => {
  it('merges from a root and reports usage errors', () => {
    const root = temporaryDirectory()
    const windows = platformFixture('windows')
    mkdirSync(path.join(root, 'windows'))
    for (const name of ['platform-notes.json', `Cairn-${VERSION}-x64-setup.exe`, 'beta.yml']) {
      writeFileSync(
        path.join(root, 'windows', name),
        readFileSync(path.join(windows.directory, name)),
      )
    }
    writeFileSync(
      path.join(root, 'windows/THIRD_PARTY_NOTICES.txt'),
      readFileSync(path.join(windows.directory, 'THIRD_PARTY_NOTICES.txt')),
    )
    writeFileSync(
      path.join(root, 'windows/dependencies.json'),
      readFileSync(path.join(windows.directory, 'dependencies.json')),
    )
    const log = vi.fn()
    expect(main({ argv: ['--root', root], log })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('merged 1 platforms'))

    const out = path.join(temporaryDirectory(), 'explicit')
    expect(
      main({
        argv: ['--dir', path.join(root, 'windows'), '--out', out],
        log: vi.fn(),
      }),
    ).toBe(0)

    const error = vi.fn()
    expect(main({ argv: [], error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage:'))
    expect(main({ argv: ['--root'], error })).toBe(1)
    expect(main({ argv: ['--root', path.join(root, 'missing')], error })).toBe(1)
  })

  it('uses console loggers by default', () => {
    const root = temporaryDirectory()
    const windows = platformFixture('windows')
    mkdirSync(path.join(root, 'windows'))
    for (const name of [
      'platform-notes.json',
      `Cairn-${VERSION}-x64-setup.exe`,
      'beta.yml',
      'THIRD_PARTY_NOTICES.txt',
      'dependencies.json',
    ]) {
      writeFileSync(
        path.join(root, 'windows', name),
        readFileSync(path.join(windows.directory, name)),
      )
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(main({ argv: ['--root', root] })).toBe(0)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('merged 1 platforms'))
      expect(main({ argv: [] })).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('usage:'))
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
})
