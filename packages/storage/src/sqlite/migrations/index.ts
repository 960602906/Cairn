import type { Migration } from '../migrate.js'
import { init } from './0001-init.js'

/** 应用的全部迁移，按编号排列。新增迁移时追加到末尾。 */
export const MIGRATIONS: readonly Migration[] = [init]
