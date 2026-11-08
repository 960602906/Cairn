import type { Migration } from '../migrate.js'

/**
 * 试运行会话标记（M4-12）：普通会话与试运行共用会话/事件表，查询与统计按 `kind` 排除试运行。
 *
 * 计划中本迁移编号为 `0013-session-kind`，但 `0013` 已被 M4-10 的改动集基线时间占用；
 * 迁移编号必须单调递增，因此这里使用 `0014`。`0014-background-commands`（M4-14，可选）
 * 若实施需顺延到 `0015`。
 */
export const sessionKind: Migration = {
  version: 14,
  name: 'session-kind',
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE sessions ADD COLUMN trial_agent_id TEXT;
      ALTER TABLE sessions ADD COLUMN trial_draft_hash TEXT;

      CREATE INDEX sessions_by_trial_agent
        ON sessions (kind, trial_agent_id, updated_at DESC);
    `)
  },
}
