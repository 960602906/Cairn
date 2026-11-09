/**
 * 命令沙箱的公共类型（M5-04，ADR-0034）。`@cairn/shell` 不依赖协议包：这里的类型与
 * `@cairn/protocol` 的 `SandboxPolicy` / `SandboxExecution` / `SandboxCapability` 结构一致，
 * 由调用方在边界上直接传递。
 */
import type { ShellInvocation } from '../invocation.js'

export type SandboxProfile = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SandboxNetwork = 'none' | 'internet' | 'private'
export type SandboxMechanism = 'restricted-token' | 'appcontainer' | 'none'
export type SandboxUnavailableBehavior = 'deny' | 'ask'

export interface SandboxPolicy {
  readonly profile: SandboxProfile
  readonly network: SandboxNetwork
}

/** 一次命令实际使用的沙箱。 */
export interface SandboxExecution {
  readonly profile: SandboxProfile
  readonly network: SandboxNetwork
  readonly mechanism: SandboxMechanism
  readonly enforced: boolean
  readonly networkIsolated: boolean
  readonly reason?: string | undefined
}

export interface SandboxCapability {
  readonly available: boolean
  readonly supported: boolean
  readonly mechanism: SandboxMechanism
  readonly networkIsolated: boolean
  readonly checks: {
    readonly restrictedToken: boolean
    readonly lowIntegrity: boolean
    readonly jobObject: boolean
    readonly appContainer: boolean
  }
  readonly reason?: string | undefined
}

export const SandboxErrorCode = {
  /** 沙箱不可用（非 Windows、缺少 Win32 能力、配置缺失）。 */
  Unavailable: 'sandbox.unavailable',
  /** 准备沙箱失败（受限令牌、完整性标签、临时目录、ACL 等）。 */
  SetupFailed: 'sandbox.setup_failed',
  /** 沙箱进程无法启动。 */
  SpawnFailed: 'sandbox.spawn_failed',
} as const

export class SandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Readonly<Record<string, string>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SandboxError'
  }
}

/** 取消信号（与 `run.ts` 的 `ShellAbortSignal` 结构相同，避免循环依赖）。 */
export interface SandboxAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface SandboxRunInput {
  readonly invocation: ShellInvocation
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** 超时（毫秒），0 表示不限时。 */
  readonly timeoutMs: number
  readonly signal?: SandboxAbortSignal
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
}

export interface SandboxRunResult {
  readonly exitCode: number | null
  readonly aborted: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  readonly execution: SandboxExecution
}

export interface SandboxRunner {
  readonly capability: SandboxCapability
  /** 按策略与能力得出实际执行描述（不启动进程）。 */
  executionFor(policy: SandboxPolicy): SandboxExecution
  /** 在沙箱内运行一次命令；失败时抛出 `SandboxError`，调用方默认失败关闭。 */
  run(policy: SandboxPolicy, input: SandboxRunInput): Promise<SandboxRunResult>
}

/** 未使用沙箱的执行描述（`danger-full-access` 或平台不支持）。 */
export function unsandboxedExecution(
  policy: SandboxPolicy,
  reason = 'sandbox.full_access',
): SandboxExecution {
  return {
    profile: policy.profile,
    network: policy.network,
    mechanism: 'none',
    enforced: false,
    networkIsolated: false,
    reason,
  }
}

/** 由策略与能力得出实际执行描述。 */
export function sandboxExecution(
  policy: SandboxPolicy,
  capability: Pick<SandboxCapability, 'available' | 'mechanism' | 'networkIsolated' | 'reason'>,
): SandboxExecution {
  if (policy.profile === 'danger-full-access') return unsandboxedExecution(policy)
  if (!capability.available || capability.mechanism === 'none') {
    return unsandboxedExecution(policy, capability.reason ?? 'sandbox.unavailable')
  }
  return {
    profile: policy.profile,
    network: policy.network,
    mechanism: capability.mechanism,
    enforced: true,
    networkIsolated: capability.networkIsolated,
  }
}

/** 平台不支持时返回的能力探测结果。 */
export function unsupportedCapability(reason = 'sandbox.platform_unsupported'): SandboxCapability {
  return {
    available: false,
    supported: false,
    mechanism: 'none',
    networkIsolated: false,
    checks: {
      restrictedToken: false,
      lowIntegrity: false,
      jobObject: false,
      appContainer: false,
    },
    reason,
  }
}
