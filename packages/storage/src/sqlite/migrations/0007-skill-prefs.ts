import type { Migration } from '../migrate.js'

/**
 * 技能的启用与固定加载（M3-07）。
 * `scope` 为 `global`（内置、用户安装）或项目 id（项目内技能）。
 * 没有记录时视为启用、不固定加载。
 */
export const skillPrefs: Migration = {
  version: 7,
  name: 'skill_prefs',
  up(db) {
    db.exec(`
      CREATE TABLE skill_prefs (
        scope TEXT NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        pinned INTEGER NOT NULL,
        PRIMARY KEY (scope, source, name)
      );
    `)
  },
}
