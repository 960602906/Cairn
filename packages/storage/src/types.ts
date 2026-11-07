/**
 * 存储接口（ADR-0006，架构 §14）。业务代码只通过这些接口访问数据，不写 SQL。
 *
 * 接口是同步的：只有主进程写入数据库，所选引擎 better-sqlite3 是同步 API（S4，M0-08），
 * 同步接口让 `transaction` 与 `EventStore.append` 的原子性简单可靠。
 */
import type {
  FileChangeKind,
  FileChangeStatus,
  FileHunk,
  ModelRef,
  PermissionRule,
  PersistedEvent,
  ProviderConfig,
} from '@cairn/protocol'

export const StorageErrorCode = {
  /** 记录不存在。 */
  NotFound: 'storage.not_found',
  /** 主键或唯一约束冲突（如重复的 id、项目路径）。 */
  Conflict: 'storage.conflict',
  /** 追加的事件 seq 不大于会话当前最大 seq（重复或倒退）。 */
  SeqConflict: 'storage.seq_conflict',
  /** 事件不能落库（实时增量事件，或所属会话不存在）。 */
  InvalidEvent: 'storage.invalid_event',
  /** 数据库 schema 版本高于应用支持的版本（用户降级了应用），拒绝打开。 */
  SchemaTooNew: 'storage.schema_too_new',
  /** 迁移失败；数据库已恢复到迁移前的状态。 */
  MigrationFailed: 'storage.migration_failed',
  /** 记录的内容不一致，不能保存（如权限规则的范围与归属不符）。 */
  InvalidRecord: 'storage.invalid_record',
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
  /** 每轮开始时是否读取 `AGENTS.md`（M3-02）。新建的项目默认读取。 */
  readonly readAgentsMd: boolean
  /** 是否启用项目内 Skills（M3-02 只保存，M3-07 起生效）。新建的项目默认关闭。 */
  readonly enableProjectSkills: boolean
  /** 从列表移除的时间（M3-02）。还在列表中时不出现。 */
  readonly removedAt?: number
}

export interface UpdateProjectInput {
  readonly name?: string
  readonly readAgentsMd?: boolean
  readonly enableProjectSkills?: boolean
}

export interface CreateProjectInput {
  readonly projectId: string
  readonly name: string
  readonly path: string
}

export interface ProjectStore {
  /** 路径已存在时报 `storage.conflict`（含已从列表移除的项目）。 */
  create(input: CreateProjectInput): ProjectRecord
  /** 含已从列表移除的项目，会话仍要能找到它。 */
  get(projectId: string): ProjectRecord | undefined
  getByPath(path: string): ProjectRecord | undefined
  /** 按创建时间倒序，不含已从列表移除的。 */
  list(): ProjectRecord[]
  /** 项目不存在或已移除时报 `storage.not_found`。 */
  update(projectId: string, patch: UpdateProjectInput): ProjectRecord
  /** 从列表移除（不删目录、不删会话）。已经移除或不存在时报 `storage.not_found`。 */
  remove(projectId: string): ProjectRecord
  /** 重新放回列表。不存在时报 `storage.not_found`。 */
  restore(projectId: string): ProjectRecord
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
  /** 会话使用的模型（M1-04a）；之前创建的会话没有。 */
  readonly model?: ModelRef
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateSessionInput {
  readonly sessionId: string
  readonly projectId: string
  readonly workspacePath: string
  readonly title: string
  readonly model?: ModelRef
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
  /** 更换会话使用的模型（M2-04），下一轮生效。 */
  setModel(sessionId: string, model: ModelRef): SessionRecord
  /** 更新 `updatedAt`（有新事件时由主进程调用）。 */
  touch(sessionId: string): SessionRecord
}

// ---------- 模型提供方 ----------

/** 模型提供方配置（M1-04a）。格式由调用方用 `ProviderConfig` schema 校验，存储不再校验。 */
export interface ProviderStore {
  /** 按保存时的顺序。 */
  list(): ProviderConfig[]
  get(providerId: string): ProviderConfig | undefined
  /** 用给出的列表整体替换（顺序即列表顺序）。 */
  replaceAll(configs: readonly ProviderConfig[]): void
}

// ---------- 权限规则 ----------

/**
 * 保存的权限规则（M1-10c，架构 §10.1）。项目范围的规则属于一个项目，会话范围的规则属于一个会话，
 * 全局规则没有归属。预设规则不保存，由权限模式生成。规则格式由调用方用 `PermissionRule` schema 校验。
 */
export interface PermissionRuleRecord {
  readonly rule: PermissionRule
  readonly projectId?: string
  readonly sessionId?: string
  readonly createdAt: number
}

export interface AddPermissionRuleInput {
  readonly rule: PermissionRule
  /** 项目范围的规则必须给出，其他范围不能给出。 */
  readonly projectId?: string
  /** 会话范围的规则必须给出，其他范围不能给出。 */
  readonly sessionId?: string
}

export interface ListPermissionRulesOptions {
  /** 同时列出这个项目的规则。 */
  readonly projectId?: string
  /** 同时列出这个会话的规则。 */
  readonly sessionId?: string
}

export interface PermissionRuleStore {
  /**
   * 范围与归属不符、或来源为预设时报 `storage.invalid_record`；项目或会话不存在时报
   * `storage.not_found`；id 重复时报 `storage.conflict`。
   */
  add(input: AddPermissionRuleInput): PermissionRuleRecord
  get(ruleId: string): PermissionRuleRecord | undefined
  /** 全局规则，加上给出的项目、会话的规则；按全局、项目、会话排列，同一范围内按添加顺序。 */
  list(options?: ListPermissionRulesOptions): PermissionRuleRecord[]
  /** 不存在时报 `storage.not_found`。 */
  delete(ruleId: string): void
}

// ---------- 事件 ----------

export interface EventStore {
  /**
   * 在一个事务中追加事件，全部成功或全部不写入。
   * 每个会话的 seq 必须严格递增（大于当前 `maxSeq`），允许有空缺：实时增量事件与持久化事件
   * 共用同一个 seq 计数器（M0-06c 约定），增量不落库，因此留下空缺。实时增量事件不能落库。
   */
  append(events: readonly PersistedEvent[]): void
  /** 返回 `afterSeq` 之后的事件，按 seq 升序；`limit` 限制条数。 */
  readAfter(sessionId: string, afterSeq: number, limit?: number): PersistedEvent[]
  /** 会话没有事件时为 0。 */
  maxSeq(sessionId: string): number
}

// ---------- 文件改动 ----------

/**
 * 改动中的一个 diff 块（架构 §14.2 `hunks`）。
 * 按块撤销（M3-06）后，块可以单独处于 `reverted`；所属改动要等每一块都撤销才变为 `reverted`。
 */
export interface HunkRecord extends FileHunk {
  readonly status: FileChangeStatus
}

/**
 * 文件改动记录（M1-08b，架构 §14.2 `file_changes`）。前后内容在 blob 存储中，这里只保存哈希：
 * `create` 没有 `beforeHash`，`delete` 没有 `afterHash`。
 */
export interface FileChangeRecord {
  readonly changeId: string
  readonly sessionId: string
  readonly runId?: string
  readonly turnId?: string
  readonly toolCallId?: string
  /** 相对工作区根目录的路径，`/` 分隔。 */
  readonly path: string
  readonly kind: FileChangeKind
  readonly beforeHash?: string
  readonly afterHash?: string
  /** 撤销产生的改动：被撤销的改动 id。 */
  readonly revertOf?: string
  readonly status: FileChangeStatus
  readonly added: number
  readonly removed: number
  readonly hunks: readonly HunkRecord[]
  readonly createdAt: number
}

export interface CreateFileChangeInput {
  readonly changeId: string
  readonly sessionId: string
  readonly runId?: string
  readonly turnId?: string
  readonly toolCallId?: string
  readonly path: string
  readonly kind: FileChangeKind
  readonly beforeHash?: string
  readonly afterHash?: string
  readonly revertOf?: string
  readonly added: number
  readonly removed: number
  readonly hunks: readonly FileHunk[]
}

export interface FileChangeStore {
  /** 状态为 `pending`。会话不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。 */
  create(input: CreateFileChangeInput): FileChangeRecord
  get(changeId: string): FileChangeRecord | undefined
  /** 会话的全部改动，按记录的先后顺序。 */
  list(sessionId: string): FileChangeRecord[]
  /** 改动及其全部块的状态。不存在时报 `storage.not_found`。 */
  setStatus(changeId: string, status: FileChangeStatus): FileChangeRecord
  /**
   * 只改一块的状态（M3-06）。每一块都变为 `reverted` 时，改动状态也变为 `reverted`；
   * 从已撤销的改动里把一块改回非 `reverted` 时，改动状态回到 `pending`。
   * 改动或块不存在时报 `storage.not_found`。
   */
  setHunkStatus(changeId: string, hunkIndex: number, status: FileChangeStatus): FileChangeRecord
}

// ---------- 汇总 ----------

export interface Storage {
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly providers: ProviderStore
  readonly events: EventStore
  readonly changes: FileChangeStore
  readonly permissionRules: PermissionRuleStore
  /** 在一个事务中执行 `fn`；抛错时其中的所有写入回滚，错误原样抛出。可以嵌套。 */
  transaction<T>(fn: () => T): T
  close(): void
}

export interface StorageOptions {
  /** 时间来源，默认 `Date.now`。 */
  readonly now?: () => number
}
