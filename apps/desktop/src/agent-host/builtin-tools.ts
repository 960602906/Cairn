/**
 * 宿主注册的内置工具（M1-11a，架构 §9.2）：`read_file`、`list_dir`、`search`、`write_file`、`edit_file`、
 * `run_command`。
 *
 * - `search` 使用随应用打包的 ripgrep（`out/bin`，构建时复制）；
 * - `run_command` 的 shell 在第一次注册时选出（ADR-0012：Windows 优先非商店版 pwsh 7，其次 Windows
 *   PowerShell 5.1；设置为 cmd 时用 cmd，M2-09），同一个宿主进程只选一次。
 */
import {
  createSandboxRunner,
  describeShell,
  selectShell,
  unsandboxedExecution,
  type SandboxCapability,
  type SandboxPolicy,
  type SandboxRunner,
  type SandboxUnavailableBehavior,
  type ShellInfo,
  type ShellPreference,
} from '@cairn/shell'
import {
  bundledRipgrepPath,
  registerExecuteTools,
  registerReadTools,
  registerWriteTools,
} from '@cairn/tools'
import type { ToolRegistry } from '@cairn/core'
import { sandboxExecution } from '@cairn/protocol'

export interface BuiltinToolsOptions {
  /** 打包的外部程序所在目录（ripgrep）。 */
  readonly binDir: string
  /** 测试用：替换 shell 选择。 */
  readonly selectShell?: (preference: ShellPreference) => Promise<ShellInfo>
}

/**
 * 由 `host.init.sandbox` 给出的沙箱配置（M5-04）。宿主只在这里创建执行器；主进程负责设置、能力探测、
 * AppContainer 配置与工作区 ACL。
 */
export interface BuiltinSandboxConfig {
  readonly policy: SandboxPolicy
  readonly capability: SandboxCapability
  readonly unavailable: SandboxUnavailableBehavior
  readonly appContainerName?: string | undefined
  /**
   * 沙箱里的子进程起不来（`sandbox.child_start_failed`）时调用一次（M5-04）：
   * 宿主据此把“沙箱不可用”状态同步给权限守卫，后续命令按设置拒绝或经审批在沙箱外运行。
   */
  readonly onUnusable?: (() => void) | undefined
}

export function createBuiltinTools(
  options: BuiltinToolsOptions,
): (
  registry: ToolRegistry,
  workspacePath?: string,
  preference?: ShellPreference,
  sandbox?: BuiltinSandboxConfig,
) => Promise<{ shell: string }> {
  let shell: Promise<ShellInfo> | undefined
  let runner: Promise<SandboxRunner> | undefined
  /** 沙箱在当前宿主进程里是否已经证明起不来；一旦为 true 就不再尝试，按“沙箱不可用”处理。 */
  let sandboxBroken = false
  return async (registry, _workspacePath, preference = 'auto', sandbox) => {
    const select = options.selectShell ?? ((p: ShellPreference) => selectShell({ preference: p }))
    shell ??= select(preference).catch((error: unknown) => {
      shell = undefined
      throw error
    })
    const selected = await shell
    registerReadTools(registry, { ripgrepPath: bundledRipgrepPath(options.binDir) })
    registerWriteTools(registry)
    let executeSandbox:
      { readonly policy: SandboxPolicy; readonly runner: SandboxRunner } | undefined
    const execution = sandbox ? sandboxExecution(sandbox.policy, sandbox.capability) : undefined
    // 沙箱不可用时由权限守卫决定失败关闭或审批；审批通过后按现有语义执行（不创建执行器）
    if (sandbox?.capability.available) {
      const mechanism =
        sandbox.capability.mechanism === 'appcontainer' ? 'appcontainer' : 'restricted-token'
      runner ??= createSandboxRunner({
        mechanism,
        capability: sandbox.capability,
        ...(mechanism === 'appcontainer' && sandbox.appContainerName
          ? { appContainer: { name: sandbox.appContainerName } }
          : {}),
      }).catch((error: unknown) => {
        runner = undefined
        throw error
      })
      executeSandbox = { policy: sandbox.policy, runner: await runner }
    }
    const policy = sandbox?.policy
    const markUnusable = () => {
      if (sandboxBroken) return
      sandboxBroken = true
      runner = undefined
      sandbox?.onUnusable?.()
    }
    registerExecuteTools(registry, {
      shell: selected,
      // 降级后不再把执行器交给 run_command：命令以应用用户权限运行，卡片标注“未沙箱化”
      ...(executeSandbox
        ? { sandbox: () => (sandboxBroken ? undefined : executeSandbox) }
        : {}),
      ...(execution || policy
        ? {
            execution: () =>
              sandboxBroken && policy
                ? unsandboxedExecution(policy, 'sandbox.unavailable')
                : execution,
          }
        : {}),
      ...(sandbox?.capability.available ? { onSandboxStartFailure: markUnusable } : {}),
    })
    // 写入系统提示词（M1-13b）
    return { shell: describeShell(selected) }
  }
}
