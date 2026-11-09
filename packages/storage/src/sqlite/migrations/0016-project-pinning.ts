import type { Migration } from '../migrate.js'

/**
 * 工作空间置顶与归档（目录功能同步）：置顶用于稳定排序，归档用于把不再活跃的
 * 工作空间收进独立分组。两者都是可清除的时间戳；已有项目默认未置顶、未归档。
 */
export const projectPinning: Migration = {
  version: 16,
  name: 'project-pinning',
  up(db) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN pinned_at INTEGER;
      ALTER TABLE projects ADD COLUMN archived_at INTEGER;
    `)
  },
}
