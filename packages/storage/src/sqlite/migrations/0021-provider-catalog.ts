import type { Migration } from '../migrate.js'

/**
 * 缓存提供方拉取到的模型列表（M2-10）。
 *
 * `catalog` 为 `RemoteModel[]` 的 JSON：打开供应商编辑时直接与已配置的模型一起列出，
 * 不必每次重新拉取。为空表示还没有拉取过。
 */
export const providerCatalog: Migration = {
  version: 21,
  name: 'provider-catalog',
  up(db) {
    db.exec('ALTER TABLE provider_configs ADD COLUMN catalog TEXT;')
  },
}
