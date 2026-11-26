import type { Migration } from '../migrate.js'

/**
 * 会话全文搜索（检索与回顾）：每个会话保存一份用户与助手消息正文，用 FTS5 trigram 索引。
 *
 * 只有会话级一行，搜索结果是会话（与 ⌘K 的列表一致），片段取自命中附近。trigram 分词支持
 * 中文与任意子串（≥3 个字符）；更短的查询由 `SessionStore.searchText` 退回 LIKE。
 * 已有数据库的正文在打开时由 TypeScript 回填，避免迁移里写复杂的 JSON 展开。
 */
export const sessionSearch: Migration = {
  version: 26,
  name: 'session-search',
  up(db) {
    db.exec(`
      CREATE TABLE session_search_text (
        session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE session_search_fts USING fts5(
        text,
        content = 'session_search_text',
        content_rowid = 'rowid',
        tokenize = 'trigram'
      );

      CREATE TRIGGER session_search_text_ai AFTER INSERT ON session_search_text BEGIN
        INSERT INTO session_search_fts (rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE TRIGGER session_search_text_ad AFTER DELETE ON session_search_text BEGIN
        INSERT INTO session_search_fts (session_search_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;

      CREATE TRIGGER session_search_text_au AFTER UPDATE ON session_search_text BEGIN
        INSERT INTO session_search_fts (session_search_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO session_search_fts (rowid, text) VALUES (new.rowid, new.text);
      END;
    `)
  },
}
