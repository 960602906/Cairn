/**
 * SQLite 迁移框架（ADR-0006，架构 §14.3）。
 *
 * - `schema_meta` 记录 schema 版本；表由框架在第一个迁移的同一事务中创建。
 * - 迁移按编号从 1 起连续，待执行的迁移在一个事务中依次执行，版本随之更新。
 * - 已有数据库在执行前用 `VACUUM INTO` 备份；任何一步失败都回滚并用备份恢复数据库文件，
 *   新建的数据库则删除，下次启动重新开始。
 * - 数据库版本高于应用支持的版本时拒绝打开（`storage.schema_too_new`）。
 */
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { StorageError, StorageErrorCode } from '../types.js'

/** 迁移中可用的数据库操作。 */
export interface MigrationContext {
  exec(sql: string): void
}

export interface Migration {
  /** 从 1 起连续的编号。 */
  readonly version: number
  /** 如 `init`，用于日志与错误信息。 */
  readonly name: string
  up(db: MigrationContext): void
}

export interface MigrateOptions {
  /** 数据库文件路径。 */
  readonly file: string
  readonly migrations: readonly Migration[]
  readonly now?: () => number
}

export interface MigrateResult {
  readonly from: number
  readonly to: number
  /** 本次执行的迁移，如 `0001_init`。 */
  readonly applied: readonly string[]
  /** 执行前的备份文件；没有执行迁移或数据库是新建的时为空。 */
  readonly backupFile?: string
}

const META_DDL = `CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

/** 迁移的显示名，如 `0001_init`。 */
export function migrationId(migration: Migration): string {
  return `${String(migration.version).padStart(4, '0')}_${migration.name}`
}

/** 校验迁移列表：编号从 1 起连续。返回按编号排序的副本。 */
export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `migrations must be numbered 1..n without gaps; found ${migrationId(migration)} at #${index + 1}`,
      )
    }
  })
  return sorted
}

/** 读取 schema 版本；没有 `schema_meta` 时为 0。 */
export function readSchemaVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get()
  if (!table) return 0
  const row = db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as
    { version: number } | undefined
  return row?.version ?? 0
}

function removeDatabaseFiles(file: string): void {
  for (const path of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`])
    rmSync(path, { force: true })
}

/** 把数据库升级到最新版本。 */
export function migrateDatabase(options: MigrateOptions): MigrateResult {
  const { file } = options
  const now = options.now ?? Date.now
  const migrations = sortMigrations(options.migrations)
  const latest = migrations.length
  const existed = existsSync(file) && statSync(file).size > 0

  let db: Database.Database | undefined = new Database(file)
  let backupFile: string | undefined
  const applied: string[] = []

  try {
    const current = readSchemaVersion(db)
    if (current > latest) {
      throw new StorageError(StorageErrorCode.SchemaTooNew, { version: current, supported: latest })
    }
    if (current === latest) return { from: current, to: current, applied }

    if (existed) {
      backupFile = `${file}.v${current}-${now()}.bak`
      db.prepare('VACUUM INTO ?').run(backupFile)
    }

    const pending = migrations.slice(current)
    const conn = db
    const context: MigrationContext = { exec: (sql) => void conn.exec(sql) }
    let running: Migration | undefined
    try {
      conn.transaction(() => {
        conn.exec(META_DDL)
        for (const migration of pending) {
          running = migration
          migration.up(context)
          conn
            .prepare(
              `INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)
               ON CONFLICT (id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
            )
            .run(migration.version, now())
          applied.push(migrationId(migration))
        }
      })()
    } catch (cause) {
      const failed = running ? migrationId(running) : 'schema_meta'
      throw new StorageError(
        StorageErrorCode.MigrationFailed,
        { migration: failed, version: current },
        cause,
      )
    }

    return { from: current, to: latest, applied, ...(backupFile ? { backupFile } : {}) }
  } catch (error) {
    db.close()
    db = undefined
    if (error instanceof StorageError && error.code === StorageErrorCode.MigrationFailed) {
      // 事务已回滚；再用备份恢复文件，确保失败后的数据库与迁移前完全一致
      removeDatabaseFiles(file)
      if (backupFile) copyFileSync(backupFile, file)
    }
    throw error
  } finally {
    db?.close()
  }
}
