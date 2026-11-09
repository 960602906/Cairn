import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupBeforeUpdate,
  backupTimestamp,
  credentialMetadata,
  listUpdateBackups,
  pruneUpdateBackups,
  UPDATE_BACKUP_KEEP,
} from './update-backup.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cairn-backup-'))
  roots.push(root)
  return root
}

function options(root: string, overrides: Record<string, unknown> = {}) {
  const settings = join(root, 'settings.json')
  const credentials = join(root, 'credentials.json')
  const database = join(root, 'cairn.db')
  writeFileSync(settings, '{"locale":"zh-CN"}\n')
  writeFileSync(
    credentials,
    JSON.stringify({
      version: 1,
      credentials: {
        openai: { kind: 'local-key', ciphertext: 'top-secret-ciphertext', updatedAt: 7 },
      },
    }),
  )
  return {
    root: join(root, 'backups'),
    databaseFile: database,
    settingsFile: settings,
    credentialsFile: credentials,
    backupDatabase: (destination: string) => writeFileSync(destination, 'database snapshot'),
    ...overrides,
  }
}

describe('credentialMetadata', () => {
  it('keeps references and drops ciphertext', () => {
    const metadata = credentialMetadata(
      JSON.stringify({
        version: 1,
        credentials: {
          openai: { kind: 'local-key', ciphertext: 'secret', updatedAt: 3 },
          broken: null,
        },
      }),
    )
    expect(metadata).toEqual({
      available: true,
      version: 1,
      credentials: { openai: { kind: 'local-key', updatedAt: 3 } },
      note: 'ciphertext intentionally omitted',
    })
    expect(JSON.stringify(metadata)).not.toContain('secret')
  })

  it('marks invalid files as unavailable without leaking content', () => {
    expect(credentialMetadata('not json')).toEqual({ available: false, reason: 'invalid' })
    expect(credentialMetadata('[]')).toEqual({ available: false, reason: 'invalid' })
    expect(credentialMetadata('{"version":1}')).toEqual({
      available: true,
      version: 1,
      credentials: {},
      note: 'ciphertext intentionally omitted',
    })
    expect(credentialMetadata('{"version":"1","credentials":{}}')).toMatchObject({
      available: true,
      version: undefined,
    })
  })
})

describe('backupBeforeUpdate', () => {
  it('creates a backup with database, settings and credential metadata', () => {
    const root = tempRoot()
    const result = backupBeforeUpdate(options(root), { from: '0.1.0', to: '0.1.1' })
    expect(result.files).toEqual(['cairn.db', 'settings.json', 'credentials-metadata.json'])
    expect(existsSync(join(result.path, 'cairn.db'))).toBe(true)
    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      files: result.files,
    })
    expect(listUpdateBackups(join(root, 'backups'))).toHaveLength(1)
  })

  it('skips missing optional files and keeps only the newest two backups', () => {
    const root = tempRoot()
    const base = options(root)
    rmSync(base.settingsFile)
    rmSync(base.credentialsFile)
    let time = 1_000
    for (let index = 0; index < 3; index += 1) {
      backupBeforeUpdate({ ...base, now: () => (time += 1) }, { from: '0.1.0', to: '0.1.1' })
    }
    const backups = listUpdateBackups(base.root)
    expect(backups).toHaveLength(UPDATE_BACKUP_KEEP)
    expect(backups[0]!.createdAt).toBeGreaterThan(backups[1]!.createdAt)
    expect(backups[0]!.files).toEqual(['cairn.db'])
  })

  it('throws and removes the directory when the database snapshot fails', () => {
    const root = tempRoot()
    const base = options(root)
    expect(() =>
      backupBeforeUpdate(
        {
          ...base,
          backupDatabase: () => {
            throw new Error('locked')
          },
        },
        { from: '0.1.0', to: '0.1.1' },
      ),
    ).toThrow('update.backup_failed')
    expect(listUpdateBackups(base.root)).toHaveLength(0)
  })

  it('removes the directory when credential metadata cannot be read', () => {
    const root = tempRoot()
    const base = options(root)
    // 目录会让 readFileSync 失败；备份必须失败关闭。
    rmSync(base.credentialsFile)
    const directory = join(root, 'credentials.json')
    mkdirSync(directory)
    expect(() => backupBeforeUpdate(base, { from: '0.1.0', to: '0.1.1' })).toThrow(
      'update.backup_failed',
    )
  })
})

describe('backup listing and pruning', () => {
  it('reads timestamps from directory names when the manifest is missing', () => {
    const root = tempRoot()
    const path = join(root, 'update-0.1.0-to-0.1.1-1234567890123')
    mkdirSync(path)
    expect(backupTimestamp(path)).toBe(1234567890123)
    expect(listUpdateBackups(root)).toEqual([{ path, createdAt: 1234567890123, files: [] }])
    expect(backupTimestamp(join(root, 'update-without-time'))).toBe(0)
  })

  it('ignores invalid manifests and filters non-string files', () => {
    const root = tempRoot()
    const nullManifest = join(root, 'update-0.1.0-to-0.1.1-1111111111')
    const badFields = join(root, 'update-0.1.0-to-0.1.1-2222222222')
    const filtered = join(root, 'update-0.1.0-to-0.1.1-3333333333')
    for (const path of [nullManifest, badFields, filtered]) mkdirSync(path)
    writeFileSync(join(nullManifest, 'manifest.json'), 'null')
    writeFileSync(
      join(badFields, 'manifest.json'),
      JSON.stringify({ createdAt: 'yesterday', files: [] }),
    )
    writeFileSync(
      join(filtered, 'manifest.json'),
      JSON.stringify({ createdAt: 5, files: [1, 'cairn.db', null] }),
    )
    expect(listUpdateBackups(root)).toEqual([
      { path: badFields, createdAt: 2222222222, files: [] },
      { path: nullManifest, createdAt: 1111111111, files: [] },
      { path: filtered, createdAt: 5, files: ['cairn.db'] },
    ])
  })

  it('orders backups with the same creation time by path', () => {
    const root = tempRoot()
    const first = join(root, 'update-a-111')
    const second = join(root, 'update-b-111')
    mkdirSync(first)
    mkdirSync(second)
    for (const path of [first, second]) {
      writeFileSync(join(path, 'manifest.json'), JSON.stringify({ createdAt: 1, files: [] }))
    }
    expect(listUpdateBackups(root).map((backup) => backup.path)).toEqual([second, first])
  })

  it('prunes old backups and tolerates missing directories', () => {
    const root = tempRoot()
    const base = options(root)
    let time = 1_000
    for (let index = 0; index < 3; index += 1) {
      backupBeforeUpdate(
        { ...base, now: () => (time += 1), keep: 3 },
        { from: '0.1.0', to: '0.1.1' },
      )
    }
    const removed = pruneUpdateBackups(base.root, 1)
    expect(removed).toHaveLength(2)
    expect(listUpdateBackups(base.root)).toHaveLength(1)
    expect(pruneUpdateBackups(join(root, 'missing'), 2)).toEqual([])
  })
})
