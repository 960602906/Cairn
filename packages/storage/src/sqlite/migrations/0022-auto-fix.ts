import type { Migration } from '../migrate.js'

/**
 * 自动修复监视（M8-02）。
 *
 * - `pull_request_watches`：被监视的 PR 与去重状态；`(repo, pr_number)` 唯一，避免重复开修复；
 * - `auto_fix_jobs`：每次触发的修复任务，记录签名、状态与会话；随监视一起删除。
 *
 * 会话本身沿用 `0014-session-kind` 的 `kind`，新增取值 `auto-fix`，不需要改表结构。
 */
export const autoFix: Migration = {
  version: 22,
  name: 'auto-fix',
  up(db) {
    db.exec(`
      CREATE TABLE pull_request_watches (
        watch_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        project_path TEXT NOT NULL,
        triggers TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        enabled INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_signature TEXT,
        last_evaluated_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (repo, pr_number)
      );

      CREATE TABLE auto_fix_jobs (
        job_id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL,
        session_id TEXT,
        trigger TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (watch_id) REFERENCES pull_request_watches (watch_id) ON DELETE CASCADE
      );

      CREATE INDEX auto_fix_jobs_by_watch
        ON auto_fix_jobs (watch_id, created_at DESC);
    `)
  },
}
