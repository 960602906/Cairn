import type { Migration } from '../migrate.js'

/**
 * 模型提供方配置与会话模型（M1-04a，架构 §12.1）。
 *
 * - `provider_configs`：每个提供方一行，`position` 保持列表顺序；模型能力列表以 JSON 保存。
 *   只保存凭据引用，Key 在凭据服务中（ADR-0010）。
 * - `sessions` 增加会话使用的模型；之前创建的会话为空，使用默认模型。
 */
export const providers: Migration = {
  version: 2,
  name: 'providers',
  up(db) {
    db.exec(`
      CREATE TABLE provider_configs (
        provider_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_ref TEXT,
        models TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      ALTER TABLE sessions ADD COLUMN model_provider_id TEXT;
      ALTER TABLE sessions ADD COLUMN model_id TEXT;
    `)
  },
}
