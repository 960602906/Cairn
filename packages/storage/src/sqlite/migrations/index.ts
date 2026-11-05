import type { Migration } from '../migrate.js'
import { init } from './0001-init.js'
import { providers } from './0002-providers.js'
import { providerCompat } from './0003-provider-compat.js'
import { fileChanges } from './0004-file-changes.js'

/** 应用的全部迁移，按编号排列。新增迁移时追加到末尾。 */
export const MIGRATIONS: readonly Migration[] = [init, providers, providerCompat, fileChanges]
