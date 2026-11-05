/**
 * 内容寻址的 blob 存储（M1-08b，架构 §11.1、§14.1）：改动前后的文件内容按 SHA-256 保存在
 * `data/blobs/<前两位>/<哈希>`。相同内容只存一份；写入先写临时文件再改名，进程中断不会留下不完整的 blob。
 * 只有主进程写入。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'

export interface BlobStore {
  /** 保存内容，返回 SHA-256（小写十六进制）。已存在时不重复写入。 */
  put(content: Uint8Array): Promise<string>
  /** 读取内容；不存在时返回 undefined。读出的内容与哈希不符时视为损坏，同样返回 undefined。 */
  get(hash: string): Promise<Buffer | undefined>
}

export const sha256 = (content: Uint8Array): string =>
  createHash('sha256').update(content).digest('hex')

const HASH = /^[0-9a-f]{64}$/

export function createBlobStore(dir: string): BlobStore {
  const pathOf = (hash: string) => {
    if (!HASH.test(hash)) throw new Error(`invalid blob hash: ${hash}`)
    return join(dir, hash.slice(0, 2), hash)
  }

  return {
    async put(content) {
      const hash = sha256(content)
      const file = pathOf(hash)
      try {
        await fs.access(file)
        return hash
      } catch {
        // 不存在，写入
      }
      await fs.mkdir(join(dir, hash.slice(0, 2)), { recursive: true })
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, content)
        await fs.rename(tmp, file)
      } catch (error) {
        await fs.rm(tmp, { force: true })
        throw error
      }
      return hash
    },

    async get(hash) {
      let content: Buffer
      try {
        content = await fs.readFile(pathOf(hash))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      return sha256(content) === hash ? content : undefined
    },
  }
}
