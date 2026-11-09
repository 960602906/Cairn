/**
 * 自动更新前的数据备份（M5-06，ADR-0036）。
 *
 * - 安装前备份数据库、`settings.json` 与凭据文件元数据；凭据只保存引用、类型与更新时间，
 *   **不复制密文或明文密钥**。
 * - 每次备份一个目录，保留最近两份；更早的目录在成功后删除。
 * - 备份失败必须阻止安装（由调用方处理），不能带着未备份的数据升级。
 * - 目录名只包含版本与时间戳；清单不包含用户路径、项目内容或凭据。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { UpdateBackupInfo } from '@cairn/protocol'

export const UPDATE_BACKUP_PREFIX = 'update-'
/** 保留的备份份数（ADR-0036：最近两份）。 */
export const UPDATE_BACKUP_KEEP = 2

export interface UpdateBackupOptions {
  /** 备份根目录，通常为 `<userData>/backups`。 */
  readonly root: string
  readonly databaseFile: string
  readonly settingsFile: string
  readonly credentialsFile: string
  /** 用 `storage.backup` 取得一致的数据库快照。 */
  readonly backupDatabase: (destination: string) => void
  readonly now?: () => number
  readonly keep?: number
}

export interface UpdateBackupResult {
  readonly path: string
  readonly createdAt: number
  readonly files: readonly string[]
}

export class UpdateBackupError extends Error {
  constructor(
    readonly code: string,
    override readonly cause?: unknown,
  ) {
    super(code)
    this.name = 'UpdateBackupError'
  }
}

interface CredentialsFile {
  readonly version?: unknown
  readonly credentials?: unknown
}

/** 只保留凭据的引用与元数据，去掉密文。 */
export function credentialMetadata(text: string): Record<string, unknown> {
  let parsed: CredentialsFile
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { available: false, reason: 'invalid' }
    }
    parsed = value as CredentialsFile
  } catch {
    return { available: false, reason: 'invalid' }
  }
  const entries: Record<string, unknown> = {}
  if (typeof parsed.credentials === 'object' && parsed.credentials !== null) {
    for (const [ref, entry] of Object.entries(parsed.credentials as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      entries[ref] = {
        kind: record['kind'],
        updatedAt: record['updatedAt'],
      }
    }
  }
  return {
    available: true,
    version: typeof parsed.version === 'number' ? parsed.version : undefined,
    credentials: entries,
    note: 'ciphertext intentionally omitted',
  }
}

/** 备份目录的排序时间（目录名里的毫秒时间戳）。 */
export function backupTimestamp(path: string): number {
  const match = /(\d{10,})/.exec(path.slice(path.lastIndexOf('update-')))
  return match ? Number(match[1]) : 0
}

/** 列出备份目录，新的在前。 */
export function listUpdateBackups(root: string): UpdateBackupInfo[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(UPDATE_BACKUP_PREFIX))
    .map((entry) => join(root, entry.name))
  const backups: UpdateBackupInfo[] = []
  for (const path of entries) {
    const manifest = readManifest(path)
    backups.push({
      path,
      createdAt: manifest?.createdAt ?? backupTimestamp(path),
      files: manifest?.files ?? [],
    })
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path))
}

interface StoredManifest {
  readonly createdAt: number
  readonly files: string[]
}

function readManifest(path: string): StoredManifest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    const createdAt = record['createdAt']
    const files = record['files']
    if (typeof createdAt !== 'number' || !Array.isArray(files)) return undefined
    return { createdAt, files: files.filter((item): item is string => typeof item === 'string') }
  } catch {
    return undefined
  }
}

/** 删除超出保留份数的备份；返回删除的目录。 */
export function pruneUpdateBackups(root: string, keep = UPDATE_BACKUP_KEEP): string[] {
  const removed: string[] = []
  for (const backup of listUpdateBackups(root).slice(keep)) {
    try {
      rmSync(backup.path, { recursive: true, force: true })
      removed.push(backup.path)
    } catch {
      // 清理失败不影响本次更新；下次安装前还会再试。
    }
  }
  return removed
}

function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z.-]/g, '_')
}

/**
 * 创建一份更新前备份。数据库快照失败时抛出 `UpdateBackupError`；
 * 设置与凭据元数据缺失按“没有这份数据”处理，不阻止更新。
 */
export function backupBeforeUpdate(
  options: UpdateBackupOptions,
  versions: { readonly from: string; readonly to: string },
): UpdateBackupResult {
  const now = options.now ?? Date.now
  const createdAt = now()
  const directory = join(
    options.root,
    `${UPDATE_BACKUP_PREFIX}${safeName(versions.from)}-to-${safeName(versions.to)}-${createdAt}`,
  )
  const files: string[] = []
  try {
    mkdirSync(directory, { recursive: true })
    const database = join(directory, 'cairn.db')
    options.backupDatabase(database)
    files.push('cairn.db')
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // 忽略清理失败，错误仍然上抛。
    }
    throw new UpdateBackupError('update.backup_failed', error)
  }

  try {
    if (existsSync(options.settingsFile)) {
      copyFileSync(options.settingsFile, join(directory, 'settings.json'))
      files.push('settings.json')
    }
    if (existsSync(options.credentialsFile)) {
      const metadata = credentialMetadata(readFileSync(options.credentialsFile, 'utf8'))
      writeFileSync(
        join(directory, 'credentials-metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      )
      files.push('credentials-metadata.json')
    }
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // 忽略清理失败，错误仍然上抛。
    }
    throw new UpdateBackupError('update.backup_failed', error)
  }

  const sizes: Record<string, number> = {}
  for (const file of files) {
    try {
      sizes[file] = statSync(join(directory, file)).size
    } catch {
      // 清单不需要大小；文件缺失会在恢复时暴露。
    }
  }
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fromVersion: versions.from,
        toVersion: versions.to,
        createdAt,
        files,
        sizes,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  pruneUpdateBackups(options.root, options.keep ?? UPDATE_BACKUP_KEEP)
  return { path: directory, createdAt, files }
}
