import { describe, expect, it } from 'vitest'
import {
  createLocalFileCipher,
  createSafeStorageCipher,
  credentialAvailability,
  type SafeStorageLike,
} from './safe-storage-cipher.js'

const storage = (
  available: boolean,
  backend?: string,
  shouldReEncrypt = false,
): SafeStorageLike => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptStringAsync: async (data) => ({
    result: Buffer.from(data).reverse().toString('utf8'),
    shouldReEncrypt,
  }),
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
})

describe('createSafeStorageCipher', () => {
  it('转发加密与解密', async () => {
    const cipher = createSafeStorageCipher(storage(true), 'win32')
    expect(await cipher.isAvailable()).toBe(true)
    expect(await cipher.decrypt(await cipher.encrypt('密钥 key'))).toEqual({
      plain: '密钥 key',
      shouldReEncrypt: false,
    })
    const rotated = createSafeStorageCipher(storage(true, undefined, true), 'win32')
    expect((await rotated.decrypt(await rotated.encrypt('k'))).shouldReEncrypt).toBe(true)
  })

  it('系统加密不可用时仍可用，并回退到本机文件编码（ADR-0051）', async () => {
    const cipher = createSafeStorageCipher(storage(false), 'win32')
    expect(await cipher.isAvailable()).toBe(true)
    expect(await cipher.unavailableReason?.()).toBeUndefined()
    const roundTrip = await cipher.decrypt(await cipher.encrypt('本地 key'))
    expect(roundTrip).toEqual({ plain: '本地 key', shouldReEncrypt: false })
  })

  it('Linux 弱加密与未知后端仍可用（ADR-0051）', async () => {
    const linux = (backend?: string) => createSafeStorageCipher(storage(true, backend), 'linux')
    expect(await linux('basic_text').isAvailable()).toBe(true)
    expect(await linux('unknown').isAvailable()).toBe(true)
    expect(await linux().isAvailable()).toBe(true)
    expect(await linux('gnome_libsecret').isAvailable()).toBe(true)
    expect(await linux('kwallet6').isAvailable()).toBe(true)
    expect(await linux('basic_text').decrypt(await linux('basic_text').encrypt('k'))).toEqual({
      plain: 'k',
      shouldReEncrypt: false,
    })
  })

  it('默认按当前平台判断', async () => {
    expect(
      typeof (await createSafeStorageCipher(storage(true, 'gnome_libsecret')).isAvailable()),
    ).toBe('boolean')
  })

  it('credentialAvailability 只在系统加密不可用时失败', async () => {
    expect(await credentialAvailability(storage(false), 'win32')).toEqual({
      available: false,
      reason: 'system-encryption-unavailable',
    })
    expect(await credentialAvailability(storage(true, 'basic_text'), 'linux')).toEqual({
      available: true,
    })
    expect(await credentialAvailability(storage(true, 'unknown'), 'linux')).toEqual({
      available: true,
    })
    expect(await credentialAvailability(storage(true), 'linux')).toEqual({ available: true })
    expect(await credentialAvailability(storage(true, 'kwallet6'), 'linux')).toEqual({
      available: true,
    })
    expect(await credentialAvailability(storage(true), 'darwin')).toEqual({ available: true })
  })

  it('本机回退密文与 safeStorage 密文可区分；系统加密不可用时对旧密文标记重加密', async () => {
    const local = createLocalFileCipher()
    const sealed = await local.encrypt('secret')
    expect(await createSafeStorageCipher(storage(false), 'linux').decrypt(sealed)).toEqual({
      plain: 'secret',
      shouldReEncrypt: false,
    })

    const fakeOs: SafeStorageLike = {
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async () => {
        throw new Error('unavailable')
      },
      decryptStringAsync: async () => ({ result: 'old-os-key', shouldReEncrypt: false }),
    }
    expect(await createSafeStorageCipher(fakeOs, 'linux').decrypt(Buffer.from('x'))).toEqual({
      plain: 'old-os-key',
      shouldReEncrypt: true,
    })
  })
})
