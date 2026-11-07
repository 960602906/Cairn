import type { Migration } from '../migrate.js'

/**
 * 项目内技能默认读取（2026-11-07）：`.agents/skills/` 是通行的约定，打开项目就应该能用。
 * 已有项目一律改为开启；新项目在插入时写入 1（SQLite 改不了列的默认值，插入语句显式给值）。
 */
export const projectSkillsDefault: Migration = {
  version: 8,
  name: 'project_skills_default',
  up(db) {
    db.exec('UPDATE projects SET enable_project_skills = 1')
  },
}
