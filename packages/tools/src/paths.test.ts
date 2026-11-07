import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolError } from '@cairn/core'
import {
  createPathResolver,
  nodePathFileSystem,
  PATH_STYLE,
  resolveWritableOrThrow,
} from './paths.js'

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

  it('技能目录可以读，工作区里的技能目录也标成只读（M3-07）', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-skill-path-')))
    const work = path.join(base, 'work')
    const skill = path.join(work, '.cairn', 'skills', 'demo')
    const outside = path.join(base, 'outside-skill')
    await fs.mkdir(path.join(skill, 'refs'), { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(skill, 'refs', 'guide.md'), 'guide')
    await fs.writeFile(path.join(work, 'notes.txt'), 'notes')
    await fs.writeFile(path.join(outside, 'guide.md'), 'outside')
    try {
      const resolve = createPathResolver(work, { readOnlyRoots: () => [skill, outside] })
      const inside = await resolve('.cairn/skills/demo/refs/guide.md')
      expect(inside).toMatchObject({ ok: true, readOnly: true })
      const external = await resolve(path.join(outside, 'guide.md'))
      expect(external).toMatchObject({ ok: true, readOnly: true })
      const notes = await resolve('notes.txt')
      expect(notes).toMatchObject({ ok: true, path: { relative: 'notes.txt' } })
      expect(notes.ok && notes.readOnly).toBeFalsy()
      await expect(
        resolveWritableOrThrow(
          { resolvePath: resolve } as Parameters<typeof resolveWritableOrThrow>[0],
          '.cairn/skills/demo/refs/guide.md',
        ),
      ).rejects.toMatchObject({ code: 'path.read_only' })
      await expect(
        resolveWritableOrThrow(
          {
            resolvePath: async () => ({ ok: false as const, code: 'path.empty' as const }),
          } as unknown as Parameters<typeof resolveWritableOrThrow>[0],
          ' ',
        ),
      ).rejects.toBeInstanceOf(ToolError)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
