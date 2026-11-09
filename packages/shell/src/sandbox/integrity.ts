/**
 * 工作区完整性标签（M5-04）：受限令牌以低完整性运行，只有低完整性标签的目录对它可写。
 *
 * - `workspace-write`：把工作区目录设为低完整性（`(OI)(CI)L`）；目录内已有文件与之后创建的文件都继承；
 * - `read-only`：把工作区设回中完整性（`(OI)(CI)M`），低完整性进程无法写入；
 * - 专用临时目录始终设为低完整性，读只读档位也能写临时文件。
 *
 * 标签只加在目录上：`icacls` 的继承 ACE 对已有子项动态生效。无法设置时抛出 `sandbox.setup_failed`，
 * 调用方失败关闭，不能静默降级。
 */
import { createIcaclsRunner, type IcaclsOptions } from './icacls.js'
import { SandboxError, SandboxErrorCode } from './types.js'

export type IntegrityLevel = 'low' | 'medium'

export interface IntegrityController {
  setLevel(directory: string, level: IntegrityLevel): Promise<void>
}

const LEVEL_FLAG: Readonly<Record<IntegrityLevel, string>> = {
  low: '(OI)(CI)L',
  medium: '(OI)(CI)M',
}

export function createIntegrityController(options: IcaclsOptions = {}): IntegrityController {
  const run = createIcaclsRunner(options)
  return {
    async setLevel(directory, level) {
      let code: number
      try {
        code = await run([directory, '/setintegritylevel', LEVEL_FLAG[level]])
      } catch (error) {
        throw new SandboxError(
          SandboxErrorCode.SetupFailed,
          `Cannot set the ${level} integrity level on the workspace (${(error as Error).message}).`,
          { level },
          { cause: error },
        )
      }
      if (code !== 0) {
        throw new SandboxError(
          SandboxErrorCode.SetupFailed,
          `Cannot set the ${level} integrity level on the workspace (icacls exited with ${code}).`,
          { level, exitCode: String(code) },
        )
      }
    },
  }
}
