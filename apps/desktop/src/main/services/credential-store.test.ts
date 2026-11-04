import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@nexus/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialErrorCode,
  MAX_SECRET_LENGTH,
  createLocalKeyStore,
  type SecretCipher,
} from './credential-store.js'

const KEY = 'test-key-not-real-0123456789'

/** 假的加密：可逆变换，确认文件中不出现明文。 */
function fakeCipher(over: Partial<SecretCipher> = {}): SecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
    decrypt: (data) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return [...text.slice(4)].reverse().join('')
    },
    ...over,
  }
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-credentials-'))
  file = join(dir, 'credentials.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof RpcError ? e.code : String(e)
  }
  return undefined
}
const asyncCodeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => (e instanceof RpcError ? e.code : String(e)),
  )

describe('createLocalKeyStore', () => {
  it('加密保存，解析得到原文；文件中没有明文', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher(), now: () => 1000 })
    expect(store.kind).toBe('local-key')
    expect(store.has('deepseek')).toBe(false)
    expect(await store.resolve('deepseek')).toBeUndefined()

    store.set('deepseek', `  ${KEY}\n`)
    expect(store.has('deepseek')).toBe(true)
    expect(await store.resolve('deepseek')).toEqual({ apiKey: KEY })

    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toEqual({
      version: 1,
      credentials: {
        deepseek: {
          kind: 'local-key',
          ciphertext: fakeCipher().encrypt(KEY).toString('base64'),
          updatedAt: 1000,
        },
      },
    })
    expect(readdirSync(dir)).toEqual(['credentials.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('重新打开后仍可解析；覆盖与删除', async () => {
    createLocalKeyStore({ file, cipher: fakeCipher() }).set('a', KEY)
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(await store.resolve('a')).toEqual({ apiKey: KEY })

    store.set('a', 'second-key')
    store.set('b', 'b-key')
    expect(await store.resolve('a')).toEqual({ apiKey: 'second-key' })

    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
    expect(store.has('a')).toBe(false)
    const reopened = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(reopened.has('a')).toBe(false)
    expect(await reopened.resolve('b')).toEqual({ apiKey: 'b-key' })
  })

  it('拒绝无效的引用与值', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    for (const ref of ['', 'a b', 'x/y', 'a'.repeat(129), '__proto__!']) {
      expect(
        codeOf(() => store.set(ref, KEY)),
        ref,
      ).toBe(CredentialErrorCode.InvalidRef)
      expect(
        codeOf(() => store.delete(ref)),
        ref,
      ).toBe(CredentialErrorCode.InvalidRef)
      expect(await asyncCodeOf(store.resolve(ref)), ref).toBe(CredentialErrorCode.InvalidRef)
      expect(store.has(ref)).toBe(false)
    }
    expect(codeOf(() => store.set('a', '   '))).toBe(CredentialErrorCode.InvalidValue)
    expect(codeOf(() => store.set('a', 'k'.repeat(MAX_SECRET_LENGTH + 1)))).toBe(
      CredentialErrorCode.InvalidValue,
    )
    store.set('a', 'k'.repeat(MAX_SECRET_LENGTH))
    expect(store.has('a')).toBe(true)
  })

  it('原型上的名称不被当作已保存', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(store.has('constructor')).toBe(false)
    expect(await store.resolve('toString')).toBeUndefined()
    expect(store.delete('hasOwnProperty')).toBe(false)
  })

  it('系统加密不可用时拒绝保存与解析', async () => {
    createLocalKeyStore({ file, cipher: fakeCipher() }).set('a', KEY)
    const store = createLocalKeyStore({ file, cipher: fakeCipher({ isAvailable: () => false }) })
    expect(codeOf(() => store.set('b', KEY))).toBe(CredentialErrorCode.Unavailable)
    expect(await asyncCodeOf(store.resolve('a'))).toBe(CredentialErrorCode.Unavailable)
    expect(store.has('a')).toBe(true)
    expect(store.has('b')).toBe(false)
  })

  it('加密失败报不可用，解密失败报 decrypt_failed，错误中不含 Key', async () => {
    const onError = vi.fn()
    const store = createLocalKeyStore({
      file,
      onError,
      cipher: fakeCipher({
        encrypt: () => {
          throw new Error('encryption failed')
        },
      }),
    })
    expect(codeOf(() => store.set('a', KEY))).toBe(CredentialErrorCode.Unavailable)
    expect(store.has('a')).toBe(false)

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        credentials: { a: { kind: 'local-key', ciphertext: 'bm90LWVuYw==', updatedAt: 1 } },
      }),
    )
    const other = createLocalKeyStore({ file, onError, cipher: fakeCipher() })
    expect(await asyncCodeOf(other.resolve('a'))).toBe(CredentialErrorCode.DecryptFailed)
    expect(JSON.stringify(onError.mock.calls.map((c) => String(c[0])))).not.toContain(KEY)
  })

  it('文件无法解析或版本不支持时视为空，写入前备份原文件', async () => {
    for (const content of ['not json', '[]', '{"version":2,"credentials":{}}']) {
      writeFileSync(file, content)
      const onError = vi.fn()
      const store = createLocalKeyStore({ file, onError, cipher: fakeCipher(), now: () => 42 })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(store.has('a')).toBe(false)

      store.set('a', KEY)
      expect(readFileSync(join(dir, 'credentials.json.bak-42'), 'utf8')).toBe(content)
      expect(await createLocalKeyStore({ file, cipher: fakeCipher() }).resolve('a')).toEqual({
        apiKey: KEY,
      })
      // 只备份一次
      store.set('b', KEY)
      expect(readdirSync(dir).sort()).toEqual(['credentials.json', 'credentials.json.bak-42'])
      rmSync(join(dir, 'credentials.json.bak-42'))
    }
  })

  it('忽略无效的条目与缺失的 credentials 字段', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        credentials: {
          ok: { kind: 'local-key', ciphertext: 'eA==', updatedAt: 1 },
          'bad ref': { kind: 'local-key', ciphertext: 'eA==', updatedAt: 1 },
          relay: { kind: 'relay', ciphertext: 'eA==', updatedAt: 1 },
          broken: { kind: 'local-key' },
          nul: null,
        },
      }),
    )
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(['ok', 'relay', 'broken', 'nul'].map((r) => store.has(r))).toEqual([
      true,
      false,
      false,
      false,
    ])

    writeFileSync(file, JSON.stringify({ version: 1 }))
    expect(createLocalKeyStore({ file, cipher: fakeCipher() }).has('ok')).toBe(false)
  })

  it('读取失败（不是文件不存在）时报告', () => {
    mkdirSync(file)
    const onError = vi.fn()
    const store = createLocalKeyStore({ file, onError, cipher: fakeCipher() })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(store.has('a')).toBe(false)
  })

  it('写入失败时报 write_failed，内存中的状态不变', async () => {
    const onError = vi.fn()
    const store = createLocalKeyStore({
      file: join(dir, 'missing', 'credentials.json'),
      onError,
      cipher: fakeCipher(),
    })
    expect(codeOf(() => store.set('a', KEY))).toBe(CredentialErrorCode.WriteFailed)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(store.has('a')).toBe(false)
  })
})
