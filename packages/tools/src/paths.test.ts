import fs from 'node:fs/promises'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPathResolver, nodePathFileSystem, PATH_STYLE } from './paths.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const errno = (code: string) => Object.assign(new Error(code), { code })

describe('nodePathFileSystem', () => {
  it('不存在时返回 undefined / false，其他错误抛出', async () => {
    expect(await nodePathFileSystem.realpath('/definitely/missing/x')).toBeUndefined()
    expect(await nodePathFileSystem.exists('/definitely/missing/x')).toBe(false)
    expect(await nodePathFileSystem.exists(os.tmpdir())).toBe(true)
    vi.spyOn(fs, 'realpath').mockRejectedValueOnce(errno('EACCES'))
    await expect(nodePathFileSystem.realpath('/x')).rejects.toThrow('EACCES')
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(errno('ENOTDIR'))
    expect(await nodePathFileSystem.exists('/x')).toBe(false)
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(errno('EACCES'))
    await expect(nodePathFileSystem.exists('/x')).rejects.toThrow('EACCES')
  })

  it('路径风格跟随平台；也可以指定', async () => {
    expect(PATH_STYLE).toBe(process.platform === 'win32' ? 'win32' : 'posix')
    const resolve = createPathResolver('C:\\w', 'win32')
    expect(await resolve('C:foo')).toEqual({ ok: false, code: 'path.drive_relative' })
  })
})
