/**
 * 命令沙箱服务（M5-04，ADR-0034）：解析设置、探测能力、给出宿主与后台命令使用的执行器。
 *
 * - 默认档位 `workspace-write`、网络 `none`、不可用时失败关闭；`danger-full-access` 不能保存为默认值。
 * - 能力只探测一次（启动后），结果写入诊断；非 Windows 平台标记为“不支持”，M5 不改变现有命令语义。
 * - AppContainer 仅作为实验机制（`CAIRN_SANDBOX_MECHANISM=appcontainer`）；默认使用受限令牌。
 * - 这里不做路径或项目内容记录；配置名由安装标识的摘要生成，能力结果不包含用户名与路径。
 */
import { createHash } from 'node:crypto'
import {
  appContainerName,
  createSandboxRunner,
  loadSandboxNativeApi,
  probeCapability,
  type SandboxCapability,
  type SandboxNativeApi,
  type SandboxPolicy,
  type SandboxRunner,
  type SandboxUnavailableBehavior,
} from '@cairn/shell'
import {
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_PROFILE,
  DEFAULT_SANDBOX_UNAVAILABLE,
  sandboxExecution,
  type SandboxExecution,
  type SandboxStatus,
  type Settings,
} from '@cairn/protocol'

export type SandboxMechanismPreference = 'restricted-token' | 'appcontainer'

export interface SandboxHostInit {
  readonly policy: SandboxPolicy
  readonly capability: SandboxCapability
  readonly unavailable: SandboxUnavailableBehavior
  readonly appContainerName?: string
}

export type SandboxDiagnostics = SandboxStatus

export interface SandboxServiceOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly settings: () => Settings
  /** 稳定的安装标识（应用标识 + 数据目录等）；只用于生成 AppContainer 名称的摘要。 */
  readonly identity: string
  /** 测试用：替换能力探测。 */
  readonly probe?: (mechanism: SandboxMechanismPreference) => Promise<SandboxCapability>
  /** 测试用：替换执行器创建。 */
  readonly createRunner?: (options: {
    readonly mechanism: SandboxMechanismPreference
    readonly capability: SandboxCapability
    readonly appContainerName?: string
  }) => Promise<SandboxRunner>
  /** 测试用：替换本地 API 加载（清理 AppContainer 配置时使用）。 */
  readonly api?: (platform: NodeJS.Platform) => Promise<SandboxNativeApi | undefined>
  readonly onError?: (error: unknown) => void
}

export interface SandboxService {
  /** 当前设置解析出的策略（默认 `workspace-write` + `none`）。 */
  policy(): SandboxPolicy
  unavailable(): SandboxUnavailableBehavior
  capability(): Promise<SandboxCapability>
  execution(): Promise<SandboxExecution>
  /** 宿主初始化用；AppContainer 档位带上配置名。 */
  hostInit(): Promise<SandboxHostInit>
  /** 后台命令用；能力不可用时为 undefined（宿主已按守卫审批或拒绝）。 */
  forCommands(): Promise<
    { readonly runner: SandboxRunner; readonly policy: SandboxPolicy } | undefined
  >
  diagnostics(): Promise<SandboxDiagnostics>
  /** 删除实验性 AppContainer 配置；默认档位与运行中的命令不受影响。 */
  cleanup(): Promise<void>
}

export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const mechanism: SandboxMechanismPreference =
    env['CAIRN_SANDBOX_MECHANISM'] === 'appcontainer' ? 'appcontainer' : 'restricted-token'
  const name =
    mechanism === 'appcontainer'
      ? appContainerName(
          createHash('sha256').update(`${options.identity}|${mechanism}`).digest('hex'),
        )
      : undefined

  let capabilityPromise: Promise<SandboxCapability> | undefined
  let runnerPromise: Promise<SandboxRunner> | undefined

  const capability = (): Promise<SandboxCapability> => {
    capabilityPromise ??= (options.probe ?? defaultProbe)(mechanism).catch((error: unknown) => {
      options.onError?.(error)
      return unsupportedProbeResult(platform === 'win32')
    })
    return capabilityPromise
  }

  const runner = (): Promise<SandboxRunner> => {
    runnerPromise ??= (async () => {
      const create = options.createRunner ?? defaultCreateRunner
      return create({
        mechanism,
        capability: await capability(),
        ...(name ? { appContainerName: name } : {}),
      })
    })().catch((error: unknown) => {
      runnerPromise = undefined
      options.onError?.(error)
      throw error
    })
    return runnerPromise
  }

  const policy = (): SandboxPolicy => {
    const settings = options.settings()
    return {
      profile: settings.sandboxProfile ?? DEFAULT_SANDBOX_PROFILE,
      network: settings.sandboxNetwork ?? DEFAULT_SANDBOX_NETWORK,
    }
  }

  const defaultProbe = (preference: SandboxMechanismPreference) =>
    probeCapability({ platform, mechanism: preference })

  const defaultCreateRunner = (input: {
    readonly mechanism: SandboxMechanismPreference
    readonly capability: SandboxCapability
    readonly appContainerName?: string
  }) =>
    createSandboxRunner({
      platform,
      env,
      mechanism: input.mechanism,
      capability: input.capability,
      ...(input.appContainerName ? { appContainer: { name: input.appContainerName } } : {}),
    })

  return {
    policy,
    unavailable: () => options.settings().sandboxUnavailable ?? DEFAULT_SANDBOX_UNAVAILABLE,
    capability,
    async execution() {
      return sandboxExecution(policy(), await capability())
    },
    async hostInit() {
      return {
        policy: policy(),
        capability: await capability(),
        unavailable: options.settings().sandboxUnavailable ?? DEFAULT_SANDBOX_UNAVAILABLE,
        ...(name ? { appContainerName: name } : {}),
      }
    },
    async forCommands() {
      const probed = await capability()
      if (!probed.available || probed.mechanism === 'none') return undefined
      return { runner: await runner(), policy: policy() }
    },
    async diagnostics() {
      return {
        platform: platform === 'win32' ? 'win32' : 'other',
        mechanism,
        policy: policy(),
        unavailable: options.settings().sandboxUnavailable ?? DEFAULT_SANDBOX_UNAVAILABLE,
        capability: await capability(),
      }
    },
    async cleanup() {
      if (!name) return
      const api = await (options.api ?? loadSandboxNativeApi)(platform)
      api?.deleteAppContainer(name)
    },
  }
}

/** 探测异常时的保守结果：不声称支持，也不影响应用启动。 */
function unsupportedProbeResult(supported: boolean): SandboxCapability {
  return {
    available: false,
    supported,
    mechanism: 'none',
    networkIsolated: false,
    checks: {
      restrictedToken: false,
      lowIntegrity: false,
      jobObject: false,
      appContainer: false,
    },
    reason: 'sandbox.probe_failed',
  }
}
