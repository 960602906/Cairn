import { describe, expect, it } from 'vitest'
import { createSafeStorageCipher, type SafeStorageLike } from './safe-storage-cipher.js'

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

  it('加密不可用时不可用', async () => {
    expect(await createSafeStorageCipher(storage(false), 'win32').isAvailable()).toBe(false)
    expect(
      await createSafeStorageCipher(storage(false, 'gnome_libsecret'), 'linux').isAvailable(),
    ).toBe(false)
  })

  it('Linux 上的弱加密后端视为不可用', async () => {
    const linux = (backend?: string) => createSafeStorageCipher(storage(true, backend), 'linux')
    expect(await linux('basic_text').isAvailable()).toBe(false)
    expect(await linux('unknown').isAvailable()).toBe(false)
    expect(await linux().isAvailable()).toBe(false)
    expect(await linux('gnome_libsecret').isAvailable()).toBe(true)
    expect(await linux('kwallet6').isAvailable()).toBe(true)
  })

  it('默认按当前平台判断', async () => {
    expect(
      typeof (await createSafeStorageCipher(storage(true, 'gnome_libsecret')).isAvailable()),
    ).toBe('boolean')
  })
})
