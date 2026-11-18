import type { Migration } from '../migrate.js'

/**
 * 团队模板（M7-06，多 Agent 协作 §15）：与 Agent 一样把草稿与已发布版本分开保存；
 * 运行只引用已发布版本，删除模板时版本随之删除。
 */
export const agentTeams: Migration = {
  version: 19,
  name: 'agent-teams',
  up(db) {
    db.exec(`
      CREATE TABLE agent_teams (
        team_id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        draft TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_team_versions (
        team_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, version),
        FOREIGN KEY (team_id) REFERENCES agent_teams (team_id) ON DELETE CASCADE
      );
    `)
  },
}
