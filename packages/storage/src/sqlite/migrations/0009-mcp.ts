import type { Migration } from '../migrate.js'

/**
 * MCP 服务（M3-09）：配置只保存环境变量名与凭据引用，值在凭据服务中。
 * 删除服务时一并删除工具偏好。
 */
export const mcp: Migration = {
  version: 9,
  name: 'mcp',
  up(db) {
    db.exec(`
      CREATE TABLE mcp_servers (
        server_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        url TEXT,
        auth TEXT NOT NULL DEFAULT 'none',
        header_name TEXT,
        credential_ref TEXT,
        env TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mcp_tool_prefs (
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        effect TEXT NOT NULL,
        PRIMARY KEY (server_id, name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers (server_id) ON DELETE CASCADE
      );
    `)
  },
}
