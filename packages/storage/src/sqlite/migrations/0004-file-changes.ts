import type { Migration } from '../migrate.js'

/**
 * 文件改动记录（M1-08b，架构 §14.2）。前后内容在内容寻址的 blob 存储中（`data/blobs`），
 * 这里只保存 SHA-256 哈希。`file_changes` 的 rowid 保持记录顺序；块的状态为按块撤销（M3）预留。
 */
export const fileChanges: Migration = {
  version: 4,
  name: 'file_changes',
  up(db) {
    db.exec(`
      CREATE TABLE file_changes (
        change_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions (session_id),
        run_id TEXT,
        turn_id TEXT,
        tool_call_id TEXT,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        revert_of TEXT REFERENCES file_changes (change_id),
        status TEXT NOT NULL,
        added INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX file_changes_by_session ON file_changes (session_id);

      CREATE TABLE hunks (
        change_id TEXT NOT NULL REFERENCES file_changes (change_id),
        position INTEGER NOT NULL,
        old_start INTEGER NOT NULL,
        old_lines INTEGER NOT NULL,
        new_start INTEGER NOT NULL,
        new_lines INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (change_id, position)
      ) WITHOUT ROWID;
    `)
  },
}
