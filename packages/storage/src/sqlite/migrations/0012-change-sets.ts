import type { Migration } from '../migrate.js'

/**
 * 改动集（M4-09，ADR-0031）：一次隔离工作区中的委派产生的文件级改动。
 *
 * `change_sets` 记录改动集的来源（子运行、基线提交、隔离目录）与状态；
 * `change_set_files` 记录每个文件的类型、行数、diff 与 blob 哈希。
 * blob 哈希指向主进程的 blob 存储，这里只保存引用。
 */
export const changeSets: Migration = {
  version: 12,
  name: 'change-sets',
  up(db) {
    db.exec(`
      CREATE TABLE change_sets (
        change_set_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_run_id TEXT,
        base_commit TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        merged_at INTEGER,
        checkpoint_commit TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE CASCADE
      );

      CREATE INDEX change_sets_by_session ON change_sets (session_id, created_at);

      CREATE TABLE change_set_files (
        change_set_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        added INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        patch TEXT,
        binary INTEGER NOT NULL,
        large INTEGER NOT NULL,
        base_hash TEXT,
        content_hash TEXT,
        PRIMARY KEY (change_set_id, path),
        FOREIGN KEY (change_set_id) REFERENCES change_sets (change_set_id) ON DELETE CASCADE
      );
    `)
  },
}
