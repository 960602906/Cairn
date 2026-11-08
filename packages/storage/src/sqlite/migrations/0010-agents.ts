import type { Migration } from '../migrate.js'

/**
 * Agent 定义（M3-11，ADR-0016）：草稿与已发布版本分开保存；运行只引用已发布版本。
 * 内置 Agent 由代码提供，不落库。
 */
export const agents: Migration = {
  version: 10,
  name: 'agents',
  up(db) {
    db.exec(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        draft TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_versions (
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, version),
        FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
      );
    `)
  },
}
