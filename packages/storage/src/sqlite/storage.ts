/**
 * SQLite 存储实现（ADR-0006，引擎 better-sqlite3，S4）。与内存实现通过同一套契约测试。
 *
 * 打开时先执行迁移（`migrateDatabase`），再以 WAL 模式打开连接。只有主进程使用。
 */
import {
  isLiveEventType,
  type FileChangeKind,
  type FileChangeStatus,
  type PersistedEvent,
  type ProviderConfig,
} from '@nexus/protocol'
import Database from 'better-sqlite3'
import {
  StorageError,
  StorageErrorCode,
  type CreateFileChangeInput,
  type FileChangeRecord,
  type HunkRecord,
  type ListSessionsOptions,
  type ProjectRecord,
  type SessionRecord,
  type Storage,
  type StorageOptions,
} from '../types.js'
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
}

interface SessionRow {
  session_id: string
  project_id: string
  project_path: string
  workspace_path: string
  title: string
  archived: number
  model_provider_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
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
})

const toSession = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  projectId: row.project_id,
  projectPath: row.project_path,
  workspacePath: row.workspace_path,
  title: row.title,
  archived: row.archived === 1,
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
      'SELECT * FROM projects ORDER BY created_at DESC, project_id',
    ),
    insertProject: db.prepare(
      'INSERT INTO projects (project_id, name, path, created_at) VALUES (@projectId, @name, @path, @createdAt)',
    ),
    sessionById: db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_id = ?'),
    sessions: db.prepare<{ projectId: string | null; includeArchived: number }, SessionRow>(
      `SELECT * FROM sessions
       WHERE (@includeArchived = 1 OR archived = 0)
         AND (@projectId IS NULL OR project_id = @projectId)
       ORDER BY updated_at DESC, session_id`,
    ),
    insertSession: db.prepare(
      `INSERT INTO sessions
         (session_id, project_id, project_path, workspace_path, title, archived,
          model_provider_id, model_id, created_at, updated_at)
       VALUES (@sessionId, @projectId, @projectPath, @workspacePath, @title, 0,
          @modelProviderId, @modelId, @at, @at)`,
    ),
    updateSession: db.prepare(
      `UPDATE sessions SET
         title = coalesce(@title, title),
         archived = max(archived, @archived),
         updated_at = @at
       WHERE session_id = @sessionId`,
    ),
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
    setHunkStatus: db.prepare('UPDATE hunks SET status = ? WHERE change_id = ?'),
  }

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
        const record: ProjectRecord = { ...input, createdAt: now() }
        q.insertProject.run(record)
        return record
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
    },

    sessions: {
      create(input) {
        const project = q.projectById.get(input.projectId)
        if (!project)
          throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
        if (q.sessionById.get(input.sessionId)) {
          throw new StorageError(StorageErrorCode.Conflict, { sessionId: input.sessionId })
        }
        const { model, ...rest } = input
        q.insertSession.run({
          ...rest,
          projectPath: project.path,
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
          })
          .map(toSession)
      },
      rename: (sessionId, title) => updateSession(sessionId, title, 0),
      archive: (sessionId) => updateSession(sessionId, null, 1),
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
    },

    transaction: <T>(fn: () => T): T => db.transaction(fn)(),

    close() {
      db.close()
    },
  }
}
