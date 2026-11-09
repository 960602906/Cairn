/**
 * 内置技能目录（M5-02，ADR-0035）。
 *
 * 开发构建从 `out/main` 回溯到 `apps/desktop/resources/skills`；安装包通过
 * `extraResources` 把技能放到 `process.resourcesPath/skills`。不能继续使用相对
 * `import.meta.dirname` 的路径，因为那会解析到 `app.asar` 内部，而技能目录不在 asar 中。
 */
import { join } from 'node:path'

export interface BuiltinSkillsLocation {
  readonly packaged: boolean
  /** `out/main`。 */
  readonly moduleDir: string
  /** Electron 的 `process.resourcesPath`。 */
  readonly resourcesPath: string
}

export function resolveBuiltinSkillsDir({
  packaged,
  moduleDir,
  resourcesPath,
}: BuiltinSkillsLocation): string {
  return packaged ? join(resourcesPath, 'skills') : join(moduleDir, '../../resources/skills')
}
