/**
 * `local-key` 凭据存储（M1-03a；ADR-0010，架构 §16.2）：用户自带的 API Key 经系统加密
 * （Electron `safeStorage`，Windows 下为 DPAPI）后保存在数据目录的 `credentials.json`，
 * 不进 SQLite，也不进 `settings.json`。只由主进程读写，明文只在 `resolve` 时得到。
 *
 * 文件格式（`version` 1）：
 *
 * ```json
 * { "version": 1, "credentials": { "<ref>": { "kind": "local-key", "ciphertext": "<base64>", "updatedAt": 1767225600000 } } }
 * ```
 *
 * - 系统加密不可用时（如 Linux 没有密钥环）拒绝保存与读取，报 `credentials.unavailable`，不退化为
 *   弱加密或明文（M6 再处理）；
 * - 文件无法解析或版本不支持时视为没有凭据；下次写入前把原文件改名备份（`credentials.json.bak-<时间>`），
 *   不会覆盖掉新版本应用写入的数据；
 * - 先写临时文件再改名替换；POSIX 上文件权限为 0600；
 * - 解密时系统提示密钥已轮换（`shouldReEncrypt`），用新密钥重新加密保存（失败只报告，不影响本次解析）。
 *
 * 不依赖 Electron：加密实现由调用方传入（`safe-storage-cipher.ts`），单元测试用假的实现。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isCredentialRef, type CredentialProvider, type ResolvedCredential } from '@cairn/core'
import { RpcError, type MainForRenderer } from '@cairn/protocol'
import type { z } from 'zod'

export const CredentialErrorCode = {
  /** 系统加密不可用。 */
  Unavailable: 'credentials.unavailable',
  InvalidRef: 'credentials.invalid_ref',
  /** Key 为空或过长。 */
  InvalidValue: 'credentials.invalid_value',
  WriteFailed: 'credentials.write_failed',
  /** 无法解密（例如文件来自另一台电脑或另一个系统用户）。 */
  DecryptFailed: 'credentials.decrypt_failed',
} as const

export const CREDENTIALS_FILE_VERSION = 1
/** Key 的最大长度（字符）。 */
export const MAX_SECRET_LENGTH = 4096

/** 系统加密。 */
export interface SecretCipher {
  isAvailable(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  /** `shouldReEncrypt`：系统密钥已轮换，应重新加密保存。 */
  decrypt(data: Buffer): Promise<{ readonly plain: string; readonly shouldReEncrypt: boolean }>
}

export interface LocalKeyStoreOptions {
  readonly file: string
  readonly cipher: SecretCipher
  /** 文件无法读取、解析或写入时调用（文件不存在不算）。不含 Key。 */
  readonly onError?: (error: unknown) => void
  readonly now?: () => number
}

export interface LocalKeyStore extends CredentialProvider {
  /** 加密保存（覆盖已有的）。Key 去掉首尾空白。 */
  set(ref: string, secret: string): Promise<void>
  /** 删除；返回是否存在过。 */
  delete(ref: string): Promise<boolean>
  /** 是否保存过（不解密）。 */
  has(ref: string): boolean
  /** 系统加密是否可用。 */
  available(): Promise<boolean>
  /** 本进程中保存或解析过的 Key，供日志脱敏按原文替换（`@cairn/core` 的 `redact`）。 */
  knownSecrets(): readonly string[]
}

interface StoredEntry {
  readonly kind: 'local-key'
  readonly ciphertext: string
  readonly updatedAt: number
}

type Entries = Readonly<Record<string, StoredEntry>>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isEntry = (value: unknown): value is StoredEntry =>
  isRecord(value) &&
  value['kind'] === 'local-key' &&
  typeof value['ciphertext'] === 'string' &&
  typeof value['updatedAt'] === 'number'

interface Loaded {
  readonly entries: Entries
  /** 文件存在但无法使用，写入前需要备份。 */
  readonly unreadable: boolean
}

function load(file: string, onError: ((error: unknown) => void) | undefined): Loaded {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error)
    return { entries: {}, unreadable: false }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('credentials file is not a JSON object')
    if (value['version'] !== CREDENTIALS_FILE_VERSION) {
      throw new Error(`unsupported credentials file version ${String(value['version'])}`)
    }
    const credentials = isRecord(value['credentials']) ? value['credentials'] : {}
    const entries = Object.fromEntries(
      Object.entries(credentials).filter(([ref, entry]) => isCredentialRef(ref) && isEntry(entry)),
    ) as Entries
    return { entries, unreadable: false }
  } catch (error) {
    onError?.(error)
    return { entries: {}, unreadable: true }
  }
}

export function createLocalKeyStore(options: LocalKeyStoreOptions): LocalKeyStore {
  const { file, cipher, onError } = options
  const now = options.now ?? Date.now
  const loaded = load(file, onError)
  let entries = loaded.entries
  let unreadable = loaded.unreadable
  const seen = new Set<string>()

  const checkRef = (ref: string) => {
    if (!isCredentialRef(ref)) throw new RpcError(CredentialErrorCode.InvalidRef)
  }
  const checkAvailable = async () => {
    if (!(await cipher.isAvailable())) throw new RpcError(CredentialErrorCode.Unavailable)
  }
  const encrypt = async (value: string): Promise<StoredEntry> => {
    try {
      const data = await cipher.encrypt(value)
      return { kind: 'local-key', ciphertext: data.toString('base64'), updatedAt: now() }
    } catch (error) {
      onError?.(error)
      throw new RpcError(CredentialErrorCode.Unavailable)
    }
  }

  const write = (next: Entries) => {
    const temp = `${file}.tmp`
    try {
      if (unreadable) renameSync(file, `${file}.bak-${now()}`)
      unreadable = false
      const body = { version: CREDENTIALS_FILE_VERSION, credentials: next }
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, file)
    } catch (error) {
      onError?.(error)
      throw new RpcError(CredentialErrorCode.WriteFailed)
    }
    entries = next
  }

  return {
    kind: 'local-key',

    async set(ref, secret) {
      checkRef(ref)
      const value = secret.trim()
      if (value === '' || value.length > MAX_SECRET_LENGTH) {
        throw new RpcError(CredentialErrorCode.InvalidValue)
      }
      seen.add(value)
      await checkAvailable()
      const entry = await encrypt(value)
      write({ ...entries, [ref]: entry })
    },

    async delete(ref) {
      checkRef(ref)
      if (!Object.hasOwn(entries, ref)) return false
      const { [ref]: _removed, ...rest } = entries
      write(rest)
      return true
    },

    has(ref) {
      return isCredentialRef(ref) && Object.hasOwn(entries, ref)
    },

    available: () => cipher.isAvailable(),

    knownSecrets: () => [...seen],

    async resolve(ref): Promise<ResolvedCredential | undefined> {
      checkRef(ref)
      const entry = Object.hasOwn(entries, ref) ? entries[ref] : undefined
      if (!entry) return undefined
      await checkAvailable()
      let decrypted: Awaited<ReturnType<SecretCipher['decrypt']>>
      try {
        decrypted = await cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'))
      } catch (error) {
        onError?.(error)
        throw new RpcError(CredentialErrorCode.DecryptFailed)
      }
      if (decrypted.shouldReEncrypt) {
        try {
          const fresh = await encrypt(decrypted.plain)
          // 期间被删除或覆盖时不写回
          if (entries[ref] === entry) write({ ...entries, [ref]: fresh })
        } catch {
          // 已由 encrypt / write 报告；旧密文仍可用
        }
      }
      seen.add(decrypted.plain)
      return { apiKey: decrypted.plain }
    },
  }
}

type RendererRequests = (typeof MainForRenderer)['requests']
type Command<M extends keyof RendererRequests> = (
  params: z.output<RendererRequests[M]['params']>,
) => Promise<z.input<RendererRequests[M]['result']>>

/** 界面的凭据命令（M1-03b）：只能写入、删除与查询是否已配置，不返回明文（只给末 4 位，M2-10）。 */
export interface CredentialCommands {
  readonly set: Command<'credentials.set'>
  readonly delete: Command<'credentials.delete'>
  readonly status: Command<'credentials.status'>
}

export function createCredentialCommands(store: LocalKeyStore): CredentialCommands {
  return {
    set: async ({ ref, secret }) => {
      await store.set(ref, secret)
      return {}
    },
    delete: async ({ ref }) => ({ deleted: await store.delete(ref) }),
    status: async ({ ref }) => {
      const configured = store.has(ref)
      const available = await store.available()
      // 末 4 位（M2-10）只在 Key 足够长时给出；解密失败时不给，不影响状态
      let last4: string | undefined
      if (configured && available) {
        const key = await store.resolve(ref).catch(() => undefined)
        if (key && key.apiKey.length >= 8) last4 = key.apiKey.slice(-4)
      }
      return { configured, available, ...(last4 ? { last4 } : {}) }
    },
  }
}
