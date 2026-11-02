/**
 * SQLite 存储实现（ADR-0006，引擎 better-sqlite3，S4）。与内存实现通过同一套契约测试。
 *
 * 打开时先执行迁移（`migrateDatabase`），再以 WAL 模式打开连接。只有主进程使用。
 */
import { isLiveEventType, type PersistedEvent } from '@nexus/protocol'
import Database from 'better-sqlite3'
import {
  StorageError,
  StorageErrorCode,
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
  created_at: number
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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
         (session_id, project_id, project_path, workspace_path, title, archived, created_at, updated_at)
       VALUES (@sessionId, @projectId, @projectPath, @workspacePath, @title, 0, @at, @at)`,
    ),
    updateSession: db.prepare(
      `UPDATE sessions SET
         title = coalesce(@title, title),
         archived = max(archived, @archived),
         updated_at = @at
       WHERE session_id = @sessionId`,
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
        q.insertSession.run({ ...input, projectPath: project.path, at: now() })
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

    events: {
      append: (events) => append(events),
      readAfter(sessionId, afterSeq, limit) {
        const max = limit === undefined ? -1 : Math.max(0, limit)
        return q.readAfter.all(sessionId, afterSeq, max).map(toEvent)
      },
      maxSeq,
    },

    transaction: <T>(fn: () => T): T => db.transaction(fn)(),

    close() {
      db.close()
    },
  }
}
