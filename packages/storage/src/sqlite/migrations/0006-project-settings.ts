import type { Migration } from '../migrate.js'

/**
 * 项目设置（M3-02）：是否读取 `AGENTS.md`、是否启用项目内 Skills，以及从列表移除的时间。
 * 已有项目默认读取说明、不启用技能、仍在列表中。
 */
export const projectSettings: Migration = {
  version: 6,
  name: 'project_settings',
  up(db) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN read_agents_md INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE projects ADD COLUMN enable_project_skills INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN removed_at INTEGER;
    `)
  },
}
