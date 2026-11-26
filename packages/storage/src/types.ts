/**
 * 存储接口（ADR-0006，架构 §14）。业务代码只通过这些接口访问数据，不写 SQL。
 *
 * 接口是同步的：只有主进程写入数据库，所选引擎 better-sqlite3 是同步 API（S4，M0-08），
 * 同步接口让 `transaction` 与 `EventStore.append` 的原子性简单可靠。
 */
import type {
  ChangeSetFileKind,
  ChangeSetFileStatus,
  ChangeSetStatus,
  FileChangeKind,
  FileChangeStatus,
  FileHunk,
  MemoryScope,
  ModelRef,
  PermissionRule,
  PersistedEvent,
  ProviderConfig,
  ReasoningEffort,
  SkillSource,
} from '@cairn/protocol'
import type { McpAuthKind, McpServerKind, PermissionEffect, ToolCategory } from '@cairn/protocol'
import type { AgentSource } from '@cairn/protocol'
import type { BackgroundCommand, BackgroundCommandOutput } from '@cairn/protocol'

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
  /** 置顶时间；未置顶时不出现。 */
  readonly pinnedAt?: number
  /** 归档时间；未归档时不出现。 */
  readonly archivedAt?: number
  /** 从列表移除的时间（M3-02）。还在列表中时不出现。 */
  readonly removedAt?: number
}

export interface UpdateProjectInput {
  readonly name?: string
  readonly readAgentsMd?: boolean
  readonly enableProjectSkills?: boolean
  readonly pinned?: boolean
  readonly archived?: boolean
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

export type SessionKind = 'normal' | 'trial' | 'auto-fix'

export interface SessionRecord {
  readonly sessionId: string
  readonly projectId: string
  readonly projectPath: string
  /** agent 实际工作的目录；第一版与 projectPath 相同（架构 §14.3）。 */
  readonly workspacePath: string
  readonly title: string
  readonly archived: boolean
  /** 置顶：在列表里排到同组最前（桌面手感）。 */
  readonly pinned: boolean
  /** 普通会话或 Agent 试运行（M4-12）。 */
  readonly kind: SessionKind
  /** 试运行引用的 Agent；普通会话没有。 */
  readonly trialAgentId?: string
  /** 试运行时使用的草稿内容哈希；普通会话没有。 */
  readonly trialDraftHash?: string
  /** 团队试运行引用的模板（M7-09）；单 Agent 试运行没有。 */
  readonly trialTeamId?: string
  /** 团队试运行时草稿的内容哈希，用于判断模板是否又改过（M7-09）。 */
  readonly trialTeamDraftHash?: string
  /** 会话使用的模型（M1-04a）；之前创建的会话没有。 */
  readonly model?: ModelRef
  /** 本会话的思考强度覆盖（下一轮生效）；没有时用模型配置里的默认值。 */
  readonly thinkingLevel?: ReasoningEffort
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateSessionInput {
  readonly sessionId: string
  readonly projectId: string
  readonly workspacePath: string
  readonly title: string
  /** 省略时为普通会话。 */
  readonly kind?: SessionKind
  readonly trialAgentId?: string
  readonly trialDraftHash?: string
  readonly trialTeamId?: string
  readonly trialTeamDraftHash?: string
  readonly model?: ModelRef
}

export interface ListSessionsOptions {
  readonly projectId?: string
  readonly includeArchived?: boolean
  /** 默认排除试运行会话；只有试运行历史与启动恢复需要显式包含。 */
  readonly includeTrial?: boolean
}

/** 全文搜索命中：会话 id 与命中附近的正文片段。 */
export interface SessionSearchHit {
  readonly sessionId: string
  readonly snippet: string
}

export interface SessionSearchOptions {
  /** 最多返回多少个会话，默认 100。 */
  readonly limit?: number
  /** 是否包含已归档的会话，默认否。 */
  readonly includeArchived?: boolean
}

export interface SessionStore {
  /** 项目不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。 */
  create(input: CreateSessionInput): SessionRecord
  get(sessionId: string): SessionRecord | undefined
  /** 按 `updatedAt` 倒序；默认不含已归档与试运行会话。 */
  list(options?: ListSessionsOptions): SessionRecord[]
  /**
   * 在用户与助手的消息正文里搜索（不区分大小写，多个词都要出现），每个会话最多一条结果。
   * 顺序与 `list()` 一致（置顶优先、最近更新在前）。
   */
  searchText(query: string, options?: SessionSearchOptions): SessionSearchHit[]
  /** 删除会话及其事件、改动、快照与权限规则；不存在时报 `storage.not_found`。 */
  remove(sessionId: string): void
  rename(sessionId: string, title: string): SessionRecord
  /** 置顶 / 取消置顶；不改变 `updatedAt`，避免置顶本身把会话当成“刚用过”。 */
  setPinned(sessionId: string, pinned: boolean): SessionRecord
  archive(sessionId: string): SessionRecord
  /** 取消归档：会话重新出现在默认列表里。不存在时报 `storage.not_found`。 */
  unarchive(sessionId: string): SessionRecord
  /** 更换会话使用的模型（M2-04），下一轮生效。 */
  setModel(sessionId: string, model: ModelRef): SessionRecord
  /** 设定会话的思考强度，下一轮生效。不存在时报 `storage.not_found`。 */
  setThinkingLevel(sessionId: string, thinkingLevel: ReasoningEffort): SessionRecord
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

// ---------- 记忆（M7-01，ADR-0019） ----------

export type MemoryStatus = 'proposed' | 'active'

/**
 * 一条记忆条目。范围与归属一一对应：`session` 有 `session_id`，`project` 有 `project_id`，
 * `global` 两者都没有。`proposed` 条目要等用户确认后才变 `active`，不进入模型请求（M7-02）。
 */
export interface MemoryEntryRecord {
  readonly memoryId: string
  readonly scope: MemoryScope
  readonly sessionId?: string
  readonly projectId?: string
  readonly content: string
  readonly status: MemoryStatus
  /** 提议或写入这条记忆的运行与 Agent；由调用方给出，M7-03 起使用。 */
  readonly sourceRunId?: string
  readonly sourceAgentId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ProposeMemoryInput {
  readonly memoryId: string
  readonly scope: MemoryScope
  /** 必填且不能为空。 */
  readonly content: string
  /** `session` 范围必填，其他范围不能给出。 */
  readonly sessionId?: string
  /** `project` 范围必填，其他范围不能给出。 */
  readonly projectId?: string
  readonly sourceRunId?: string
  readonly sourceAgentId?: string
}

/** 管理界面用的筛选（M7-04）：跨项目列出全部条目，不做范围隔离。 */
export interface ListAllMemoryOptions {
  readonly scope?: MemoryScope
  readonly status?: MemoryStatus
}

export interface ListMemoryOptions {
  /** 同时列出这个项目的记忆。 */
  readonly projectId?: string
  /** 同时列出这个会话的记忆。 */
  readonly sessionId?: string
  /** 只列出这个状态；省略时列出全部。 */
  readonly status?: MemoryStatus
}

/**
 * 记忆存储。查询按范围隔离：给出哪个项目/会话就只能读到哪一份记忆，跨项目的条目在查询层就不可达。
 * 删除是硬删除；调用方负责写 `memory.deleted` 事件（M7-03）。
 */
export interface MemoryStore {
  /**
   * 写入一条 `proposed` 条目。范围与归属不符、或内容为空时报 `storage.invalid_record`；
   * 项目或会话不存在时报 `storage.not_found`；id 重复时报 `storage.conflict`。
   */
  propose(input: ProposeMemoryInput): MemoryEntryRecord
  get(memoryId: string): MemoryEntryRecord | undefined
  /** 全局，加上给出的项目与会话的条目；按会话、项目、全局排列，同一范围内按创建顺序。 */
  list(options?: ListMemoryOptions): MemoryEntryRecord[]
  /**
   * 列出全部条目（M7-04 管理界面）：不按项目或会话隔离，可按范围与状态筛选。
   * 只给用户的管理界面使用；Agent 读取一律走 `list`。
   */
  listAll(options?: ListAllMemoryOptions): MemoryEntryRecord[]
  /** `proposed` → `active`；已经是 `active` 时原样返回。不存在时报 `storage.not_found`。 */
  confirm(memoryId: string): MemoryEntryRecord
  /** 编辑内容并更新 `updatedAt`。内容为空时报 `storage.invalid_record`，不存在时报 `storage.not_found`。 */
  update(memoryId: string, content: string): MemoryEntryRecord
  /** 硬删除并返回被删除的条目。不存在时报 `storage.not_found`。 */
  delete(memoryId: string): MemoryEntryRecord
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

// ---------- 技能开关 ----------

/** 一份技能的启用与固定加载（M3-07）。没有记录时按启用、不固定。 */
export interface SkillPref {
  /** `global`，或项目 id。 */
  readonly scope: string
  readonly source: SkillSource
  readonly name: string
  readonly enabled: boolean
  readonly pinned: boolean
}

export interface SkillPrefStore {
  get(scope: string, source: SkillSource, name: string): SkillPref | undefined
  /** 某一范围里的全部记录。 */
  list(scope: string): SkillPref[]
  /** 写入或覆盖。 */
  set(pref: SkillPref): SkillPref
  /** 没有记录时什么也不做。 */
  delete(scope: string, source: SkillSource, name: string): void
}

// ---------- MCP 服务 ----------

/** 环境变量的凭据引用（M3-09）。值只在凭据服务中。 */
export interface McpEnvRef {
  readonly name: string
  readonly credentialRef: string
}

/** 一条 MCP 服务配置。环境变量值与令牌只保存引用。 */
export interface McpServerRecord {
  readonly serverId: string
  readonly name: string
  readonly kind: McpServerKind
  readonly command?: string | undefined
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly url?: string | undefined
  readonly auth: McpAuthKind
  readonly headerName?: string | undefined
  /** 认证令牌的凭据引用（`bearer` / `header`）。 */
  readonly credentialRef?: string | undefined
  readonly env: readonly McpEnvRef[]
  readonly enabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateMcpServerInput {
  readonly serverId: string
  readonly name: string
  readonly kind: McpServerKind
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly url?: string
  readonly auth?: McpAuthKind
  readonly headerName?: string
  readonly credentialRef?: string
  readonly env?: readonly McpEnvRef[]
  readonly enabled?: boolean
}

export interface UpdateMcpServerInput {
  readonly name?: string
  readonly kind?: McpServerKind
  readonly command?: string | null
  readonly args?: readonly string[]
  readonly cwd?: string | null
  readonly url?: string | null
  readonly auth?: McpAuthKind
  readonly headerName?: string | null
  readonly credentialRef?: string | null
  readonly env?: readonly McpEnvRef[]
  readonly enabled?: boolean
}

export interface McpServerStore {
  list(): McpServerRecord[]
  get(serverId: string): McpServerRecord | undefined
  /** id 重复时报 `storage.conflict`。 */
  create(input: CreateMcpServerInput): McpServerRecord
  /** 不存在时报 `storage.not_found`。 */
  update(serverId: string, patch: UpdateMcpServerInput): McpServerRecord
  remove(serverId: string): void
}

/** 一个 MCP 工具的类别与默认效果（M3-09）。没有记录时按 `network` / `ask`。 */
export interface McpToolPref {
  readonly serverId: string
  readonly name: string
  readonly category: ToolCategory
  readonly effect: PermissionEffect
}

export interface McpToolPrefStore {
  get(serverId: string, name: string): McpToolPref | undefined
  list(serverId: string): McpToolPref[]
  set(pref: McpToolPref): McpToolPref
  deleteForServer(serverId: string): void
}

// ---------- Agent 定义（M3-11） ----------

/**
 * 一条 Agent 记录。`source` 为 `user` / `imported`；内置 Agent 由代码提供，不落库。
 * `draft` 是 `AgentDraft` 的 JSON（未解析，读取方负责 zod 校验）。
 */
export interface AgentRecord {
  readonly agentId: string
  readonly source: AgentSource
  readonly archived: boolean
  readonly draft?: unknown
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateAgentInput {
  readonly agentId: string
  readonly source: AgentSource
  readonly draft?: unknown
}

/** 一个已发布的 Agent 版本。`definition` 是 `AgentDefinition` 的 JSON。 */
export interface AgentVersionRecord {
  readonly agentId: string
  readonly version: number
  readonly definition: unknown
  readonly publishedAt: number
}

export interface AddAgentVersionInput {
  readonly agentId: string
  readonly version: number
  readonly definition: unknown
}

export interface AgentStore {
  get(agentId: string): AgentRecord | undefined
  list(): AgentRecord[]
  /** id 重复时报 `storage.conflict`。 */
  create(input: CreateAgentInput): AgentRecord
  /** 写入或覆盖草稿；不存在时报 `storage.not_found`。 */
  saveDraft(agentId: string, draft: unknown): AgentRecord
  /** 发布后清掉草稿；不存在时报 `storage.not_found`。 */
  clearDraft(agentId: string): AgentRecord
  setArchived(agentId: string, archived: boolean): AgentRecord
  /** 连同已发布版本一起删除；不存在时报 `storage.not_found`。 */
  remove(agentId: string): void
  /** 按版本号升序。 */
  versions(agentId: string): AgentVersionRecord[]
  version(agentId: string, version: number): AgentVersionRecord | undefined
  /** 版本号重复时报 `storage.conflict`。 */
  addVersion(input: AddAgentVersionInput): AgentVersionRecord
}

// ---------- 团队模板（M7-06） ----------

/**
 * 一条团队模板记录。`draft` 是 `TeamDraft` 的 JSON（未解析，读取方负责 zod 校验）。
 * 与 Agent 一样，草稿与已发布版本分开保存。
 */
export interface AgentTeamRecord {
  readonly teamId: string
  readonly archived: boolean
  readonly draft?: unknown
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateAgentTeamInput {
  readonly teamId: string
  readonly draft?: unknown
}

/** 一个已发布的团队模板版本。`definition` 是 `AgentTeam` 的 JSON。 */
export interface AgentTeamVersionRecord {
  readonly teamId: string
  readonly version: number
  readonly definition: unknown
  readonly publishedAt: number
}

export interface AddAgentTeamVersionInput {
  readonly teamId: string
  readonly version: number
  readonly definition: unknown
}

export interface AgentTeamStore {
  get(teamId: string): AgentTeamRecord | undefined
  list(): AgentTeamRecord[]
  /** id 重复时报 `storage.conflict`。 */
  create(input: CreateAgentTeamInput): AgentTeamRecord
  /** 写入或覆盖草稿；不存在时报 `storage.not_found`。 */
  saveDraft(teamId: string, draft: unknown): AgentTeamRecord
  /** 发布后清掉草稿；不存在时报 `storage.not_found`。 */
  clearDraft(teamId: string): AgentTeamRecord
  setArchived(teamId: string, archived: boolean): AgentTeamRecord
  /** 连同已发布版本一起删除；不存在时报 `storage.not_found`。 */
  remove(teamId: string): void
  /** 按版本号升序。 */
  versions(teamId: string): AgentTeamVersionRecord[]
  version(teamId: string, version: number): AgentTeamVersionRecord | undefined
  /** 版本号重复时报 `storage.conflict`。 */
  addVersion(input: AddAgentTeamVersionInput): AgentTeamVersionRecord
}

// ---------- 运行快照（M4-04） ----------

/**
 * 一次模型调用前的上下文快照。`data` 是已解析的 `RunSnapshot` JSON；写入方负责脱敏与截断。
 * 每个运行最多保留最近 20 份。
 */
export interface RunSnapshotRecord {
  readonly snapshotId: string
  readonly sessionId: string
  readonly runId: string
  readonly parentRunId?: string
  readonly turnId?: string
  readonly stepId?: string
  readonly createdAt: number
  readonly tokens: number
  readonly data: unknown
}

export interface AddRunSnapshotInput {
  readonly snapshotId: string
  readonly sessionId: string
  readonly runId: string
  readonly parentRunId?: string
  readonly turnId?: string
  readonly stepId?: string
  readonly tokens: number
  readonly data: unknown
}

export interface RunSnapshotStore {
  /** 会话不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。 */
  add(input: AddRunSnapshotInput): RunSnapshotRecord
  /** 按时间从旧到新；`limit` 默认 20。 */
  list(runId: string, limit?: number): RunSnapshotRecord[]
}

// ---------- 改动集（M4-09） ----------

/**
 * 一个改动集（M4-09，ADR-0031）：一次隔离工作区中的委派产生的文件级改动。
 * `baseCommit` 是隔离工作区创建时的基线提交，`gitDir` 是保存该提交的影子仓库，
 * `workspacePath` 是隔离目录；合并到主工作区后 `checkpointCommit` 指向合并前的检查点。
 */
export interface ChangeSetRecord {
  readonly changeSetId: string
  readonly sessionId: string
  /** 产生改动的子运行。 */
  readonly runId: string
  /** 发起委派的运行；事件与界面按它归属。 */
  readonly parentRunId?: string
  readonly baseCommit: string
  /** 基线快照的创建时间；旧数据没有这个字段。 */
  readonly baseCreatedAt?: number
  readonly gitDir: string
  readonly workspacePath: string
  readonly status: ChangeSetStatus
  readonly createdAt: number
  readonly mergedAt?: number
  readonly checkpointCommit?: string
}

export interface CreateChangeSetInput {
  readonly changeSetId: string
  readonly sessionId: string
  readonly runId: string
  readonly parentRunId?: string
  readonly baseCommit: string
  readonly baseCreatedAt?: number
  readonly gitDir: string
  readonly workspacePath: string
}

/**
 * 改动集中的一个文件。`patch` 是文本文件的 unified diff；二进制与超大文件没有。
 * `baseHash` 是基线内容的 blob 哈希（新增文件没有），`contentHash` 是子运行版本的 blob 哈希
 * （删除的文件没有）。哈希指向主进程的 blob 存储。
 */
export interface ChangeSetFileRecord {
  readonly changeSetId: string
  readonly path: string
  readonly status: ChangeSetFileStatus
  readonly kind: ChangeSetFileKind
  readonly added: number
  readonly removed: number
  readonly patch?: string
  readonly binary: boolean
  readonly large: boolean
  readonly baseHash?: string
  readonly contentHash?: string
}

export interface AddChangeSetFileInput {
  readonly changeSetId: string
  readonly path: string
  readonly kind: ChangeSetFileKind
  readonly added: number
  readonly removed: number
  readonly patch?: string
  readonly binary: boolean
  readonly large: boolean
  readonly baseHash?: string
  readonly contentHash?: string
}

export interface ChangeSetStore {
  /** 会话不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。状态为 `pending`。 */
  create(input: CreateChangeSetInput): ChangeSetRecord
  get(changeSetId: string): ChangeSetRecord | undefined
  /** 会话的改动集，按创建顺序。 */
  listBySession(sessionId: string): ChangeSetRecord[]
  /** 不存在时报 `storage.not_found`。合并时同时记录 `mergedAt`。 */
  setStatus(changeSetId: string, status: ChangeSetStatus): ChangeSetRecord
  /** 记录合并前的检查点；不存在时报 `storage.not_found`。 */
  setCheckpointCommit(changeSetId: string, commit: string): ChangeSetRecord
  /** 改动集不存在、或同一路径重复时报 `storage.conflict`。状态为 `pending`。 */
  addFile(input: AddChangeSetFileInput): ChangeSetFileRecord
  /** 按路径升序。 */
  listFiles(changeSetId: string): ChangeSetFileRecord[]
  /** 改动集或文件不存在时报 `storage.not_found`。 */
  setFileStatus(changeSetId: string, path: string, status: ChangeSetFileStatus): ChangeSetFileRecord
}

// ---------- 自动修复监视（M8-02） ----------

export type AutoFixTrigger = 'ci' | 'conflict' | 'comment'

export type AutoFixJobStatus =
  | 'queued'
  | 'running'
  /** 修复已完成，改动留在监视工作区，等待人工检查或推送（M8-02 不自动推送）。 */
  | 'ready'
  /** 已推送到 PR 的 head 分支，等待新一轮检查。 */
  | 'pushed'
  /** 推送后的检查通过。 */
  | 'passed'
  | 'failed'
  | 'gave_up'
  | 'cancelled'

export interface PullRequestWatchRecord {
  readonly watchId: string
  /** `owner/name`。 */
  readonly repo: string
  readonly prNumber: number
  /** 本地仓库路径；监视工作区从这里取提交。 */
  readonly projectPath: string
  readonly triggers: readonly AutoFixTrigger[]
  readonly maxAttempts: number
  readonly enabled: boolean
  /** 已经开始的修复次数。 */
  readonly attempts: number
  readonly lastSignature?: string
  /** 已经处理过的最新评审意见 id；省略表示还没建立基线（只处理之后的新意见，M8-04）。 */
  readonly lastCommentId?: number
  readonly lastEvaluatedAt?: number
  readonly createdAt: number
}

export interface CreateWatchInput {
  readonly watchId: string
  readonly repo: string
  readonly prNumber: number
  readonly projectPath: string
  readonly triggers: readonly AutoFixTrigger[]
  readonly maxAttempts: number
}

export interface UpdateWatchInput {
  readonly enabled?: boolean
  readonly triggers?: readonly AutoFixTrigger[]
  readonly maxAttempts?: number
  readonly attempts?: number
  /** `null` 清除记录（例如手动重新评估）。 */
  readonly lastSignature?: string | null
  /** 已处理过的最新评审意见 id（M8-04）。 */
  readonly lastCommentId?: number
  readonly lastEvaluatedAt?: number
}

export interface AutoFixJobRecord {
  readonly jobId: string
  readonly watchId: string
  readonly sessionId?: string
  readonly trigger: AutoFixTrigger
  readonly signature: string
  readonly status: AutoFixJobStatus
  /** 第几次修复，从 1 开始。 */
  readonly attempt: number
  readonly detail?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateAutoFixJobInput {
  readonly jobId: string
  readonly watchId: string
  readonly trigger: AutoFixTrigger
  readonly signature: string
  readonly status: AutoFixJobStatus
  readonly attempt: number
  readonly sessionId?: string
}

export interface UpdateAutoFixJobInput {
  readonly status?: AutoFixJobStatus
  readonly sessionId?: string
  /** `null` 清除说明。 */
  readonly detail?: string | null
}

export interface AutoFixStore {
  readonly watches: {
    /** 按创建顺序。 */
    list(): PullRequestWatchRecord[]
    get(watchId: string): PullRequestWatchRecord | undefined
    findByPullRequest(repo: string, prNumber: number): PullRequestWatchRecord | undefined
    /** id 或 `repo + prNumber` 重复时报 `storage.conflict`。 */
    create(input: CreateWatchInput): PullRequestWatchRecord
    /** 不存在时报 `storage.not_found`。 */
    update(watchId: string, patch: UpdateWatchInput): PullRequestWatchRecord
    /** 同时删除该监视的任务记录；不存在时报 `storage.not_found`。 */
    remove(watchId: string): void
  }
  readonly jobs: {
    create(input: CreateAutoFixJobInput): AutoFixJobRecord
    /** 不存在时报 `storage.not_found`。 */
    update(jobId: string, patch: UpdateAutoFixJobInput): AutoFixJobRecord
    get(jobId: string): AutoFixJobRecord | undefined
    /** 会话对应的任务（自动修复会话一个会话只有一个任务）。 */
    getBySession(sessionId: string): AutoFixJobRecord | undefined
    /** 新的在前；`watchId` 省略时返回全部。 */
    list(options?: { readonly watchId?: string; readonly limit?: number }): AutoFixJobRecord[]
    /** 该监视排队或运行中的任务（每个监视最多一个）。 */
    activeForWatch(watchId: string): AutoFixJobRecord | undefined
    /** 应用启动时把上次遗留的排队/运行中任务标记为失败，返回处理的数量。 */
    interruptActive(): number
  }
}

// ---------- 汇总 ----------

export interface BackgroundCommandStore {
  create(record: BackgroundCommand): BackgroundCommand
  get(commandId: string): BackgroundCommand | undefined
  list(): BackgroundCommand[]
  finish(
    commandId: string,
    status: BackgroundCommand['status'],
    exitCode: number | null,
    endedAt: number,
  ): BackgroundCommand
  saveOutput(commandId: string, output: BackgroundCommandOutput): void
  output(commandId: string): BackgroundCommandOutput | undefined
}

export interface Storage {
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly providers: ProviderStore
  readonly events: EventStore
  readonly changes: FileChangeStore
  readonly permissionRules: PermissionRuleStore
  readonly memories: MemoryStore
  readonly skillPrefs: SkillPrefStore
  readonly mcpServers: McpServerStore
  readonly mcpToolPrefs: McpToolPrefStore
  readonly agents: AgentStore
  readonly teams: AgentTeamStore
  readonly runSnapshots: RunSnapshotStore
  readonly changeSets: ChangeSetStore
  readonly commands: BackgroundCommandStore
  /** 自动修复监视与任务（M8-02）。 */
  readonly autoFix: AutoFixStore
  /** 在一个事务中执行 `fn`；抛错时其中的所有写入回滚，错误原样抛出。可以嵌套。 */
  transaction<T>(fn: () => T): T
  /**
   * 把数据库的一致快照写入新文件（SQLite `VACUUM INTO`）。目标文件必须不存在；
   * 用于自动更新前的数据备份（M5-06，ADR-0036）。
   */
  backup(file: string): void
  close(): void
}

export interface StorageOptions {
  /** 时间来源，默认 `Date.now`。 */
  readonly now?: () => number
}
