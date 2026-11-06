/**
 * 凭据提供方（ADR-0010，架构 §16.2，M1-03）。模型配置只保存凭据引用（`credentialRef`），
 * 明文只由主进程中的提供方解析，在 `host.init` 时传给对应会话的宿主。
 *
 * 第一版只有 `local-key`（用户自带的 API Key，用系统加密保存）；以后的中转、OAuth 等
 * 只需新增实现，调用方不变。
 */

import { CREDENTIAL_REF_PATTERN } from '@cairn/protocol'

export type CredentialKind = 'local-key'

export interface ResolvedCredential {
  readonly apiKey: string
}

export interface CredentialProvider {
  readonly kind: CredentialKind
  /** 解析凭据；没有保存过时返回 undefined，无法解密等情况抛出带错误码的错误。 */
  resolve(ref: string): Promise<ResolvedCredential | undefined>
}

/** 凭据引用的格式见 `@cairn/protocol` 的 `CREDENTIAL_REF_PATTERN`。 */
export function isCredentialRef(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
}
