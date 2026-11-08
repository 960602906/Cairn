import type { Migration } from '../migrate.js'
import { init } from './0001-init.js'
import { providers } from './0002-providers.js'
import { providerCompat } from './0003-provider-compat.js'
import { fileChanges } from './0004-file-changes.js'
import { permissionRules } from './0005-permission-rules.js'
import { projectSettings } from './0006-project-settings.js'
import { skillPrefs } from './0007-skill-prefs.js'
import { projectSkillsDefault } from './0008-project-skills-default.js'
import { mcp } from './0009-mcp.js'
import { agents } from './0010-agents.js'
import { runSnapshots } from './0011-run-snapshots.js'
import { changeSets } from './0012-change-sets.js'
import { changeSetBaselineTime } from './0013-change-set-baseline-time.js'

/** 应用的全部迁移，按编号排列。新增迁移时追加到末尾。 */
export const MIGRATIONS: readonly Migration[] = [
  init,
  providers,
  providerCompat,
  fileChanges,
  permissionRules,
  projectSettings,
  skillPrefs,
  projectSkillsDefault,
  mcp,
  agents,
  runSnapshots,
  changeSets,
  changeSetBaselineTime,
]
