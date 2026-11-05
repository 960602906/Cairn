import type { Migration } from '../migrate.js'

/**
 * 权限规则（M1-10c，架构 §10.1、§14.2）。预设规则不保存，由权限模式生成。项目范围的规则有
 * `project_id`，会话范围的规则有 `session_id`；匹配条件以 JSON 保存。rowid 保持添加顺序。
 */
export const permissionRules: Migration = {
  version: 5,
  name: 'permission_rules',
  up(db) {
    db.exec(`
      CREATE TABLE permission_rules (
        rule_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT REFERENCES projects (project_id),
        session_id TEXT REFERENCES sessions (session_id),
        effect TEXT NOT NULL,
        match TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX permission_rules_by_project ON permission_rules (project_id);
      CREATE INDEX permission_rules_by_session ON permission_rules (session_id);
    `)
  },
}
