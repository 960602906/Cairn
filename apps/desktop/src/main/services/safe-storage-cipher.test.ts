import { describe, expect, it } from 'vitest'
import { createSafeStorageCipher, type SafeStorageLike } from './safe-storage-cipher.js'

const storage = (available: boolean, backend?: string): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (data) => Buffer.from(data).reverse().toString('utf8'),
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
})

describe('createSafeStorageCipher', () => {
  it('转发加密与解密', () => {
    const cipher = createSafeStorageCipher(storage(true), 'win32')
    expect(cipher.isAvailable()).toBe(true)
    expect(cipher.decrypt(cipher.encrypt('密钥 key'))).toBe('密钥 key')
  })

  it('加密不可用时不可用', () => {
    expect(createSafeStorageCipher(storage(false), 'win32').isAvailable()).toBe(false)
    expect(createSafeStorageCipher(storage(false, 'gnome_libsecret'), 'linux').isAvailable()).toBe(
      false,
    )
  })

  it('Linux 上的弱加密后端视为不可用', () => {
    const linux = (backend?: string) => createSafeStorageCipher(storage(true, backend), 'linux')
    expect(linux('basic_text').isAvailable()).toBe(false)
    expect(linux('unknown').isAvailable()).toBe(false)
    expect(linux().isAvailable()).toBe(false)
    expect(linux('gnome_libsecret').isAvailable()).toBe(true)
    expect(linux('kwallet6').isAvailable()).toBe(true)
  })

  it('默认按当前平台判断', () => {
    expect(typeof createSafeStorageCipher(storage(true, 'gnome_libsecret')).isAvailable()).toBe(
      'boolean',
    )
  })
})
