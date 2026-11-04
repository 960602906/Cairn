import type { Migration } from '../migrate.js'

/**
 * 提供方的配置模板与兼容参数（M1-04b）。`compat` 为 JSON；模型自己的兼容参数在 `models` 的 JSON 中。
 */
export const providerCompat: Migration = {
  version: 3,
  name: 'provider_compat',
  up(db) {
    db.exec(`
      ALTER TABLE provider_configs ADD COLUMN template TEXT;
      ALTER TABLE provider_configs ADD COLUMN compat TEXT;
    `)
  },
}
