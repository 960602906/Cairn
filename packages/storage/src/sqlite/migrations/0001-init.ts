import type { Migration } from '../migrate.js'

/**
 * 首个迁移（架构 §14.2）：项目、会话、运行与事件。`schema_meta` 由迁移框架创建。
 * 其余表（改动记录、检查点、权限规则等）在用到时由后续迁移添加。
 */
export const init: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (project_id),
        project_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_by_updated ON sessions (archived, updated_at DESC);
      CREATE INDEX sessions_by_project ON sessions (project_id, updated_at DESC);

      CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions (session_id),
        parent_run_id TEXT REFERENCES agent_runs (run_id),
        agent_id TEXT NOT NULL,
        agent_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        limits TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX agent_runs_by_session ON agent_runs (session_id);

      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions (session_id),
        seq INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        parent_run_id TEXT,
        turn_id TEXT,
        step_id TEXT,
        type TEXT NOT NULL,
        v INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX events_by_run ON events (run_id);
    `)
  },
}
