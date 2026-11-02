/**
 * 存储接口（ADR-0006，架构 §14）。业务代码只通过这些接口访问数据，不写 SQL。
 *
 * 接口是同步的：只有主进程写入数据库，所选引擎 better-sqlite3 是同步 API（S4，M0-08），
 * 同步接口让 `transaction` 与 `EventStore.append` 的原子性简单可靠。
 */
import type { PersistedEvent } from '@nexus/protocol'

export const StorageErrorCode = {
  /** 记录不存在。 */
  NotFound: 'storage.not_found',
  /** 主键或唯一约束冲突（如重复的 id、项目路径）。 */
  Conflict: 'storage.conflict',
  /** 追加的事件 seq 与会话当前最大 seq 不连续。 */
  SeqConflict: 'storage.seq_conflict',
  /** 事件不能落库（实时增量事件，或所属会话不存在）。 */
  InvalidEvent: 'storage.invalid_event',
  /** 数据库 schema 版本高于应用支持的版本（用户降级了应用），拒绝打开。 */
  SchemaTooNew: 'storage.schema_too_new',
  /** 迁移失败；数据库已恢复到迁移前的状态。 */
  MigrationFailed: 'storage.migration_failed',
} as const
export type StorageErrorCode = (typeof StorageErrorCode)[keyof typeof StorageErrorCode]

export class StorageError extends Error {
  readonly code: StorageErrorCode
  readonly params: Readonly<Record<string, string | number>>

  constructor(
    code: StorageErrorCode,
    params: Record<string, string | number> = {},
    cause?: unknown,
  ) {
    super(`${code} ${JSON.stringify(params)}`, cause === undefined ? undefined : { cause })
    this.name = 'StorageError'
    this.code = code
    this.params = params
  }
}

// ---------- 项目 ----------

export interface ProjectRecord {
  readonly projectId: string
  readonly name: string
  /** 用户项目的绝对路径，唯一。 */
  readonly path: string
  readonly createdAt: number
}

export interface CreateProjectInput {
  readonly projectId: string
  readonly name: string
  readonly path: string
}

export interface ProjectStore {
  /** 路径已存在时报 `storage.conflict`。 */
  create(input: CreateProjectInput): ProjectRecord
  get(projectId: string): ProjectRecord | undefined
  getByPath(path: string): ProjectRecord | undefined
  /** 按创建时间倒序。 */
  list(): ProjectRecord[]
}

// ---------- 会话 ----------

export interface SessionRecord {
  readonly sessionId: string
  readonly projectId: string
  readonly projectPath: string
  /** agent 实际工作的目录；第一版与 projectPath 相同（架构 §14.3）。 */
  readonly workspacePath: string
  readonly title: string
  readonly archived: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateSessionInput {
  readonly sessionId: string
  readonly projectId: string
  readonly workspacePath: string
  readonly title: string
}

export interface ListSessionsOptions {
  readonly projectId?: string
  readonly includeArchived?: boolean
}

export interface SessionStore {
  /** 项目不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。 */
  create(input: CreateSessionInput): SessionRecord
  get(sessionId: string): SessionRecord | undefined
  /** 按 `updatedAt` 倒序；默认不含已归档会话。 */
  list(options?: ListSessionsOptions): SessionRecord[]
  rename(sessionId: string, title: string): SessionRecord
  archive(sessionId: string): SessionRecord
  /** 更新 `updatedAt`（有新事件时由主进程调用）。 */
  touch(sessionId: string): SessionRecord
}

// ---------- 事件 ----------

export interface EventStore {
  /**
   * 在一个事务中追加事件，全部成功或全部不写入。
   * 每个会话的 seq 必须从当前 `maxSeq + 1` 起连续递增；实时增量事件不能落库。
   */
  append(events: readonly PersistedEvent[]): void
  /** 返回 `afterSeq` 之后的事件，按 seq 升序；`limit` 限制条数。 */
  readAfter(sessionId: string, afterSeq: number, limit?: number): PersistedEvent[]
  /** 会话没有事件时为 0。 */
  maxSeq(sessionId: string): number
}

// ---------- 汇总 ----------

export interface Storage {
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly events: EventStore
  /** 在一个事务中执行 `fn`；抛错时其中的所有写入回滚，错误原样抛出。可以嵌套。 */
  transaction<T>(fn: () => T): T
  close(): void
}

export interface StorageOptions {
  /** 时间来源，默认 `Date.now`。 */
  readonly now?: () => number
}
