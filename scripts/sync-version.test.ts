import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkVersions, main, readVersion, syncVersions } from './sync-version.mjs'

const dirs: string[] = []

function fixture(rootVersion: unknown, appVersion: unknown, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-version-'))
  dirs.push(dir)
  const root = path.join(dir, 'package.json')
  const app = path.join(dir, 'apps/desktop/package.json')
  writeFileSync(root, JSON.stringify({ name: 'cairn', version: rootVersion }, null, 2))
  const appDir = path.dirname(app)
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    app,
    JSON.stringify({ name: '@cairn/desktop', version: appVersion, ...extra }, null, 2),
  )
  return { dir, root, app }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('version synchronization', () => {
  it('accepts matching versions', () => {
    const { root, app } = fixture('0.1.0', '0.1.0')
    expect(checkVersions(root, app)).toEqual({
      rootVersion: '0.1.0',
      appVersion: '0.1.0',
      ok: true,
    })
  })

  it('reports a mismatch', () => {
    const { root, app } = fixture('0.1.0', '0.0.0')
    expect(checkVersions(root, app)).toMatchObject({ ok: false, appVersion: '0.0.0' })
  })

  it('syncs the desktop version and preserves other fields', () => {
    const { root, app } = fixture('0.2.0', '0.1.0', { productName: 'Cairn' })
    expect(syncVersions(root, app)).toEqual({ version: '0.2.0', changed: true })
    const written = JSON.parse(readFileSync(app, 'utf8')) as Record<string, unknown>
    expect(written).toMatchObject({ version: '0.2.0', productName: 'Cairn' })
    expect(written['name']).toBe('@cairn/desktop')
    expect(syncVersions(root, app)).toEqual({ version: '0.2.0', changed: false })
  })

  it('rejects invalid, missing and non-object manifests', () => {
    const invalid = fixture('not-a-version', '0.1.0')
    expect(() => readVersion(invalid.root)).toThrow(/no valid version/)
    expect(() => readVersion(path.join(invalid.dir, 'missing.json'))).toThrow(/cannot read/)
    const arrayFile = path.join(invalid.dir, 'array.json')
    writeFileSync(arrayFile, '[]')
    expect(() => readVersion(arrayFile)).toThrow(/not a JSON object/)
  })

  it('runs check and sync modes from the CLI entry', () => {
    const { dir } = fixture('0.1.0', '0.0.0')
    const errors: string[] = []
    expect(main({ cwd: dir, argv: ['--check'], error: (line) => errors.push(line) })).toBe(1)
    expect(errors.join('\n')).toMatch(/version mismatch/)

    expect(main({ cwd: dir, argv: [] })).toBe(0)
    expect(readVersion(path.join(dir, 'apps/desktop/package.json'))).toBe('0.1.0')

    const logs: string[] = []
    expect(main({ cwd: dir, argv: ['--check'], log: (line) => logs.push(line) })).toBe(0)
    expect(logs.join('\n')).toMatch(/in sync: 0\.1\.0/)

    expect(main({ cwd: dir, argv: [] })).toBe(0)
  })
})
