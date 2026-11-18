import type { Migration } from '../migrate.js'

/**
 * 自动修复会话的 Git 工具（M8-03）。
 *
 * `auto_fix_jobs.session_id` 被 `getBySession` 在每次提交 / 推送时查询，补一个索引。
 */
export const autoFixSessionIndex: Migration = {
  version: 23,
  name: 'auto-fix-session-index',
  up(db) {
    db.exec(`
      CREATE INDEX auto_fix_jobs_by_session
        ON auto_fix_jobs (session_id);
    `)
  },
}
