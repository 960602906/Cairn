/**
 * SQLite 存储实现（ADR-0006，引擎 better-sqlite3，S4）。与内存实现通过同一套契约测试。
 *
 * 打开时先执行迁移（`migrateDatabase`），再以 WAL 模式打开连接。只有主进程使用。
 */
import {
  isLiveEventType,
  type ChangeSetFileKind,
  type ChangeSetFileStatus,
  type ChangeSetStatus,
  type BackgroundCommand,
  type BackgroundCommandOutput,
  type FileChangeKind,
  type FileChangeStatus,
  type PermissionRule,
  type PersistedEvent,
  type ProviderConfig,
  type SkillSource,
  type McpAuthKind,
  type McpServerKind,
  type PermissionEffect,
  type ToolCategory,
} from '@cairn/protocol'
import Database from 'better-sqlite3'
import {
  StorageError,
  StorageErrorCode,
  type AddChangeSetFileInput,
  type AddPermissionRuleInput,
  type AddRunSnapshotInput,
  type AgentRecord,
  type AgentVersionRecord,
  type ChangeSetFileRecord,
  type ChangeSetRecord,
  type CreateChangeSetInput,
  type CreateFileChangeInput,
  type FileChangeRecord,
  type HunkRecord,
  type ListSessionsOptions,
  type McpEnvRef,
  type McpServerRecord,
  type McpToolPref,
  type PermissionRuleRecord,
  type ProjectRecord,
  type RunSnapshotRecord,
  type SessionRecord,
  type SkillPref,
  type Storage,
  type StorageOptions,
} from '../types.js'
import { checkPermissionRuleOwner } from '../permission-rules.js'
import { migrateDatabase, type MigrateResult, type Migration } from './migrate.js'
import { MIGRATIONS } from './migrations/index.js'

export interface SqliteStorageOptions extends StorageOptions {
  /** 数据库文件路径（架构 §14.1）。 */
  readonly file: string
  /** 默认为应用的全部迁移；测试可替换。 */
  readonly migrations?: readonly Migration[]
}

export interface SqliteStorage extends Storage {
  /** 打开时执行迁移的结果。 */
  readonly migration: MigrateResult
}

interface ProjectRow {
  project_id: string
  name: string
  path: string
  created_at: number
  read_agents_md: number
  enable_project_skills: number
  pinned_at: number | null
  archived_at: number | null
  removed_at: number | null
}

interface SessionRow {
  session_id: string
  project_id: string
  project_path: string
  workspace_path: string
  title: string
  archived: number
  kind: SessionRecord['kind']
  trial_agent_id: string | null
  trial_draft_hash: string | null
  model_provider_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

interface SkillPrefRow {
  scope: string
  source: SkillSource
  name: string
  enabled: number
  pinned: number
}

interface ProviderRow {
  provider_id: string
  position: number
  kind: ProviderConfig['kind']
  display_name: string
  base_url: string
  credential_ref: string | null
  template: string | null
  compat: string | null
  models: string
  updated_at: number
}

interface EventRow {
  session_id: string
  seq: number
  run_id: string
  parent_run_id: string | null
  turn_id: string | null
  step_id: string | null
  type: string
  v: number
  ts: number
  payload: string
}

interface FileChangeRow {
  change_id: string
  session_id: string
  run_id: string | null
  turn_id: string | null
  tool_call_id: string | null
  path: string
  kind: FileChangeKind
  before_hash: string | null
  after_hash: string | null
  revert_of: string | null
  status: FileChangeStatus
  added: number
  removed: number
  created_at: number
}

interface HunkRow {
  change_id: string
  position: number
  old_start: number
  old_lines: number
  new_start: number
  new_lines: number
  status: FileChangeStatus
}

interface PermissionRuleRow {
  rule_id: string
  scope: PermissionRule['scope']
  project_id: string | null
  session_id: string | null
  effect: PermissionRule['effect']
  match: string
  source: PermissionRule['source']
  created_at: number
}

interface McpServerRow {
  server_id: string
  name: string
  kind: McpServerKind
  command: string | null
  args: string
  cwd: string | null
  url: string | null
  auth: McpAuthKind
  header_name: string | null
  credential_ref: string | null
  env: string
  enabled: number
  created_at: number
  updated_at: number
}

interface McpToolPrefRow {
  server_id: string
  name: string
  category: ToolCategory
  effect: PermissionEffect
}

interface AgentRow {
  agent_id: string
  source: string
  archived: number
  draft: string | null
  created_at: number
  updated_at: number
}

interface RunSnapshotRow {
  snapshot_id: string
  session_id: string
  run_id: string
  parent_run_id: string | null
  turn_id: string | null
  step_id: string | null
  created_at: number
  tokens: number
  data: string
}

interface AgentVersionRow {
  agent_id: string
  version: number
  definition: string
  published_at: number
}

interface ChangeSetRow {
  change_set_id: string
  session_id: string
  run_id: string
  parent_run_id: string | null
  base_commit: string
  base_created_at: number | null
  git_dir: string
  workspace_path: string
  status: ChangeSetStatus
  created_at: number
  merged_at: number | null
  checkpoint_commit: string | null
}

interface ChangeSetFileRow {
  change_set_id: string
  path: string
  status: ChangeSetFileStatus
  kind: ChangeSetFileKind
  added: number
  removed: number
  patch: string | null
  binary: number
  large: number
  base_hash: string | null
  content_hash: string | null
}

const toChangeSet = (row: ChangeSetRow): ChangeSetRecord => ({
  changeSetId: row.change_set_id,
  sessionId: row.session_id,
  runId: row.run_id,
  ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
  baseCommit: row.base_commit,
  ...(row.base_created_at === null ? {} : { baseCreatedAt: row.base_created_at }),
  gitDir: row.git_dir,
  workspacePath: row.workspace_path,
  status: row.status,
  createdAt: row.created_at,
  ...(row.merged_at === null ? {} : { mergedAt: row.merged_at }),
  ...(row.checkpoint_commit === null ? {} : { checkpointCommit: row.checkpoint_commit }),
})

const toChangeSetFile = (row: ChangeSetFileRow): ChangeSetFileRecord => ({
  changeSetId: row.change_set_id,
  path: row.path,
  status: row.status,
  kind: row.kind,
  added: row.added,
  removed: row.removed,
  ...(row.patch === null ? {} : { patch: row.patch }),
  binary: row.binary === 1,
  large: row.large === 1,
  ...(row.base_hash === null ? {} : { baseHash: row.base_hash }),
  ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
})

const toAgent = (row: AgentRow): AgentRecord => ({
  agentId: row.agent_id,
  source: row.source as AgentRecord['source'],
  archived: row.archived !== 0,
  ...(row.draft === null ? {} : { draft: JSON.parse(row.draft) as unknown }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAgentVersion = (row: AgentVersionRow): AgentVersionRecord => ({
  agentId: row.agent_id,
  version: row.version,
  definition: JSON.parse(row.definition) as unknown,
  publishedAt: row.published_at,
})

const toRunSnapshot = (row: RunSnapshotRow): RunSnapshotRecord => ({
  snapshotId: row.snapshot_id,
  sessionId: row.session_id,
  runId: row.run_id,
  ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  ...(row.step_id === null ? {} : { stepId: row.step_id }),
  createdAt: row.created_at,
  tokens: row.tokens,
  data: JSON.parse(row.data) as unknown,
})

const toPermissionRule = (row: PermissionRuleRow): PermissionRuleRecord => ({
  rule: {
    id: row.rule_id,
    scope: row.scope,
    effect: row.effect,
    match: JSON.parse(row.match) as PermissionRule['match'],
    source: row.source,
  },
  ...(row.project_id === null ? {} : { projectId: row.project_id }),
  ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  createdAt: row.created_at,
})

const toHunk = (row: HunkRow): HunkRecord => ({
  oldStart: row.old_start,
  oldLines: row.old_lines,
  newStart: row.new_start,
  newLines: row.new_lines,
  status: row.status,
})

const toFileChange = (row: FileChangeRow, hunks: readonly HunkRow[]): FileChangeRecord => ({
  changeId: row.change_id,
  sessionId: row.session_id,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
  path: row.path,
  kind: row.kind,
  ...(row.before_hash === null ? {} : { beforeHash: row.before_hash }),
  ...(row.after_hash === null ? {} : { afterHash: row.after_hash }),
  ...(row.revert_of === null ? {} : { revertOf: row.revert_of }),
  status: row.status,
  added: row.added,
  removed: row.removed,
  hunks: hunks.map(toHunk),
  createdAt: row.created_at,
})

const toProject = (row: ProjectRow): ProjectRecord => ({
  projectId: row.project_id,
  name: row.name,
  path: row.path,
  createdAt: row.created_at,
  readAgentsMd: row.read_agents_md === 1,
  enableProjectSkills: row.enable_project_skills === 1,
  ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
  ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
})

const toSession = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  projectId: row.project_id,
  projectPath: row.project_path,
  workspacePath: row.workspace_path,
  title: row.title,
  archived: row.archived === 1,
  kind: row.kind,
  ...(row.trial_agent_id === null ? {} : { trialAgentId: row.trial_agent_id }),
  ...(row.trial_draft_hash === null ? {} : { trialDraftHash: row.trial_draft_hash }),
  ...(row.model_provider_id === null || row.model_id === null
    ? {}
    : { model: { providerId: row.model_provider_id, modelId: row.model_id } }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toProvider = (row: ProviderRow): ProviderConfig => ({
  id: row.provider_id,
  kind: row.kind,
  displayName: row.display_name,
  baseUrl: row.base_url,
  ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }),
  ...(row.template === null ? {} : { template: row.template }),
  ...(row.compat === null ? {} : { compat: JSON.parse(row.compat) as ProviderConfig['compat'] }),
  models: JSON.parse(row.models) as ProviderConfig['models'],
})

const toEvent = (row: EventRow): PersistedEvent =>
  ({
    v: row.v,
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    ts: row.ts,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
  }) as PersistedEvent

const toMcpServer = (row: McpServerRow): McpServerRecord => ({
  serverId: row.server_id,
  name: row.name,
  kind: row.kind,
  ...(row.command === null ? {} : { command: row.command }),
  args: JSON.parse(row.args) as string[],
  ...(row.cwd === null ? {} : { cwd: row.cwd }),
  ...(row.url === null ? {} : { url: row.url }),
  auth: row.auth,
  ...(row.header_name === null ? {} : { headerName: row.header_name }),
  ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }),
  env: JSON.parse(row.env) as McpEnvRef[],
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toMcpToolPref = (row: McpToolPrefRow): McpToolPref => ({
  serverId: row.server_id,
  name: row.name,
  category: row.category,
  effect: row.effect,
})

export function openSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  const now = options.now ?? Date.now
  const migration = migrateDatabase({
    file: options.file,
    migrations: options.migrations ?? MIGRATIONS,
    now,
  })

  const db = new Database(options.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const q = {
    projectById: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE project_id = ?'),
    projectByPath: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE path = ?'),
    projects: db.prepare<[], ProjectRow>(
      'SELECT * FROM projects WHERE removed_at IS NULL ORDER BY created_at DESC, project_id',
    ),
    insertProject: db.prepare(
      `INSERT INTO projects
         (project_id, name, path, created_at, read_agents_md, enable_project_skills)
       VALUES (@projectId, @name, @path, @createdAt, 1, 1)`,
    ),
    updateProject: db.prepare(
      `UPDATE projects SET
         name = coalesce(@name, name),
         read_agents_md = coalesce(@readAgentsMd, read_agents_md),
         enable_project_skills = coalesce(@enableSkills, enable_project_skills),
         pinned_at = CASE WHEN @pinChanged = 1 THEN @pinnedAt ELSE pinned_at END,
         archived_at = CASE WHEN @archiveChanged = 1 THEN @archivedAt ELSE archived_at END
       WHERE project_id = @projectId AND removed_at IS NULL`,
    ),
    removeProject: db.prepare(
      'UPDATE projects SET removed_at = @at WHERE project_id = @projectId AND removed_at IS NULL',
    ),
    restoreProject: db.prepare(
      'UPDATE projects SET removed_at = NULL WHERE project_id = @projectId',
    ),
    sessionById: db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_id = ?'),
    sessions: db.prepare<
      { projectId: string | null; includeArchived: number; includeTrial: number },
      SessionRow
    >(
      `SELECT * FROM sessions
       WHERE (@includeArchived = 1 OR archived = 0)
         AND (@includeTrial = 1 OR kind = 'normal')
         AND (@projectId IS NULL OR project_id = @projectId)
       ORDER BY updated_at DESC, session_id`,
    ),
    insertSession: db.prepare(
      `INSERT INTO sessions
         (session_id, project_id, project_path, workspace_path, title, archived,
          kind, trial_agent_id, trial_draft_hash,
          model_provider_id, model_id, created_at, updated_at)
       VALUES (@sessionId, @projectId, @projectPath, @workspacePath, @title, 0,
          @kind, @trialAgentId, @trialDraftHash,
          @modelProviderId, @modelId, @at, @at)`,
    ),
    setSessionModel: db.prepare(
      `UPDATE sessions SET model_provider_id = @providerId, model_id = @modelId, updated_at = @at
       WHERE session_id = @sessionId`,
    ),
    updateSession: db.prepare(
      `UPDATE sessions SET
         title = coalesce(@title, title),
         archived = max(archived, @archived),
         updated_at = @at
       WHERE session_id = @sessionId`,
    ),
    deleteSessionEvents: db.prepare('DELETE FROM events WHERE session_id = ?'),
    deleteSessionFileChanges: db.prepare('DELETE FROM file_changes WHERE session_id = ?'),
    deleteSessionPermissionRules: db.prepare('DELETE FROM permission_rules WHERE session_id = ?'),
    deleteSessionRuns: db.prepare('DELETE FROM agent_runs WHERE session_id = ?'),
    deleteSessionSnapshots: db.prepare('DELETE FROM run_snapshots WHERE session_id = ?'),
    deleteSessionChangeSets: db.prepare('DELETE FROM change_sets WHERE session_id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE session_id = ?'),
    providers: db.prepare<[], ProviderRow>('SELECT * FROM provider_configs ORDER BY position'),
    providerById: db.prepare<[string], ProviderRow>(
      'SELECT * FROM provider_configs WHERE provider_id = ?',
    ),
    deleteProviders: db.prepare('DELETE FROM provider_configs'),
    insertProvider: db.prepare(
      `INSERT INTO provider_configs
         (provider_id, position, kind, display_name, base_url, credential_ref, template, compat,
          models, updated_at)
       VALUES (@id, @position, @kind, @displayName, @baseUrl, @credentialRef, @template, @compat,
          @models, @at)`,
    ),
    maxSeq: db.prepare<[string], { seq: number | null }>(
      'SELECT max(seq) AS seq FROM events WHERE session_id = ?',
    ),
    insertEvent: db.prepare(
      `INSERT INTO events (session_id, seq, run_id, parent_run_id, turn_id, step_id, type, v, ts, payload)
       VALUES (@sessionId, @seq, @runId, @parentRunId, @turnId, @stepId, @type, @v, @ts, @payload)`,
    ),
    readAfter: db.prepare<[string, number, number], EventRow>(
      'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),
    changeById: db.prepare<[string], FileChangeRow>(
      'SELECT * FROM file_changes WHERE change_id = ?',
    ),
    changesBySession: db.prepare<[string], FileChangeRow>(
      'SELECT * FROM file_changes WHERE session_id = ? ORDER BY rowid',
    ),
    hunksByChange: db.prepare<[string], HunkRow>(
      'SELECT * FROM hunks WHERE change_id = ? ORDER BY position',
    ),
    hunksBySession: db.prepare<[string], HunkRow>(
      `SELECT h.* FROM hunks h JOIN file_changes c ON c.change_id = h.change_id
       WHERE c.session_id = ? ORDER BY h.change_id, h.position`,
    ),
    insertChange: db.prepare(
      `INSERT INTO file_changes
         (change_id, session_id, run_id, turn_id, tool_call_id, path, kind, before_hash,
          after_hash, revert_of, status, added, removed, created_at)
       VALUES (@changeId, @sessionId, @runId, @turnId, @toolCallId, @path, @kind, @beforeHash,
          @afterHash, @revertOf, 'pending', @added, @removed, @at)`,
    ),
    insertHunk: db.prepare(
      `INSERT INTO hunks (change_id, position, old_start, old_lines, new_start, new_lines, status)
       VALUES (@changeId, @position, @oldStart, @oldLines, @newStart, @newLines, 'pending')`,
    ),
    setChangeStatus: db.prepare('UPDATE file_changes SET status = ? WHERE change_id = ?'),
    ruleById: db.prepare<[string], PermissionRuleRow>(
      'SELECT * FROM permission_rules WHERE rule_id = ?',
    ),
    rules: db.prepare<{ projectId: string | null; sessionId: string | null }, PermissionRuleRow>(
      `SELECT * FROM permission_rules
       WHERE scope = 'global'
          OR (scope = 'project' AND project_id = @projectId)
          OR (scope = 'session' AND session_id = @sessionId)
       ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, rowid`,
    ),
    insertRule: db.prepare(
      `INSERT INTO permission_rules
         (rule_id, scope, project_id, session_id, effect, match, source, created_at)
       VALUES (@ruleId, @scope, @projectId, @sessionId, @effect, @match, @source, @at)`,
    ),
    deleteRule: db.prepare('DELETE FROM permission_rules WHERE rule_id = ?'),
    setHunkStatus: db.prepare('UPDATE hunks SET status = ? WHERE change_id = ?'),
    setHunkAt: db.prepare('UPDATE hunks SET status = ? WHERE change_id = ? AND position = ?'),
    skillPref: db.prepare<[string, string, string], SkillPrefRow>(
      'SELECT * FROM skill_prefs WHERE scope = ? AND source = ? AND name = ?',
    ),
    skillPrefsByScope: db.prepare<[string], SkillPrefRow>(
      'SELECT * FROM skill_prefs WHERE scope = ? ORDER BY source, name',
    ),
    upsertSkillPref: db.prepare(
      `INSERT INTO skill_prefs (scope, source, name, enabled, pinned)
       VALUES (@scope, @source, @name, @enabled, @pinned)
       ON CONFLICT (scope, source, name) DO UPDATE SET
         enabled = excluded.enabled,
         pinned = excluded.pinned`,
    ),
    deleteSkillPref: db.prepare(
      'DELETE FROM skill_prefs WHERE scope = ? AND source = ? AND name = ?',
    ),
    mcpServers: db.prepare<[], McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at'),
    mcpServerById: db.prepare<[string], McpServerRow>(
      'SELECT * FROM mcp_servers WHERE server_id = ?',
    ),
    insertMcpServer: db.prepare(
      `INSERT INTO mcp_servers
         (server_id, name, kind, command, args, cwd, url, auth, header_name, credential_ref,
          env, enabled, created_at, updated_at)
       VALUES (@serverId, @name, @kind, @command, @args, @cwd, @url, @auth, @headerName,
          @credentialRef, @env, @enabled, @at, @at)`,
    ),
    updateMcpServer: db.prepare(
      `UPDATE mcp_servers SET
         name = @name, kind = @kind, command = @command, args = @args, cwd = @cwd,
         url = @url, auth = @auth, header_name = @headerName, credential_ref = @credentialRef,
         env = @env, enabled = @enabled, updated_at = @at
       WHERE server_id = @serverId`,
    ),
    deleteMcpServer: db.prepare('DELETE FROM mcp_servers WHERE server_id = ?'),
    agents: db.prepare<[], AgentRow>('SELECT * FROM agents ORDER BY created_at'),
    agentById: db.prepare<[string], AgentRow>('SELECT * FROM agents WHERE agent_id = ?'),
    insertAgent: db.prepare(
      `INSERT INTO agents (agent_id, source, archived, draft, created_at, updated_at)
       VALUES (@agentId, @source, 0, @draft, @at, @at)`,
    ),
    setAgentDraft: db.prepare(
      'UPDATE agents SET draft = @draft, updated_at = @at WHERE agent_id = @agentId',
    ),
    setAgentArchived: db.prepare(
      'UPDATE agents SET archived = @archived, updated_at = @at WHERE agent_id = @agentId',
    ),
    deleteAgent: db.prepare('DELETE FROM agents WHERE agent_id = ?'),
    deleteAgentVersions: db.prepare('DELETE FROM agent_versions WHERE agent_id = ?'),
    agentVersions: db.prepare<[string], AgentVersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version',
    ),
    agentVersion: db.prepare<[string, number], AgentVersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?',
    ),
    insertAgentVersion: db.prepare(
      `INSERT INTO agent_versions (agent_id, version, definition, published_at)
       VALUES (@agentId, @version, @definition, @at)`,
    ),
    mcpToolPrefs: db.prepare<[string], McpToolPrefRow>(
      'SELECT * FROM mcp_tool_prefs WHERE server_id = ? ORDER BY name',
    ),
    mcpToolPref: db.prepare<[string, string], McpToolPrefRow>(
      'SELECT * FROM mcp_tool_prefs WHERE server_id = ? AND name = ?',
    ),
    upsertMcpToolPref: db.prepare(
      `INSERT INTO mcp_tool_prefs (server_id, name, category, effect)
       VALUES (@serverId, @name, @category, @effect)
       ON CONFLICT (server_id, name) DO UPDATE SET
         category = excluded.category,
         effect = excluded.effect`,
    ),
    deleteMcpToolPrefs: db.prepare('DELETE FROM mcp_tool_prefs WHERE server_id = ?'),
    runSnapshotById: db.prepare<[string], RunSnapshotRow>(
      'SELECT * FROM run_snapshots WHERE snapshot_id = ?',
    ),
    insertRunSnapshot: db.prepare(
      `INSERT INTO run_snapshots
         (snapshot_id, session_id, run_id, parent_run_id, turn_id, step_id, created_at, tokens, data)
       VALUES (@snapshotId, @sessionId, @runId, @parentRunId, @turnId, @stepId, @at, @tokens, @data)`,
    ),
    runSnapshotsByRun: db.prepare<[string, number], RunSnapshotRow>(
      'SELECT * FROM run_snapshots WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?',
    ),
    pruneRunSnapshots: db.prepare(
      `DELETE FROM run_snapshots WHERE run_id = @runId AND snapshot_id NOT IN (
         SELECT snapshot_id FROM run_snapshots WHERE run_id = @runId
         ORDER BY created_at DESC, rowid DESC LIMIT 20
       )`,
    ),
    changeSetById: db.prepare<[string], ChangeSetRow>(
      'SELECT * FROM change_sets WHERE change_set_id = ?',
    ),
    changeSetsBySession: db.prepare<[string], ChangeSetRow>(
      'SELECT * FROM change_sets WHERE session_id = ? ORDER BY created_at, rowid',
    ),
    insertChangeSet: db.prepare(
      `INSERT INTO change_sets
         (change_set_id, session_id, run_id, parent_run_id, base_commit, base_created_at, git_dir,
          workspace_path, status, created_at, merged_at, checkpoint_commit)
       VALUES (@changeSetId, @sessionId, @runId, @parentRunId, @baseCommit, @baseCreatedAt, @gitDir,
         @workspacePath, @status, @createdAt, NULL, NULL)`,
    ),
    setChangeSetStatus: db.prepare(
      `UPDATE change_sets
       SET status = @status,
           merged_at = CASE WHEN @status = 'applied' THEN @at ELSE merged_at END
       WHERE change_set_id = @changeSetId`,
    ),
    setChangeSetCheckpoint: db.prepare(
      'UPDATE change_sets SET checkpoint_commit = @commit WHERE change_set_id = @changeSetId',
    ),
    changeSetFiles: db.prepare<[string], ChangeSetFileRow>(
      'SELECT * FROM change_set_files WHERE change_set_id = ? ORDER BY path',
    ),
    changeSetFile: db.prepare<[string, string], ChangeSetFileRow>(
      'SELECT * FROM change_set_files WHERE change_set_id = ? AND path = ?',
    ),
    insertChangeSetFile: db.prepare(
      `INSERT INTO change_set_files
         (change_set_id, path, status, kind, added, removed, patch, binary, large, base_hash,
          content_hash)
       VALUES (@changeSetId, @path, 'pending', @kind, @added, @removed, @patch, @binary, @large,
         @baseHash, @contentHash)`,
    ),
    setChangeSetFileStatus: db.prepare(
      `UPDATE change_set_files SET status = @status
       WHERE change_set_id = @changeSetId AND path = @path`,
    ),
  }

  const toSkillPref = (row: SkillPrefRow): SkillPref => ({
    scope: row.scope,
    source: row.source,
    name: row.name,
    enabled: row.enabled === 1,
    pinned: row.pinned === 1,
  })

  const updateSession = (
    sessionId: string,
    title: string | null,
    archived: 0 | 1,
  ): SessionRecord => {
    const { changes } = q.updateSession.run({ sessionId, title, archived, at: now() })
    if (changes === 0) throw new StorageError(StorageErrorCode.NotFound, { sessionId })
    return toSession(q.sessionById.get(sessionId)!)
  }

  const maxSeq = (sessionId: string): number => q.maxSeq.get(sessionId)?.seq ?? 0

  const addRunSnapshot = db.transaction((input: AddRunSnapshotInput): RunSnapshotRecord => {
    if (!q.sessionById.get(input.sessionId)) {
      throw new StorageError(StorageErrorCode.NotFound, { sessionId: input.sessionId })
    }
    if (q.runSnapshotById.get(input.snapshotId)) {
      throw new StorageError(StorageErrorCode.Conflict, { snapshotId: input.snapshotId })
    }
    q.insertRunSnapshot.run({
      snapshotId: input.snapshotId,
      sessionId: input.sessionId,
      runId: input.runId,
      parentRunId: input.parentRunId ?? null,
      turnId: input.turnId ?? null,
      stepId: input.stepId ?? null,
      at: now(),
      tokens: input.tokens,
      data: JSON.stringify(input.data),
    })
    q.pruneRunSnapshots.run({ runId: input.runId })
    return toRunSnapshot(q.runSnapshotById.get(input.snapshotId)!)
  })

  const replaceProviders = db.transaction((configs: readonly ProviderConfig[]) => {
    q.deleteProviders.run()
    const at = now()
    configs.forEach((config, position) => {
      if (q.providerById.get(config.id)) {
        throw new StorageError(StorageErrorCode.Conflict, { providerId: config.id })
      }
      q.insertProvider.run({
        id: config.id,
        position,
        kind: config.kind,
        displayName: config.displayName,
        baseUrl: config.baseUrl,
        credentialRef: config.credentialRef ?? null,
        template: config.template ?? null,
        compat: config.compat ? JSON.stringify(config.compat) : null,
        models: JSON.stringify(config.models),
        at,
      })
    })
  })

  const createChangeSet = db.transaction((input: CreateChangeSetInput): ChangeSetRecord => {
    if (!q.sessionById.get(input.sessionId)) {
      throw new StorageError(StorageErrorCode.NotFound, { sessionId: input.sessionId })
    }
    if (q.changeSetById.get(input.changeSetId)) {
      throw new StorageError(StorageErrorCode.Conflict, { changeSetId: input.changeSetId })
    }
    q.insertChangeSet.run({
      changeSetId: input.changeSetId,
      sessionId: input.sessionId,
      runId: input.runId,
      parentRunId: input.parentRunId ?? null,
      baseCommit: input.baseCommit,
      baseCreatedAt: input.baseCreatedAt ?? null,
      gitDir: input.gitDir,
      workspacePath: input.workspacePath,
      status: 'pending',
      createdAt: now(),
    })
    return toChangeSet(q.changeSetById.get(input.changeSetId)!)
  })

  const requireChangeSet = (changeSetId: string): ChangeSetRow => {
    const row = q.changeSetById.get(changeSetId)
    if (!row) throw new StorageError(StorageErrorCode.NotFound, { changeSetId })
    return row
  }

  const addChangeSetFile = db.transaction((input: AddChangeSetFileInput): ChangeSetFileRecord => {
    requireChangeSet(input.changeSetId)
    if (q.changeSetFile.get(input.changeSetId, input.path)) {
      throw new StorageError(StorageErrorCode.Conflict, {
        changeSetId: input.changeSetId,
        path: input.path,
      })
    }
    q.insertChangeSetFile.run({
      changeSetId: input.changeSetId,
      path: input.path,
      kind: input.kind,
      added: input.added,
      removed: input.removed,
      patch: input.patch ?? null,
      binary: input.binary ? 1 : 0,
      large: input.large ? 1 : 0,
      baseHash: input.baseHash ?? null,
      contentHash: input.contentHash ?? null,
    })
    return toChangeSetFile(q.changeSetFile.get(input.changeSetId, input.path)!)
  })

  const append = db.transaction((events: readonly PersistedEvent[]) => {
    const lastSeq = new Map<string, number>()
    for (const event of events) {
      if (isLiveEventType(event.type)) {
        throw new StorageError(StorageErrorCode.InvalidEvent, { type: event.type, seq: event.seq })
      }
      let last = lastSeq.get(event.sessionId)
      if (last === undefined) {
        if (!q.sessionById.get(event.sessionId)) {
          throw new StorageError(StorageErrorCode.InvalidEvent, { sessionId: event.sessionId })
        }
        last = maxSeq(event.sessionId)
      }
      // 严格递增，允许空缺（增量事件占用的 seq 不落库）
      if (event.seq <= last) {
        throw new StorageError(StorageErrorCode.SeqConflict, {
          sessionId: event.sessionId,
          after: last,
          actual: event.seq,
        })
      }
      q.insertEvent.run({
        sessionId: event.sessionId,
        seq: event.seq,
        runId: event.runId,
        parentRunId: event.parentRunId ?? null,
        turnId: event.turnId ?? null,
        stepId: event.stepId ?? null,
        type: event.type,
        v: event.v,
        ts: event.ts,
        payload: JSON.stringify(event.payload),
      })
      lastSeq.set(event.sessionId, event.seq)
    }
  })

  const getChange = (changeId: string): FileChangeRecord | undefined => {
    const row = q.changeById.get(changeId)
    return row && toFileChange(row, q.hunksByChange.all(changeId))
  }

  const createChange = db.transaction((input: CreateFileChangeInput): FileChangeRecord => {
    if (!q.sessionById.get(input.sessionId)) {
      throw new StorageError(StorageErrorCode.NotFound, { sessionId: input.sessionId })
    }
    if (q.changeById.get(input.changeId)) {
      throw new StorageError(StorageErrorCode.Conflict, { changeId: input.changeId })
    }
    if (input.revertOf !== undefined && !q.changeById.get(input.revertOf)) {
      throw new StorageError(StorageErrorCode.NotFound, { changeId: input.revertOf })
    }
    q.insertChange.run({
      changeId: input.changeId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      turnId: input.turnId ?? null,
      toolCallId: input.toolCallId ?? null,
      path: input.path,
      kind: input.kind,
      beforeHash: input.beforeHash ?? null,
      afterHash: input.afterHash ?? null,
      revertOf: input.revertOf ?? null,
      added: input.added,
      removed: input.removed,
      at: now(),
    })
    input.hunks.forEach((hunk, position) =>
      q.insertHunk.run({
        changeId: input.changeId,
        position,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      }),
    )
    return getChange(input.changeId)!
  })

  const setChangeStatus = db.transaction(
    (changeId: string, status: FileChangeStatus): FileChangeRecord => {
      const { changes } = q.setChangeStatus.run(status, changeId)
      if (changes === 0) throw new StorageError(StorageErrorCode.NotFound, { changeId })
      q.setHunkStatus.run(status, changeId)
      return getChange(changeId)!
    },
  )

  const setOneHunkStatus = db.transaction(
    (changeId: string, hunkIndex: number, status: FileChangeStatus): FileChangeRecord => {
      const current = getChange(changeId)
      if (!current || !Number.isInteger(hunkIndex) || hunkIndex < 0 || !current.hunks[hunkIndex]) {
        throw new StorageError(StorageErrorCode.NotFound, { changeId, hunkIndex })
      }
      q.setHunkAt.run(status, changeId, hunkIndex)
      const next = getChange(changeId)!
      const allReverted = next.hunks.every((hunk) => hunk.status === 'reverted')
      const changeStatus = allReverted
        ? 'reverted'
        : next.status === 'reverted'
          ? 'pending'
          : next.status
      if (changeStatus !== next.status) q.setChangeStatus.run(changeStatus, changeId)
      return changeStatus === next.status ? next : getChange(changeId)!
    },
  )

  const addRule = db.transaction((input: AddPermissionRuleInput): PermissionRuleRecord => {
    checkPermissionRuleOwner(input)
    const { rule } = input
    if (input.projectId !== undefined && !q.projectById.get(input.projectId)) {
      throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
    }
    if (input.sessionId !== undefined && !q.sessionById.get(input.sessionId)) {
      throw new StorageError(StorageErrorCode.NotFound, { sessionId: input.sessionId })
    }
    if (q.ruleById.get(rule.id)) {
      throw new StorageError(StorageErrorCode.Conflict, { ruleId: rule.id })
    }
    q.insertRule.run({
      ruleId: rule.id,
      scope: rule.scope,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      effect: rule.effect,
      match: JSON.stringify(rule.match),
      source: rule.source,
      at: now(),
    })
    return toPermissionRule(q.ruleById.get(rule.id)!)
  })

  const backgroundCommand = (commandId: string): BackgroundCommand | undefined => {
    const row = db
      .prepare<
        [string],
        {
          command_id: string
          session_id: string
          run_id: string
          command: string
          cwd: string
          started_at: number
          ended_at: number | null
          exit_code: number | null
          status: BackgroundCommand['status']
        }
      >(
        `SELECT command_id, session_id, run_id, command, cwd, started_at, ended_at, exit_code, status
      FROM background_commands WHERE command_id = ?`,
      )
      .get(commandId)
    if (!row) return undefined
    return {
      commandId: row.command_id,
      sessionId: row.session_id,
      runId: row.run_id,
      command: row.command,
      cwd: row.cwd,
      startedAt: row.started_at,
      status: row.status,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.exit_code === null && row.ended_at === null ? {} : { exitCode: row.exit_code }),
    }
  }

  return {
    migration,

    projects: {
      create(input) {
        if (q.projectById.get(input.projectId)) {
          throw new StorageError(StorageErrorCode.Conflict, { projectId: input.projectId })
        }
        if (q.projectByPath.get(input.path)) {
          throw new StorageError(StorageErrorCode.Conflict, { path: input.path })
        }
        q.insertProject.run({ ...input, createdAt: now() })
        return toProject(q.projectById.get(input.projectId)!)
      },
      get(projectId) {
        const row = q.projectById.get(projectId)
        return row && toProject(row)
      },
      getByPath(path) {
        const row = q.projectByPath.get(path)
        return row && toProject(row)
      },
      list: () => q.projects.all().map(toProject),
      update(projectId, patch) {
        const at = now()
        const info = q.updateProject.run({
          projectId,
          name: patch.name ?? null,
          readAgentsMd: patch.readAgentsMd === undefined ? null : patch.readAgentsMd ? 1 : 0,
          enableSkills:
            patch.enableProjectSkills === undefined ? null : patch.enableProjectSkills ? 1 : 0,
          pinChanged: patch.pinned === undefined ? 0 : 1,
          pinnedAt: patch.pinned ? at : null,
          archiveChanged: patch.archived === undefined ? 0 : 1,
          archivedAt: patch.archived ? at : null,
        })
        if (info.changes === 0) throw new StorageError(StorageErrorCode.NotFound, { projectId })
        return toProject(q.projectById.get(projectId)!)
      },
      remove(projectId) {
        const info = q.removeProject.run({ projectId, at: now() })
        if (info.changes === 0) throw new StorageError(StorageErrorCode.NotFound, { projectId })
        return toProject(q.projectById.get(projectId)!)
      },
      restore(projectId) {
        if (!q.projectById.get(projectId)) {
          throw new StorageError(StorageErrorCode.NotFound, { projectId })
        }
        q.restoreProject.run({ projectId })
        return toProject(q.projectById.get(projectId)!)
      },
    },

    sessions: {
      create(input) {
        const project = q.projectById.get(input.projectId)
        if (!project)
          throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
        if (q.sessionById.get(input.sessionId)) {
          throw new StorageError(StorageErrorCode.Conflict, { sessionId: input.sessionId })
        }
        const { model, kind, trialAgentId, trialDraftHash, ...rest } = input
        q.insertSession.run({
          ...rest,
          projectPath: project.path,
          kind: kind ?? 'normal',
          trialAgentId: trialAgentId ?? null,
          trialDraftHash: trialDraftHash ?? null,
          modelProviderId: model?.providerId ?? null,
          modelId: model?.modelId ?? null,
          at: now(),
        })
        return toSession(q.sessionById.get(input.sessionId)!)
      },
      get(sessionId) {
        const row = q.sessionById.get(sessionId)
        return row && toSession(row)
      },
      list(listOptions: ListSessionsOptions = {}) {
        return q.sessions
          .all({
            projectId: listOptions.projectId ?? null,
            includeArchived: listOptions.includeArchived ? 1 : 0,
            includeTrial: listOptions.includeTrial ? 1 : 0,
          })
          .map(toSession)
      },
      remove(sessionId) {
        if (!q.sessionById.get(sessionId)) {
          throw new StorageError(StorageErrorCode.NotFound, { sessionId })
        }
        db.transaction(() => {
          q.deleteSessionEvents.run(sessionId)
          q.deleteSessionFileChanges.run(sessionId)
          q.deleteSessionPermissionRules.run(sessionId)
          q.deleteSessionRuns.run(sessionId)
          q.deleteSessionSnapshots.run(sessionId)
          q.deleteSessionChangeSets.run(sessionId)
          q.deleteSession.run(sessionId)
        })()
      },
      rename: (sessionId, title) => updateSession(sessionId, title, 0),
      archive: (sessionId) => updateSession(sessionId, null, 1),
      setModel(sessionId, model) {
        const { changes } = q.setSessionModel.run({ sessionId, ...model, at: now() })
        if (changes === 0) throw new StorageError(StorageErrorCode.NotFound, { sessionId })
        return toSession(q.sessionById.get(sessionId)!)
      },
      touch: (sessionId) => updateSession(sessionId, null, 0),
    },

    providers: {
      list: () => q.providers.all().map(toProvider),
      get(providerId) {
        const row = q.providerById.get(providerId)
        return row && toProvider(row)
      },
      replaceAll: (configs) => replaceProviders(configs),
    },

    events: {
      append: (events) => append(events),
      readAfter(sessionId, afterSeq, limit) {
        const max = limit === undefined ? -1 : Math.max(0, limit)
        return q.readAfter.all(sessionId, afterSeq, max).map(toEvent)
      },
      maxSeq,
    },

    changes: {
      create: (input) => createChange(input),
      get: getChange,
      list(sessionId) {
        const hunks = new Map<string, HunkRow[]>()
        for (const row of q.hunksBySession.all(sessionId)) {
          const list = hunks.get(row.change_id) ?? []
          list.push(row)
          hunks.set(row.change_id, list)
        }
        return q.changesBySession
          .all(sessionId)
          .map((row) => toFileChange(row, hunks.get(row.change_id) ?? []))
      },
      setStatus: (changeId, status) => setChangeStatus(changeId, status),
      setHunkStatus: (changeId, hunkIndex, status) => setOneHunkStatus(changeId, hunkIndex, status),
    },

    skillPrefs: {
      get(scope, source, name) {
        const row = q.skillPref.get(scope, source, name)
        return row && toSkillPref(row)
      },
      list: (scope) => q.skillPrefsByScope.all(scope).map(toSkillPref),
      set(pref) {
        q.upsertSkillPref.run({
          scope: pref.scope,
          source: pref.source,
          name: pref.name,
          enabled: pref.enabled ? 1 : 0,
          pinned: pref.pinned ? 1 : 0,
        })
        return toSkillPref(q.skillPref.get(pref.scope, pref.source, pref.name)!)
      },
      delete(scope, source, name) {
        q.deleteSkillPref.run(scope, source, name)
      },
    },

    mcpServers: {
      list: () => q.mcpServers.all().map(toMcpServer),
      get(serverId) {
        const row = q.mcpServerById.get(serverId)
        return row && toMcpServer(row)
      },
      create(input) {
        if (q.mcpServerById.get(input.serverId)) {
          throw new StorageError(StorageErrorCode.Conflict, { serverId: input.serverId })
        }
        q.insertMcpServer.run({
          serverId: input.serverId,
          name: input.name,
          kind: input.kind,
          command: input.command ?? null,
          args: JSON.stringify(input.args ?? []),
          cwd: input.cwd ?? null,
          url: input.url ?? null,
          auth: input.auth ?? 'none',
          headerName: input.headerName ?? null,
          credentialRef: input.credentialRef ?? null,
          env: JSON.stringify(input.env ?? []),
          enabled: input.enabled === false ? 0 : 1,
          at: now(),
        })
        return toMcpServer(q.mcpServerById.get(input.serverId)!)
      },
      update(serverId, patch) {
        const current = q.mcpServerById.get(serverId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { serverId })
        const next = toMcpServer(current)
        q.updateMcpServer.run({
          serverId,
          name: patch.name ?? next.name,
          kind: patch.kind ?? next.kind,
          command: patch.command === undefined ? (next.command ?? null) : patch.command,
          args: JSON.stringify(patch.args ?? next.args),
          cwd: patch.cwd === undefined ? (next.cwd ?? null) : patch.cwd,
          url: patch.url === undefined ? (next.url ?? null) : patch.url,
          auth: patch.auth ?? next.auth,
          headerName: patch.headerName === undefined ? (next.headerName ?? null) : patch.headerName,
          credentialRef:
            patch.credentialRef === undefined ? (next.credentialRef ?? null) : patch.credentialRef,
          env: JSON.stringify(patch.env ?? next.env),
          enabled: (patch.enabled ?? next.enabled) ? 1 : 0,
          at: now(),
        })
        return toMcpServer(q.mcpServerById.get(serverId)!)
      },
      remove(serverId) {
        const { changes } = q.deleteMcpServer.run(serverId)
        if (changes === 0) throw new StorageError(StorageErrorCode.NotFound, { serverId })
        q.deleteMcpToolPrefs.run(serverId)
      },
    },

    mcpToolPrefs: {
      get(serverId, name) {
        const row = q.mcpToolPref.get(serverId, name)
        return row && toMcpToolPref(row)
      },
      list: (serverId) => q.mcpToolPrefs.all(serverId).map(toMcpToolPref),
      set(pref) {
        if (!q.mcpServerById.get(pref.serverId)) {
          throw new StorageError(StorageErrorCode.NotFound, { serverId: pref.serverId })
        }
        q.upsertMcpToolPref.run(pref)
        return toMcpToolPref(q.mcpToolPref.get(pref.serverId, pref.name)!)
      },
      deleteForServer(serverId) {
        q.deleteMcpToolPrefs.run(serverId)
      },
    },

    agents: {
      list: () => q.agents.all().map(toAgent),
      get(agentId) {
        const row = q.agentById.get(agentId)
        return row && toAgent(row)
      },
      create(input) {
        if (q.agentById.get(input.agentId)) {
          throw new StorageError(StorageErrorCode.Conflict, { agentId: input.agentId })
        }
        q.insertAgent.run({
          agentId: input.agentId,
          source: input.source,
          draft: input.draft === undefined ? null : JSON.stringify(input.draft),
          at: now(),
        })
        return toAgent(q.agentById.get(input.agentId)!)
      },
      saveDraft(agentId, draft) {
        if (!q.agentById.get(agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId })
        }
        q.setAgentDraft.run({ agentId, draft: JSON.stringify(draft), at: now() })
        return toAgent(q.agentById.get(agentId)!)
      },
      clearDraft(agentId) {
        if (!q.agentById.get(agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId })
        }
        q.setAgentDraft.run({ agentId, draft: null, at: now() })
        return toAgent(q.agentById.get(agentId)!)
      },
      setArchived(agentId, archived) {
        if (!q.agentById.get(agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId })
        }
        q.setAgentArchived.run({ agentId, archived: archived ? 1 : 0, at: now() })
        return toAgent(q.agentById.get(agentId)!)
      },
      remove(agentId) {
        q.deleteAgentVersions.run(agentId)
        if (q.deleteAgent.run(agentId).changes === 0) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId })
        }
      },
      versions: (agentId) => q.agentVersions.all(agentId).map(toAgentVersion),
      version(agentId, version) {
        const row = q.agentVersion.get(agentId, version)
        return row && toAgentVersion(row)
      },
      addVersion(input) {
        if (!q.agentById.get(input.agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId: input.agentId })
        }
        if (q.agentVersion.get(input.agentId, input.version)) {
          throw new StorageError(StorageErrorCode.Conflict, {
            agentId: input.agentId,
            version: input.version,
          })
        }
        q.insertAgentVersion.run({
          agentId: input.agentId,
          version: input.version,
          definition: JSON.stringify(input.definition),
          at: now(),
        })
        return toAgentVersion(q.agentVersion.get(input.agentId, input.version)!)
      },
    },

    permissionRules: {
      add: (input) => addRule(input),
      get(ruleId) {
        const row = q.ruleById.get(ruleId)
        return row && toPermissionRule(row)
      },
      list: (listOptions = {}) =>
        q.rules
          .all({
            projectId: listOptions.projectId ?? null,
            sessionId: listOptions.sessionId ?? null,
          })
          .map(toPermissionRule),
      delete(ruleId) {
        const { changes } = q.deleteRule.run(ruleId)
        if (changes === 0) throw new StorageError(StorageErrorCode.NotFound, { ruleId })
      },
    },

    runSnapshots: {
      add: (input) => addRunSnapshot(input),
      list: (runId, limit = 20) => q.runSnapshotsByRun.all(runId, limit).map(toRunSnapshot),
    },

    changeSets: {
      create: (input) => createChangeSet(input),
      get: (changeSetId) => {
        const row = q.changeSetById.get(changeSetId)
        return row && toChangeSet(row)
      },
      listBySession: (sessionId) => q.changeSetsBySession.all(sessionId).map(toChangeSet),
      setStatus(changeSetId, status) {
        requireChangeSet(changeSetId)
        q.setChangeSetStatus.run({ changeSetId, status, at: now() })
        return toChangeSet(q.changeSetById.get(changeSetId)!)
      },
      setCheckpointCommit(changeSetId, commit) {
        requireChangeSet(changeSetId)
        q.setChangeSetCheckpoint.run({ changeSetId, commit })
        return toChangeSet(q.changeSetById.get(changeSetId)!)
      },
      addFile: (input) => addChangeSetFile(input),
      listFiles: (changeSetId) => q.changeSetFiles.all(changeSetId).map(toChangeSetFile),
      setFileStatus(changeSetId, path, status) {
        requireChangeSet(changeSetId)
        if (!q.changeSetFile.get(changeSetId, path)) {
          throw new StorageError(StorageErrorCode.NotFound, { changeSetId, path })
        }
        q.setChangeSetFileStatus.run({ changeSetId, path, status })
        return toChangeSetFile(q.changeSetFile.get(changeSetId, path)!)
      },
    },

    commands: {
      create(record) {
        if (!db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(record.sessionId)) {
          throw new StorageError(StorageErrorCode.NotFound, { sessionId: record.sessionId })
        }
        if (
          db.prepare('SELECT 1 FROM background_commands WHERE command_id = ?').get(record.commandId)
        ) {
          throw new StorageError(StorageErrorCode.Conflict, { commandId: record.commandId })
        }
        db.prepare(
          `INSERT INTO background_commands
          (command_id, session_id, run_id, command, cwd, started_at, ended_at, exit_code, status)
          VALUES (@commandId, @sessionId, @runId, @command, @cwd, @startedAt, @endedAt, @exitCode, @status)`,
        ).run({ ...record, endedAt: record.endedAt ?? null, exitCode: record.exitCode ?? null })
        return record
      },
      get: backgroundCommand,
      list() {
        const ids = db
          .prepare<[], { command_id: string }>(
            'SELECT command_id FROM background_commands ORDER BY started_at DESC, rowid DESC',
          )
          .all()
        return ids.map(({ command_id }) => backgroundCommand(command_id)!)
      },
      finish(commandId, status, exitCode, endedAt) {
        const result = db
          .prepare(
            `UPDATE background_commands SET status = ?, exit_code = ?, ended_at = ?
          WHERE command_id = ?`,
          )
          .run(status, exitCode, endedAt, commandId)
        if (result.changes === 0) throw new StorageError(StorageErrorCode.NotFound, { commandId })
        return backgroundCommand(commandId)!
      },
      saveOutput(commandId, output) {
        const result = db
          .prepare('UPDATE background_commands SET output = ? WHERE command_id = ?')
          .run(JSON.stringify(output), commandId)
        if (result.changes === 0) throw new StorageError(StorageErrorCode.NotFound, { commandId })
      },
      output(commandId) {
        const row = db
          .prepare<[string], { output: string | null }>(
            'SELECT output FROM background_commands WHERE command_id = ?',
          )
          .get(commandId)
        return row?.output ? (JSON.parse(row.output) as BackgroundCommandOutput) : undefined
      },
    },

    transaction: <T>(fn: () => T): T => db.transaction(fn)(),

    close() {
      db.close()
    },
  }
}
