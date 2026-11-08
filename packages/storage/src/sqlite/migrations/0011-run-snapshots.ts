import type { Migration } from '../migrate.js'

/**
 * 运行上下文快照（M4-04，ADR-0033）：每次模型调用前一份，按运行保留最近 20 份。
 * 快照内容由主进程脱敏与截断后以 JSON 保存。
 */
export const runSnapshots: Migration = {
  version: 11,
  name: 'run-snapshots',
  up(db) {
    db.exec(`
      CREATE TABLE run_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_run_id TEXT,
        turn_id TEXT,
        step_id TEXT,
        created_at INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE CASCADE
      );

      CREATE INDEX run_snapshots_by_run ON run_snapshots (run_id, created_at);
    `)
  },
}
