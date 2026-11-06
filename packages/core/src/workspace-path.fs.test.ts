/**
 * resolveWorkspacePath（M1-06b）：在真实文件系统上测试符号链接、目录联接、不存在的文件与悬空链接。
 * Linux 与 Windows CI 各自运行；Windows 上另外测试目录联接与大小写。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PathErrorCode,
  resolveWorkspacePath,
  type PathFileSystem,
  type PathStyle,
} from './workspace-path.js'

const isWindows = process.platform === 'win32'
const style: PathStyle = isWindows ? 'win32' : 'posix'

/** Node 实现（与 M1-07 工具中使用的方式相同）。 */
const nodeFs: PathFileSystem = {
  async realpath(p) {
    try {
      return await fs.realpath(p)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  async exists(p) {
    try {
      await fs.lstat(p)
      return true
    } catch {
      return false
    }
  },
}

let base: string
let root: string
let realRoot: string
let outside: string

beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), 'cairn-path-'))
  root = path.join(base, 'workspace')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'a.txt'), 'a')
  await fs.writeFile(path.join(outside, 'secret.txt'), 's')
  // 目录链接：Windows 上用目录联接（不需要管理员权限），其他平台用符号链接
  const dirLink = isWindows ? 'junction' : 'dir'
  await fs.symlink(outside, path.join(root, 'link-out'), dirLink)
  await fs.symlink(path.join(root, 'src'), path.join(root, 'link-in'), dirLink)
  await fs.symlink(base, path.join(root, 'link-parent'), dirLink)
  await fs.symlink(root, path.join(base, 'root-link'), dirLink)
  realRoot = await fs.realpath(root)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const resolve = (input: string, from = root) =>
  resolveWorkspacePath(from, input, { style, fs: nodeFs })
const rel = async (input: string, from?: string) => {
  const result = await resolve(input, from)
  return result.ok ? result.path.relative : result.code
}

describe('resolveWorkspacePath：真实文件系统', () => {
  it('已存在的文件：返回真实路径', async () => {
    const result = await resolve('a.txt')
    expect(result).toEqual({
      ok: true,
      path: { absolute: path.join(realRoot, 'a.txt'), relative: 'a.txt' },
    })
  })

  it('不存在的文件：按已存在的最近父目录判定', async () => {
    expect(await rel('src/new/deep/file.ts')).toBe('src/new/deep/file.ts')
    expect(await rel('missing.txt')).toBe('missing.txt')
    expect(await rel('.')).toBe('.')
  })

  it('指向工作区内的链接：按真实位置给出相对路径', async () => {
    expect(await rel('link-in/x.ts')).toBe('src/x.ts')
    expect(await rel('link-parent/workspace/a.txt')).toBe('a.txt')
  })

  it('指向工作区外的链接：拒绝，包括其下尚不存在的文件', async () => {
    expect(await rel('link-out')).toBe(PathErrorCode.OutsideWorkspace)
    expect(await rel('link-out/secret.txt')).toBe(PathErrorCode.OutsideWorkspace)
    expect(await rel('link-out/new/file.txt')).toBe(PathErrorCode.OutsideWorkspace)
    expect(await rel('link-parent/outside/secret.txt')).toBe(PathErrorCode.OutsideWorkspace)
  })

  it('经链接打开工作区：以根目录的真实路径判定', async () => {
    expect(await rel('a.txt', path.join(base, 'root-link'))).toBe('a.txt')
    expect(await rel('../outside/secret.txt', path.join(base, 'root-link'))).toBe(
      PathErrorCode.OutsideWorkspace,
    )
  })

  it('按文本就能判定越界的路径不访问文件系统', async () => {
    expect(await rel('../outside/secret.txt')).toBe(PathErrorCode.OutsideWorkspace)
    expect(await rel('')).toBe(PathErrorCode.Empty)
  })

  it('工作区根目录不存在', async () => {
    expect(await rel('a', path.join(base, 'nope'))).toBe(PathErrorCode.RootNotFound)
  })

  it.runIf(isWindows)('Windows：大小写与 / 分隔符', async () => {
    expect((await rel('SRC/New.ts')).toLowerCase()).toBe('src/new.ts')
    expect((await rel('A.TXT')).toLowerCase()).toBe('a.txt')
  })
})

/** 文件符号链接与悬空链接：Windows 上需要开发者模式或管理员权限，不支持时这两项不运行。 */
const canSymlinkFiles = await (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cairn-link-'))
  try {
    await fs.symlink(path.join(dir, 'x'), path.join(dir, 'y'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe.runIf(canSymlinkFiles)('resolveWorkspacePath：文件符号链接', () => {
  beforeAll(async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-out'), 'file')
    await fs.symlink(path.join(outside, 'missing'), path.join(root, 'dangling'), 'file')
  })

  it('指向工作区外文件的链接：拒绝', async () => {
    expect(await rel('file-out')).toBe(PathErrorCode.OutsideWorkspace)
  })

  it('悬空链接及其下的路径：拒绝', async () => {
    expect(await rel('dangling')).toBe(PathErrorCode.BrokenLink)
    expect(await rel('dangling/x')).toBe(PathErrorCode.BrokenLink)
  })
})
