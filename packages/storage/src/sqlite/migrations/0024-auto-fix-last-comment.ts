import type { Migration } from '../migrate.js'

/**
 * 评审意见触发（M8-04）。
 *
 * `pull_request_watches.last_comment_id` 记录已经处理过的最新评审意见 id；之后出现更大的 id
 * 才触发新一轮修复。新监视先建立基线，避免把历史意见一次全部处理。
 */
export const autoFixLastComment: Migration = {
  version: 24,
  name: 'auto-fix-last-comment',
  up(db) {
    db.exec(`
      ALTER TABLE pull_request_watches ADD COLUMN last_comment_id INTEGER;
    `)
  },
}
