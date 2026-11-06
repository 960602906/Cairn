import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StorageError, StorageErrorCode } from '../types.js'
import {
  migrateDatabase,
  migrationId,
  readSchemaVersion,
  sortMigrations,
  type Migration,
} from './migrate.js'

const m1: Migration = {
  version: 1,
  name: 'notes',
  up: (db) => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)'),
}
const m2: Migration = {
  version: 2,
  name: 'tags',
  up: (db) => db.exec('ALTER TABLE notes ADD COLUMN tag TEXT'),
}
const broken: Migration = {
  version: 2,
  name: 'broken',
  up: (db) => {
    db.exec('ALTER TABLE notes ADD COLUMN tag TEXT')
    db.exec('INSERT INTO notes (text) VALUES (NULL)') // 违反 NOT NULL
  },
}

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cairn-migrate-'))
  file = path.join(dir, 'cairn.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function query<T>(sql: string): T[] {
  const db = new Database(file, { readonly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

function version(): number {
  const db = new Database(file, { readonly: true })
  try {
    return readSchemaVersion(db)
  } finally {
    db.close()
  }
}

function catchError(fn: () => unknown): StorageError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError)
    return error as StorageError
  }
  throw new Error('expected an error')
}

describe('migrateDatabase', () => {
  it('creates a new database and applies all migrations without a backup', () => {
    const result = migrateDatabase({ file, migrations: [m2, m1], now: () => 42 })
    expect(result).toEqual({ from: 0, to: 2, applied: ['0001_notes', '0002_tags'] })
    expect(version()).toBe(2)
    expect(query('SELECT version, updated_at FROM schema_meta')).toEqual([
      { version: 2, updated_at: 42 },
    ])
    expect(query<{ name: string }>('PRAGMA table_info(notes)').map((c) => c.name)).toEqual([
      'id',
      'text',
      'tag',
    ])
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([])
  })

  it('does nothing when the database is up to date', () => {
    migrateDatabase({ file, migrations: [m1, m2] })
    const result = migrateDatabase({ file, migrations: [m1, m2] })
    expect(result).toEqual({ from: 2, to: 2, applied: [] })
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([])
  })

  it('backs up an existing database before upgrading it', () => {
    migrateDatabase({ file, migrations: [m1] })
    const db = new Database(file)
    db.prepare("INSERT INTO notes (text) VALUES ('kept')").run()
    db.close()

    const result = migrateDatabase({ file, migrations: [m1, m2], now: () => 7 })
    expect(result).toEqual({
      from: 1,
      to: 2,
      applied: ['0002_tags'],
      backupFile: `${file}.v1-7.bak`,
    })
    expect(version()).toBe(2)
    expect(query('SELECT text, tag FROM notes')).toEqual([{ text: 'kept', tag: null }])

    const backup = new Database(`${file}.v1-7.bak`, { readonly: true })
    expect(readSchemaVersion(backup)).toBe(1)
    expect(backup.prepare('SELECT text FROM notes').all()).toEqual([{ text: 'kept' }])
    backup.close()
  })

  it('restores the database from the backup when a migration fails', () => {
    migrateDatabase({ file, migrations: [m1] })
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.prepare("INSERT INTO notes (text) VALUES ('kept')").run()
    db.close()

    const error = catchError(() =>
      migrateDatabase({ file, migrations: [m1, broken], now: () => 9 }),
    )
    expect(error.code).toBe(StorageErrorCode.MigrationFailed)
    expect(error.params).toEqual({ migration: '0002_broken', version: 1 })
    expect(error.cause).toBeInstanceOf(Error)

    expect(version()).toBe(1)
    expect(query<{ name: string }>('PRAGMA table_info(notes)').map((c) => c.name)).toEqual([
      'id',
      'text',
    ])
    expect(query('SELECT text FROM notes')).toEqual([{ text: 'kept' }])
    expect(existsSync(`${file}.v1-9.bak`)).toBe(true)

    // 修正迁移后可以正常升级
    expect(migrateDatabase({ file, migrations: [m1, m2] }).to).toBe(2)
  })

  it('removes a newly created database when its first migration fails', () => {
    const error = catchError(() =>
      migrateDatabase({ file, migrations: [{ ...broken, version: 1 }] }),
    )
    expect(error.params).toEqual({ migration: '0001_broken', version: 0 })
    expect(existsSync(file)).toBe(false)
  })

  it('treats an empty file as a new database', () => {
    writeFileSync(file, '')
    expect(migrateDatabase({ file, migrations: [m1] })).toEqual({
      from: 0,
      to: 1,
      applied: ['0001_notes'],
    })
  })

  it('refuses to open a database newer than the application', () => {
    migrateDatabase({ file, migrations: [m1, m2] })
    const error = catchError(() => migrateDatabase({ file, migrations: [m1] }))
    expect(error.code).toBe(StorageErrorCode.SchemaTooNew)
    expect(error.params).toEqual({ version: 2, supported: 1 })
    expect(version()).toBe(2)
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([])
  })
})

describe('readSchemaVersion', () => {
  it('is 0 without schema_meta or without its row', () => {
    const db = new Database(':memory:')
    expect(readSchemaVersion(db)).toBe(0)
    db.exec(
      'CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER, updated_at INTEGER)',
    )
    expect(readSchemaVersion(db)).toBe(0)
    db.close()
  })
})

describe('sortMigrations', () => {
  it('sorts and requires versions 1..n without gaps or duplicates', () => {
    expect(sortMigrations([m2, m1]).map(migrationId)).toEqual(['0001_notes', '0002_tags'])
    expect(sortMigrations([])).toEqual([])
    expect(() => sortMigrations([m2])).toThrow('0002_tags at #1')
    expect(() => sortMigrations([m1, { ...m1, name: 'again' }])).toThrow('0001_again at #2')
  })
})
