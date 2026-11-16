/**
 * 用 Electron `safeStorage` 的异步接口实现 `SecretCipher`（M1-03a；同步接口在 Electron 45 已弃用）。
 *
 * Linux 上没有系统密钥环时，`safeStorage` 会退化为固定密钥的弱加密（后端为 `basic_text`）。
 * 这里把这种情况与“系统加密根本不可用”“无法确定后端”区分开，统一视为不可用并给出原因
 * （ADR-0010、ADR-0040）；凭据存储因此拒绝保存，不退化为弱加密或明文。
 */
import type { CredentialUnavailableReason, SecretCipher } from './credential-store.js'

/** Electron `safeStorage` 中用到的部分。 */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
  getSelectedStorageBackend?(): string
}

export type CredentialAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: CredentialUnavailableReason }

/**
 * 判断能否安全保存 Key。只有确认后端在保护密钥时才算可用：
 * - 系统加密不可用（`isAsyncEncryptionAvailable` 为 false）：`system-encryption-unavailable`；
 * - Linux 后端为 `basic_text`（固定密钥）：`insecure-linux-backend`；
 * - Linux 后端缺失或为 `unknown`：`unknown-linux-backend`（无法确认，按不可用处理）；
 * - 其他平台与 Linux 的系统密钥环后端：可用。
 */
export async function credentialAvailability(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialAvailability> {
  if (!(await storage.isAsyncEncryptionAvailable())) {
    return { available: false, reason: 'system-encryption-unavailable' }
  }
  if (platform !== 'linux') return { available: true }
  const backend = storage.getSelectedStorageBackend?.()
  if (backend === 'basic_text') return { available: false, reason: 'insecure-linux-backend' }
  if (backend === undefined || backend === 'unknown') {
    return { available: false, reason: 'unknown-linux-backend' }
  }
  return { available: true }
}

export function createSafeStorageCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretCipher {
  const availability = () => credentialAvailability(storage, platform)
  return {
    isAvailable: async () => (await availability()).available,
    unavailableReason: async () => {
      const result = await availability()
      return result.available ? undefined : result.reason
    },
    encrypt: (plain) => storage.encryptStringAsync(plain),
    decrypt: async (data) => {
      const { result, shouldReEncrypt } = await storage.decryptStringAsync(data)
      return { plain: result, shouldReEncrypt }
    },
  }
}
