import type { Migration } from '../migrate.js'

/**
 * 记忆条目（M7-01，ADR-0019，设计 §22）。三个范围严格隔离：`session` 必须有会话、
 * `project` 必须有项目、`global` 两者都不能有；数据库的 CHECK 与仓储层各校验一次。
 * 删除会话时它的会话记忆随之删除（ON DELETE CASCADE）。
 */
export const memoryEntries: Migration = {
  version: 18,
  name: 'memory-entries',
  up(db) {
    db.exec(`
      CREATE TABLE memory_entries (
        memory_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global')),
        session_id TEXT REFERENCES sessions (session_id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects (project_id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) > 0),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'active')),
        source_run_id TEXT,
        source_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (scope = 'session' AND session_id IS NOT NULL AND project_id IS NULL) OR
          (scope = 'project' AND project_id IS NOT NULL AND session_id IS NULL) OR
          (scope = 'global' AND session_id IS NULL AND project_id IS NULL)
        )
      );

      CREATE INDEX memory_entries_by_project ON memory_entries (project_id, status, created_at);
      CREATE INDEX memory_entries_by_session ON memory_entries (session_id, status, created_at);
    `)
  },
}
