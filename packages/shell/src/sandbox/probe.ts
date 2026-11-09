/**
 * 沙箱能力探测（M5-04）：创建受限令牌、设置低完整性、创建 Job Object、派生 AppContainer SID。
 * 结果只包含能力布尔值与错误码，不含路径、用户名或凭据。
 */
import { createSandboxJob, type SandboxJobFactory } from './job.js'
import { unsupportedCapability, type SandboxCapability, type SandboxMechanism } from './types.js'
import { loadSandboxNativeApi, type SandboxNativeApi } from './windows-api.js'

export interface ProbeOptions {
  readonly platform?: NodeJS.Platform
  /** undefined：按平台加载；null：视为不可用（测试用）。 */
  readonly api?: SandboxNativeApi | null | undefined
  readonly mechanism?: Exclude<SandboxMechanism, 'none'>
  /** 用于派生 SID 的稳定名称；不创建 AppContainer 配置。 */
  readonly appContainerName?: string
  readonly jobFactory?: SandboxJobFactory
}

export const PROBE_APP_CONTAINER_NAME = 'com.cairn.sandbox.probe'

export async function probeCapability(options: ProbeOptions = {}): Promise<SandboxCapability> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return unsupportedCapability()
  const api = options.api === undefined ? await loadSandboxNativeApi(platform) : options.api
  if (!api) {
    return {
      available: false,
      supported: true,
      mechanism: 'none',
      networkIsolated: false,
      checks: {
        restrictedToken: false,
        lowIntegrity: false,
        jobObject: false,
        appContainer: false,
      },
      reason: 'sandbox.native_unavailable',
    }
  }

  const checks = {
    restrictedToken: false,
    lowIntegrity: false,
    jobObject: false,
    appContainer: false,
  }
  try {
    const token = api.createRestrictedToken('low')
    checks.restrictedToken = true
    checks.lowIntegrity = true
    api.closeHandle(token)
  } catch {
    // 受限令牌与低完整性一起验证：创建成功才说明两者都可用
  }

  const job = await (options.jobFactory ?? createSandboxJob)()
  if (job) {
    job.close()
    checks.jobObject = true
  }

  try {
    const sid = api.deriveAppContainer(options.appContainerName ?? PROBE_APP_CONTAINER_NAME)
    api.closeHandle(sid)
    checks.appContainer = true
  } catch {
    // AppContainer 不可用不影响受限令牌档位
  }

  const requested = options.mechanism ?? 'restricted-token'
  const mechanism: SandboxMechanism =
    requested === 'appcontainer' && checks.appContainer
      ? 'appcontainer'
      : checks.restrictedToken && checks.lowIntegrity && checks.jobObject
        ? 'restricted-token'
        : 'none'
  const available = mechanism !== 'none'
  const fellBack = requested === 'appcontainer' && !checks.appContainer && mechanism !== 'none'
  return {
    available,
    supported: true,
    mechanism,
    // 只有 AppContainer 档位隔离网络；受限令牌档位网络未隔离（ADR-0034）
    networkIsolated: mechanism === 'appcontainer',
    checks,
    ...(available
      ? fellBack
        ? { reason: 'sandbox.appcontainer_unavailable' }
        : {}
      : {
          reason:
            requested === 'appcontainer' && !checks.appContainer
              ? 'sandbox.appcontainer_unavailable'
              : 'sandbox.restricted_token_unavailable',
        }),
  }
}
