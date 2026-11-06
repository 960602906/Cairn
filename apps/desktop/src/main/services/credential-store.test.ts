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
import { RpcError } from '@cairn/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialErrorCode,
  MAX_SECRET_LENGTH,
  createCredentialCommands,
  createLocalKeyStore,
  type SecretCipher,
} from './credential-store.js'

const KEY = 'test-key-not-real-0123456789'

const reverse = (text: string) => [...text].reverse().join('')

/** 假的加密：可逆变换，确认文件中不出现明文。`version` 模拟系统密钥轮换。 */
function fakeCipher(over: Partial<SecretCipher> = {}, version = 1): SecretCipher {
  return {
    isAvailable: async () => true,
    encrypt: async (plain) => Buffer.from(`enc${version}:${reverse(plain)}`, 'utf8'),
    decrypt: async (data) => {
      const match = /^enc(\d+):(.*)$/s.exec(data.toString('utf8'))
      if (!match) throw new Error('bad ciphertext')
      return { plain: reverse(match[2]!), shouldReEncrypt: Number(match[1]) < version }
    },
    ...over,
  }
}

const ciphertextOf = (plain: string, version = 1) =>
  Buffer.from(`enc${version}:${reverse(plain)}`, 'utf8').toString('base64')

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-credentials-'))
  file = join(dir, 'credentials.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const codeOf = async (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (e: unknown) => (e instanceof RpcError ? e.code : String(e)),
  )

const stored = () =>
  JSON.parse(readFileSync(file, 'utf8')) as {
    credentials: Record<string, { ciphertext: string; updatedAt: number }>
  }

describe('createLocalKeyStore', () => {
  it('加密保存，解析得到原文；文件中没有明文', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher(), now: () => 1000 })
    expect(store.kind).toBe('local-key')
    expect(store.has('deepseek')).toBe(false)
    expect(await store.resolve('deepseek')).toBeUndefined()

    await store.set('deepseek', `  ${KEY}\n`)
    expect(store.has('deepseek')).toBe(true)
    expect(await store.resolve('deepseek')).toEqual({ apiKey: KEY })

    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toEqual({
      version: 1,
      credentials: {
        deepseek: { kind: 'local-key', ciphertext: ciphertextOf(KEY), updatedAt: 1000 },
      },
    })
    expect(readdirSync(dir)).toEqual(['credentials.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('重新打开后仍可解析；覆盖与删除', async () => {
    await createLocalKeyStore({ file, cipher: fakeCipher() }).set('a', KEY)
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(await store.resolve('a')).toEqual({ apiKey: KEY })

    await store.set('a', 'second-key')
    await store.set('b', 'b-key')
    expect(await store.resolve('a')).toEqual({ apiKey: 'second-key' })

    expect(await store.delete('a')).toBe(true)
    expect(await store.delete('a')).toBe(false)
    expect(store.has('a')).toBe(false)
    const reopened = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(reopened.has('a')).toBe(false)
    expect(await reopened.resolve('b')).toEqual({ apiKey: 'b-key' })
  })

  it('拒绝无效的引用与值', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    for (const ref of ['', 'a b', 'x/y', 'a'.repeat(129), '__proto__!']) {
      expect(await codeOf(() => store.set(ref, KEY)), ref).toBe(CredentialErrorCode.InvalidRef)
      expect(await codeOf(() => store.delete(ref)), ref).toBe(CredentialErrorCode.InvalidRef)
      expect(await codeOf(() => store.resolve(ref)), ref).toBe(CredentialErrorCode.InvalidRef)
      expect(store.has(ref)).toBe(false)
    }
    expect(await codeOf(() => store.set('a', '   '))).toBe(CredentialErrorCode.InvalidValue)
    expect(await codeOf(() => store.set('a', 'k'.repeat(MAX_SECRET_LENGTH + 1)))).toBe(
      CredentialErrorCode.InvalidValue,
    )
    await store.set('a', 'k'.repeat(MAX_SECRET_LENGTH))
    expect(store.has('a')).toBe(true)
  })

  it('原型上的名称不被当作已保存', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(store.has('constructor')).toBe(false)
    expect(await store.resolve('toString')).toBeUndefined()
    expect(await store.delete('hasOwnProperty')).toBe(false)
  })

  it('系统加密不可用时拒绝保存与解析', async () => {
    await createLocalKeyStore({ file, cipher: fakeCipher() }).set('a', KEY)
    const store = createLocalKeyStore({
      file,
      cipher: fakeCipher({ isAvailable: async () => false }),
    })
    expect(await codeOf(() => store.set('b', KEY))).toBe(CredentialErrorCode.Unavailable)
    expect(await codeOf(() => store.resolve('a'))).toBe(CredentialErrorCode.Unavailable)
    expect(store.has('a')).toBe(true)
    expect(store.has('b')).toBe(false)
  })

  it('加密失败报不可用，解密失败报 decrypt_failed，错误中不含 Key', async () => {
    const onError = vi.fn()
    const store = createLocalKeyStore({
      file,
      onError,
      cipher: fakeCipher({
        encrypt: async () => {
          throw new Error('encryption failed')
        },
      }),
    })
    expect(await codeOf(() => store.set('a', KEY))).toBe(CredentialErrorCode.Unavailable)
    expect(store.has('a')).toBe(false)

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        credentials: { a: { kind: 'local-key', ciphertext: 'bm90LWVuYw==', updatedAt: 1 } },
      }),
    )
    const other = createLocalKeyStore({ file, onError, cipher: fakeCipher() })
    expect(await codeOf(() => other.resolve('a'))).toBe(CredentialErrorCode.DecryptFailed)
    expect(JSON.stringify(onError.mock.calls.map((c) => String(c[0])))).not.toContain(KEY)
  })

  it('系统密钥轮换后，解析时用新密钥重新加密保存', async () => {
    await createLocalKeyStore({ file, cipher: fakeCipher({}, 1), now: () => 1 }).set('a', KEY)
    const store = createLocalKeyStore({ file, cipher: fakeCipher({}, 2), now: () => 2 })
    expect(await store.resolve('a')).toEqual({ apiKey: KEY })
    expect(stored().credentials['a']).toMatchObject({
      ciphertext: ciphertextOf(KEY, 2),
      updatedAt: 2,
    })
    // 已是新密钥，不再写入
    expect(
      await createLocalKeyStore({ file, cipher: fakeCipher({}, 2), now: () => 3 }).resolve('a'),
    ).toEqual({
      apiKey: KEY,
    })
    expect(stored().credentials['a']?.updatedAt).toBe(2)
  })

  it('重新加密失败或期间被覆盖时不影响解析', async () => {
    await createLocalKeyStore({ file, cipher: fakeCipher({}, 1) }).set('a', KEY)
    const onError = vi.fn()
    const failing = createLocalKeyStore({
      file,
      onError,
      cipher: fakeCipher(
        {
          encrypt: async () => {
            throw new Error('encryption failed')
          },
        },
        2,
      ),
    })
    expect(await failing.resolve('a')).toEqual({ apiKey: KEY })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(stored().credentials['a']?.ciphertext).toBe(ciphertextOf(KEY, 1))

    // 重新加密期间这一项被覆盖：保留新写入的值
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const base = fakeCipher({}, 2)
    let calls = 0
    const racing = createLocalKeyStore({
      file,
      cipher: {
        ...base,
        encrypt: async (plain) => {
          if (calls++ === 0) await gate
          return base.encrypt(plain)
        },
      },
    })
    const resolving = racing.resolve('a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await racing.set('a', 'newer-key')
    release()
    expect(await resolving).toEqual({ apiKey: KEY })
    expect(await racing.resolve('a')).toEqual({ apiKey: 'newer-key' })
  })

  it('文件无法解析或版本不支持时视为空，写入前备份原文件', async () => {
    for (const content of ['not json', '[]', '{"version":2,"credentials":{}}']) {
      writeFileSync(file, content)
      const onError = vi.fn()
      const store = createLocalKeyStore({ file, onError, cipher: fakeCipher(), now: () => 42 })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(store.has('a')).toBe(false)

      await store.set('a', KEY)
      expect(readFileSync(join(dir, 'credentials.json.bak-42'), 'utf8')).toBe(content)
      expect(await createLocalKeyStore({ file, cipher: fakeCipher() }).resolve('a')).toEqual({
        apiKey: KEY,
      })
      // 只备份一次
      await store.set('b', KEY)
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
    expect(await codeOf(() => store.set('a', KEY))).toBe(CredentialErrorCode.WriteFailed)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(store.has('a')).toBe(false)
  })
})

describe('knownSecrets 与可用性', () => {
  it('记录本进程中保存与解析过的 Key（去掉首尾空白），报告系统加密是否可用', async () => {
    await createLocalKeyStore({ file, cipher: fakeCipher() }).set('a', 'stored-key-0001')
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    expect(store.knownSecrets()).toEqual([])
    await store.set('b', '  typed-key-0002 ')
    await store.resolve('a')
    expect([...store.knownSecrets()].sort()).toEqual(['stored-key-0001', 'typed-key-0002'])
    expect(await store.available()).toBe(true)
    const off = createLocalKeyStore({
      file,
      cipher: fakeCipher({ isAvailable: async () => false }),
    })
    expect(await off.available()).toBe(false)
  })
})

describe('createCredentialCommands', () => {
  it('写入、查询与删除，不返回明文', async () => {
    const store = createLocalKeyStore({ file, cipher: fakeCipher() })
    const commands = createCredentialCommands(store)
    expect(await commands.status({ ref: 'a' })).toEqual({ configured: false, available: true })
    expect(await commands.set({ ref: 'a', secret: KEY })).toEqual({})
    expect(await commands.status({ ref: 'a' })).toEqual({ configured: true, available: true })
    expect(JSON.stringify(await commands.status({ ref: 'a' }))).not.toContain(KEY)
    expect(await commands.delete({ ref: 'a' })).toEqual({ deleted: true })
    expect(await commands.delete({ ref: 'a' })).toEqual({ deleted: false })
    expect(await codeOf(() => commands.set({ ref: 'a', secret: ' ' }))).toBe(
      CredentialErrorCode.InvalidValue,
    )
  })
})
