/** 沙箱执行描述的中英文案（M5-05）：终端、审批卡片与设置页共用。 */
import type { TFunction } from '@cairn/i18n'
import type { SandboxExecution } from '@cairn/protocol'

export interface SandboxLabels {
  readonly profile: string
  readonly network: string
  readonly mechanism: string
  /** “沙箱：工作区可写 · 无网络”或“未沙箱化：原因”。 */
  readonly summary: string
  /** 需要用户留意的警告；没有时为 undefined。 */
  readonly warning: string | undefined
  readonly reason: string | undefined
}

/** 由 `SandboxExecution` 得到可读文案；`t` 使用 `common` 命名空间。 */
export function sandboxLabels(t: TFunction, execution: SandboxExecution): SandboxLabels {
  const profile = t(`sandbox.profile.${execution.profile}`)
  const mechanism = t(`sandbox.mechanism.${execution.mechanism}`)
  const reason = execution.enforced ? undefined : sandboxReason(t, execution.reason)
  const network = execution.enforced
    ? execution.networkIsolated
      ? t(`sandbox.network.${execution.network}`)
      : t('sandbox.network.notIsolated')
    : t('sandbox.network.notIsolated')
  return {
    profile,
    network,
    mechanism,
    summary: execution.enforced
      ? t('sandbox.summary', { profile, network })
      : t('sandbox.unsandboxed', { reason }),
    warning: execution.enforced
      ? execution.networkIsolated
        ? undefined
        : t('sandbox.networkWarning')
      : t('sandbox.outsideWarning'),
    reason,
  }
}

export function sandboxReason(t: TFunction, code: string | undefined): string {
  const suffix = (code ?? 'sandbox.unavailable').replace(/^sandbox\./, '').replaceAll('.', '_')
  return t(`sandbox.reason.${suffix}`, { defaultValue: t('sandbox.reason.unknown') })
}
