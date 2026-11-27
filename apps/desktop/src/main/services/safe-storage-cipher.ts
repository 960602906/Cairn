/**
 * 用 Electron `safeStorage` 的异步接口实现 `SecretCipher`（M1-03a；同步接口在 Electron 45 已弃用）。
 *
 * Linux 上没有系统密钥环时，`safeStorage` 会退化为固定密钥的弱加密（后端为 `basic_text`）
 * 或报告 `unknown`。ADR-0051 起：只要 Electron 报告加密可用就接受这些后端并保存；
 * 系统加密完全不可用时，退回到本机文件编码（仅靠数据目录权限保护）。两者都不要求
 * 用户安装或解锁 GNOME Keyring / KWallet。
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

/** 本机回退密文的魔数前缀；与 `safeStorage` 输出区分，便于日后启用系统加密时仍能读回。 */
const LOCAL_PREFIX = Buffer.from('cairn-local-v1\0')

function looksLocal(data: Buffer): boolean {
  return (
    data.length >= LOCAL_PREFIX.length && data.subarray(0, LOCAL_PREFIX.length).equals(LOCAL_PREFIX)
  )
}

/**
 * 判断系统加密是否可用。Linux 的 `basic_text` / `unknown` 仍算可用（ADR-0051）；
 * 仅当 Electron 报告加密不可用时返回 false。
 */
export async function credentialAvailability(
  storage: SafeStorageLike,
  _platform: NodeJS.Platform = process.platform,
): Promise<CredentialAvailability> {
  if (!(await storage.isAsyncEncryptionAvailable())) {
    return { available: false, reason: 'system-encryption-unavailable' }
  }
  return { available: true }
}

/** 不依赖系统密钥环的本机编码：写入数据目录，仅靠文件权限保护（ADR-0051）。 */
export function createLocalFileCipher(): SecretCipher {
  return {
    isAvailable: async () => true,
    unavailableReason: async () => undefined,
    encrypt: async (plain) => Buffer.concat([LOCAL_PREFIX, Buffer.from(plain, 'utf8')]),
    decrypt: async (data) => {
      if (!looksLocal(data)) throw new Error('ciphertext is not local-file protected')
      return {
        plain: data.subarray(LOCAL_PREFIX.length).toString('utf8'),
        shouldReEncrypt: false,
      }
    },
  }
}

/**
 * 凭据加密：优先用系统 `safeStorage`（含 Linux 弱后端）；不可用时回退到本机文件编码。
 * 对外始终可用，因此设置页不再因密钥环缺失而禁用 Key 输入。
 */
export function createSafeStorageCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretCipher {
  const availability = () => credentialAvailability(storage, platform)
  const local = createLocalFileCipher()
  return {
    isAvailable: async () => true,
    unavailableReason: async () => undefined,
    encrypt: async (plain) => {
      if ((await availability()).available) return storage.encryptStringAsync(plain)
      return local.encrypt(plain)
    },
    decrypt: async (data) => {
      if (looksLocal(data)) return local.decrypt(data)
      const { result, shouldReEncrypt } = await storage.decryptStringAsync(data)
      // 若当前只能走本机回退，下次写入时改成本机编码，避免再依赖已消失的系统加密
      const preferLocal = !(await availability()).available
      return { plain: result, shouldReEncrypt: shouldReEncrypt || preferLocal }
    },
  }
}
