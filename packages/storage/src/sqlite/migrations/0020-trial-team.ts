import type { Migration } from '../migrate.js'

/**
 * 团队试运行（M7-09，多 Agent 协作 §15）：试运行会话可以引用一个团队模板草稿。
 * 模板草稿的内容哈希随会话保存，用来判断模板是否在开始后又改过。
 */
export const trialTeam: Migration = {
  version: 20,
  name: 'trial-team',
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN trial_team_id TEXT;
      ALTER TABLE sessions ADD COLUMN trial_team_draft_hash TEXT;

      CREATE INDEX sessions_by_trial_team
        ON sessions (kind, trial_team_id, updated_at DESC);
    `)
  },
}
