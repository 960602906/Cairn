/**
 * 用 Electron `safeStorage` 的异步接口实现 `SecretCipher`（M1-03a；同步接口在 Electron 45 已弃用）。
 *
 * Linux 上没有系统密钥环时，`safeStorage` 会退化为固定密钥的弱加密（后端为 `basic_text`），
 * 这里视为不可用，凭据存储因此拒绝保存（ADR-0010；M6 再提供退化方案与提示）。
 */
import type { SecretCipher } from './credential-store.js'

/** Electron `safeStorage` 中用到的部分。 */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
  getSelectedStorageBackend?(): string
}

export function createSafeStorageCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretCipher {
  return {
    isAvailable: async () => {
      if (!(await storage.isAsyncEncryptionAvailable())) return false
      if (platform !== 'linux') return true
      const backend = storage.getSelectedStorageBackend?.()
      return backend !== undefined && backend !== 'basic_text' && backend !== 'unknown'
    },
    encrypt: (plain) => storage.encryptStringAsync(plain),
    decrypt: async (data) => {
      const { result, shouldReEncrypt } = await storage.decryptStringAsync(data)
      return { plain: result, shouldReEncrypt }
    },
  }
}
