/**
 * 宿主注册的内置工具（M1-11a，架构 §9.2）：`read_file`、`list_dir`、`search`、`write_file`、`edit_file`、
 * `run_command`。
 *
 * - `search` 使用随应用打包的 ripgrep（`out/bin`，构建时复制）；
 * - `run_command` 的 shell 在第一次注册时选出（ADR-0012：Windows 优先非商店版 pwsh 7，其次 Windows
 *   PowerShell 5.1），同一个宿主进程只选一次。shell 偏好设置（`auto` / `cmd`）随设置界面加入。
 */
import { describeShell, selectShell, type ShellInfo } from '@cairn/shell'
import {
  bundledRipgrepPath,
  registerExecuteTools,
  registerReadTools,
  registerWriteTools,
} from '@cairn/tools'
import type { ToolRegistry } from '@cairn/core'

export interface BuiltinToolsOptions {
  /** 打包的外部程序所在目录（ripgrep）。 */
  readonly binDir: string
  /** 测试用：替换 shell 选择。 */
  readonly selectShell?: () => Promise<ShellInfo>
}

export function createBuiltinTools(
  options: BuiltinToolsOptions,
): (registry: ToolRegistry) => Promise<{ shell: string }> {
  let shell: Promise<ShellInfo> | undefined
  return async (registry) => {
    shell ??= (options.selectShell ?? (() => selectShell()))().catch((error: unknown) => {
      shell = undefined
      throw error
    })
    const selected = await shell
    registerReadTools(registry, { ripgrepPath: bundledRipgrepPath(options.binDir) })
    registerWriteTools(registry)
    registerExecuteTools(registry, { shell: selected })
    // 写入系统提示词（M1-13b）
    return { shell: describeShell(selected) }
  }
}
