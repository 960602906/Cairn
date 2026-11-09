import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILD_INFO_SCHEMA_VERSION,
  collectBuildInfo,
  main,
  readElectronVersion,
  readGitCommit,
  resolveChannel,
  writeBuildInfo,
} from './build-info.mjs'

const dirs: string[] = []

function workspace(version = '0.1.0', appVersion = version) {
  const root = mkdtempSync(path.join(tmpdir(), 'cairn-build-info-'))
  dirs.push(root)
  mkdirSync(path.join(root, 'apps/desktop'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cairn', version }))
  writeFileSync(
    path.join(root, 'apps/desktop/package.json'),
    JSON.stringify({ name: '@cairn/desktop', version: appVersion }),
  )
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('build channel and commit resolution', () => {
  it('prefers an explicit channel and defaults by major version', () => {
    expect(resolveChannel('stable', '0.1.0')).toBe('stable')
    expect(resolveChannel('beta', '1.2.3')).toBe('beta')
    expect(resolveChannel('canary', '0.1.0')).toBe('beta')
    expect(resolveChannel(undefined, '1.0.0')).toBe('stable')
    expect(resolveChannel(undefined, '0.9.0')).toBe('beta')
  })

  it('uses a CI commit and rejects malformed values', () => {
    expect(readGitCommit(process.cwd(), { GITHUB_SHA: 'ABCDEF1234567890' })).toBe(
      'ABCDEF1234567890',
    )
    const root = workspace()
    expect(readGitCommit(root, { GITHUB_SHA: 'not-a-sha' })).toBe('unknown')
  })

  it('falls back to unknown outside a git checkout', () => {
    const root = workspace()
    const previous = process.env['GITHUB_SHA']
    delete process.env['GITHUB_SHA']
    try {
      expect(readGitCommit(root, {})).toBe('unknown')
    } finally {
      if (previous !== undefined) process.env['GITHUB_SHA'] = previous
    }
  })

  it('returns an empty Electron version when it cannot be resolved', () => {
    expect(readElectronVersion(workspace())).toBe('')
  })
})

describe('build info collection', () => {
  it('normalizes commit, versions and build time', () => {
    const info = collectBuildInfo({
      root: workspace('0.1.0'),
      commit: 'ABCDEF1234567890',
      now: new Date('2026-11-10T08:30:00.000Z'),
      electronVersion: ' 45.2.1 ',
      nodeVersion: 'v24.11.0',
    })
    expect(info).toEqual({
      schemaVersion: BUILD_INFO_SCHEMA_VERSION,
      version: '0.1.0',
      channel: 'beta',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-10T08:30:00.000Z',
      electronVersion: '45.2.1',
      nodeVersion: '24.11.0',
    })
  })

  it('marks an unusable commit as unknown', () => {
    const info = collectBuildInfo({
      root: workspace('1.0.0'),
      channel: 'stable',
      commit: 'C:\\Users\\alice',
      now: new Date('2026-11-10T00:00:00.000Z'),
      electronVersion: '',
      nodeVersion: 'v24.11.0',
    })
    expect(info.commit).toBe('unknown')
    expect(info.channel).toBe('stable')
  })
})

describe('build info output', () => {
  it('writes only build metadata to out/build-info.json', () => {
    const root = workspace()
    const outDir = path.join(root, 'apps/desktop/out')
    const info = writeBuildInfo({
      root,
      outDir,
      env: { GITHUB_SHA: 'abcdef1234567890', CAIRN_CHANNEL: 'stable' },
      now: new Date('2026-11-10T08:30:00.000Z'),
    })
    const text = readFileSync(path.join(outDir, 'build-info.json'), 'utf8')
    const written = JSON.parse(text) as Record<string, unknown>
    expect(written).toEqual({ ...info, electronVersion: '' })
    expect(text).not.toContain(root)
    expect(text).not.toContain('Users')
    expect(written['channel']).toBe('stable')
  })

  it('refuses to build when the desktop version is out of sync', () => {
    const root = workspace('0.1.0', '0.0.0')
    expect(() => writeBuildInfo({ root, env: {} })).toThrow(/version mismatch/)
  })

  it('writes through the CLI entry and prints the version', () => {
    const root = workspace()
    const logs: string[] = []
    expect(
      main({
        root,
        env: { GITHUB_SHA: 'abcdef1234567890' },
        now: new Date('2026-11-10T00:00:00.000Z'),
        log: (line) => logs.push(line),
      }),
    ).toBe(0)
    expect(logs.join('\n')).toMatch(/build-info: 0\.1\.0 beta abcdef1/)
    expect(
      JSON.parse(readFileSync(path.join(root, 'apps/desktop/out/build-info.json'), 'utf8')),
    ).toMatchObject({ version: '0.1.0', channel: 'beta' })
  })
})
