import type { Migration } from '../migrate.js'

/**
 * 改动集基线快照时间（M4-10）：隔离工作区创建的时间就是基线的快照时间。
 * 旧数据的这一列为空，界面回退到改动集创建时间。
 */
export const changeSetBaselineTime: Migration = {
  version: 13,
  name: 'change-set-baseline-time',
  up(db) {
    db.exec('ALTER TABLE change_sets ADD COLUMN base_created_at INTEGER')
  },
}
