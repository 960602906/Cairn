import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlobStore, sha256 } from './blob-store.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-blobs-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('BlobStore', () => {
  it('按 SHA-256 保存与读取；相同内容只存一份', async () => {
    const blobs = createBlobStore(join(dir, 'blobs'))
    const content = Buffer.from('a\r\nb\r\n')
    const hash = await blobs.put(content)
    expect(hash).toBe(sha256(content))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await blobs.put(new Uint8Array(content))).toBe(hash)
    expect(readdirSync(join(dir, 'blobs', hash.slice(0, 2)))).toEqual([hash])
    expect(await blobs.get(hash)).toEqual(content)
    expect(await blobs.put(new Uint8Array())).toBe(sha256(new Uint8Array()))
  })

  it('不存在或已损坏时返回 undefined；哈希格式不对时抛出', async () => {
    const blobs = createBlobStore(dir)
    expect(await blobs.get('0'.repeat(64))).toBeUndefined()
    const hash = await blobs.put(Buffer.from('x'))
    writeFileSync(join(dir, hash.slice(0, 2), hash), 'tampered')
    expect(await blobs.get(hash)).toBeUndefined()
    await expect(blobs.get('../etc/passwd')).rejects.toThrow('invalid blob hash')
  })

  it('写入失败时删除临时文件；读取的其他错误原样抛出', async () => {
    const blobs = createBlobStore(dir)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(blobs.put(Buffer.from('y'))).rejects.toThrow('disk full')
    const hash = sha256(Buffer.from('y'))
    expect(readdirSync(join(dir, hash.slice(0, 2)))).toEqual([])
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    )
    await expect(blobs.get(hash)).rejects.toThrow('EACCES')
  })
})
