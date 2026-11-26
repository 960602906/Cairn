import type { Migration } from '../migrate.js'

/**
 * 会话置顶（桌面手感）：置顶的会话在同组里排到最前，方便长期保留正在用的几个。
 * 已有会话默认未置顶；取消置顶不需要迁移。
 */
export const sessionPinning: Migration = {
  version: 25,
  name: 'session-pinning',
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    `)
  },
}
