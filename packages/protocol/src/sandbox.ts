/**
 * 命令沙箱（M5-04，ADR-0034）：只约束 `run_command` 与 `start_command` 启动的进程树。
 *
 * - 档位（`profile`）决定文件系统的隔离程度，与权限预设正交：权限预设决定“是否询问”，档位决定
 *   “OS 隔离到什么程度”。
 * - `danger-full-access` 只在用户明确选择“本次不使用沙箱”后使用，不能保存为默认值。
 * - 受限令牌档位不能隔离网络：`networkIsolated` 必须如实为 false，界面与事件不得暗示网络已被隔离。
 */
import { z } from 'zod'

/**
 * 沙箱档位：
 * - `read-only`：工作区只读，专用临时目录可写；
 * - `workspace-write`：工作区与专用临时目录可写，其他地方不可写；默认档位；
 * - `danger-full-access`：不使用 OS 隔离（当前行为），必须逐次审批。
 */
export const SandboxProfile = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
export type SandboxProfile = z.infer<typeof SandboxProfile>

/** 可保存为默认值的档位：`danger-full-access` 不能持久化。 */
export const SandboxDefaultProfile = z.enum(['read-only', 'workspace-write'])
export type SandboxDefaultProfile = z.infer<typeof SandboxDefaultProfile>

/**
 * 网络策略：`none` 不授予网络能力；`internet` 允许公网；`private` 允许本地/私网。受限令牌档位不能
 * 执行网络策略，实际是否隔离见 `SandboxExecution.networkIsolated`。
 */
export const SandboxNetwork = z.enum(['none', 'internet', 'private'])
export type SandboxNetwork = z.infer<typeof SandboxNetwork>

export const SandboxPolicy = z.object({
  profile: SandboxProfile,
  network: SandboxNetwork,
})
export type SandboxPolicy = z.infer<typeof SandboxPolicy>

/** 实际使用的隔离机制：受限令牌、实验性 AppContainer，或未使用沙箱。 */
export const SandboxMechanism = z.enum(['restricted-token', 'appcontainer', 'none'])
export type SandboxMechanism = z.infer<typeof SandboxMechanism>

/**
 * 一次命令执行实际使用的沙箱。写入 `command.started` / `tool.started` 与终端卡片，旧事件没有这个字段时
 * 按“未知/未启用”展示。
 */
export const SandboxExecution = z.object({
  profile: SandboxProfile,
  network: SandboxNetwork,
  mechanism: SandboxMechanism,
  /** OS 隔离是否生效；false 表示命令以应用用户权限运行。 */
  enforced: z.boolean(),
  /** 这个机制是否隔离网络；受限令牌与 `danger-full-access` 始终为 false。 */
  networkIsolated: z.boolean(),
  /** 未使用沙箱或不可用的原因代码。 */
  reason: z.string().optional(),
})
export type SandboxExecution = z.infer<typeof SandboxExecution>

/** 沙箱能力探测结果（诊断用，不包含项目内容、用户名或凭据）。 */
export const SandboxCapability = z.object({
  /** Windows 上所需能力都可用时为 true；其他平台为 false。 */
  available: z.boolean(),
  /** 当前平台是否支持 M5 的命令沙箱（目前只有 Windows）。 */
  supported: z.boolean(),
  mechanism: SandboxMechanism,
  networkIsolated: z.boolean(),
  checks: z.object({
    restrictedToken: z.boolean(),
    lowIntegrity: z.boolean(),
    jobObject: z.boolean(),
    appContainer: z.boolean(),
  }),
  reason: z.string().optional(),
})
export type SandboxCapability = z.infer<typeof SandboxCapability>

/** 沙箱不可用时的行为：默认失败关闭；`ask` 时经审批后本次不使用沙箱。 */
export const SandboxUnavailableBehavior = z.enum(['deny', 'ask'])
export type SandboxUnavailableBehavior = z.infer<typeof SandboxUnavailableBehavior>

/**
 * 沙箱的当前配置与能力（M5-05）：设置页与诊断包共用。`mechanism` 是用户选择的机制，
 * `capability.mechanism` 是实际可用的机制；两者不同表示已回退（例如 AppContainer 不可用）。
 */
export const SandboxStatus = z.object({
  platform: z.enum(['win32', 'other']),
  mechanism: z.enum(['restricted-token', 'appcontainer']),
  policy: SandboxPolicy,
  unavailable: SandboxUnavailableBehavior,
  capability: SandboxCapability,
})
export type SandboxStatus = z.infer<typeof SandboxStatus>

/** 默认策略：工作区可写，不授予网络能力（受限令牌下网络并未隔离，见 ADR-0034）。 */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  profile: 'workspace-write',
  network: 'none',
})

/** 默认档位与网络策略（设置中没有保存时使用）。 */
export const DEFAULT_SANDBOX_PROFILE: SandboxDefaultProfile = 'workspace-write'
export const DEFAULT_SANDBOX_NETWORK: SandboxNetwork = 'none'

/** 沙箱创建失败时默认失败关闭。 */
export const DEFAULT_SANDBOX_UNAVAILABLE: SandboxUnavailableBehavior = 'deny'

/** 由策略与能力探测得出实际执行描述。 */
export function sandboxExecution(
  policy: SandboxPolicy,
  capability: Pick<SandboxCapability, 'available' | 'mechanism' | 'networkIsolated' | 'reason'>,
): SandboxExecution {
  if (policy.profile === 'danger-full-access') {
    return {
      profile: policy.profile,
      network: policy.network,
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: 'sandbox.full_access',
    }
  }
  if (!capability.available || capability.mechanism === 'none') {
    return {
      profile: policy.profile,
      network: policy.network,
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: capability.reason ?? 'sandbox.unavailable',
    }
  }
  return {
    profile: policy.profile,
    network: policy.network,
    mechanism: capability.mechanism,
    enforced: true,
    networkIsolated: capability.networkIsolated,
  }
}
