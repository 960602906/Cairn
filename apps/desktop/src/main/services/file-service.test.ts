import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMemoryStorage } from '@cairn/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileService } from './file-service.js'

const dirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-files-'))
  dirs.push(dir)
  return dir
}

function setup() {
  const root = workspace()
  const storage = createMemoryStorage()
  storage.projects.create({ projectId: 'p1', name: 'Demo', path: root })
  const reveal = vi.fn()
  const service = createFileService({ storage, revealPath: reveal })
  return { root, service, reveal }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('file service', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it('lists directories first and hides dotfiles unless requested', async () => {
    mkdirSync(path.join(ctx.root, 'src'))
    writeFileSync(path.join(ctx.root, 'a.txt'), 'a')
    writeFileSync(path.join(ctx.root, '.env'), 'secret')
    mkdirSync(path.join(ctx.root, '.git'))

    expect(await ctx.service.list({ projectId: 'p1' })).toEqual({
      entries: [
        { path: 'src', name: 'src', kind: 'dir', hidden: false },
        { path: 'a.txt', name: 'a.txt', kind: 'file', hidden: false },
      ],
      truncated: false,
    })
    expect(await ctx.service.list({ projectId: 'p1', showHidden: true })).toEqual({
      entries: [
        { path: 'src', name: 'src', kind: 'dir', hidden: false },
        { path: '.env', name: '.env', kind: 'file', hidden: true },
        { path: 'a.txt', name: 'a.txt', kind: 'file', hidden: false },
      ],
      truncated: false,
    })
    expect(await ctx.service.list({ projectId: 'p1', limit: 1 })).toEqual({
      entries: [{ path: 'src', name: 'src', kind: 'dir', hidden: false }],
      truncated: true,
    })
  })

  it('creates, renames and deletes entries inside nested directories', async () => {
    await ctx.service.create({ projectId: 'p1', path: 'docs', kind: 'dir' })
    await ctx.service.create({ projectId: 'p1', path: 'docs/readme.md', kind: 'file' })
    expect(await ctx.service.list({ projectId: 'p1', path: 'docs' })).toMatchObject({
      entries: [{ path: 'docs/readme.md', kind: 'file' }],
    })
    await expect(
      ctx.service.create({ projectId: 'p1', path: 'docs/readme.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'fs.conflict' })

    expect(
      await ctx.service.rename({ projectId: 'p1', from: 'docs/readme.md', to: 'docs/guide.md' }),
    ).toEqual({ path: 'docs/guide.md' })
    await ctx.service.create({ projectId: 'p1', path: 'docs/other.md', kind: 'file' })
    await expect(
      ctx.service.rename({ projectId: 'p1', from: 'docs/guide.md', to: 'docs/other.md' }),
    ).rejects.toMatchObject({ code: 'fs.conflict' })

    await ctx.service.delete({ projectId: 'p1', path: 'docs' })
    expect(await ctx.service.list({ projectId: 'p1' })).toEqual({
      entries: [],
      truncated: false,
    })
  })

  it('rejects traversal, absolute paths and deleting the project root', async () => {
    for (const bad of ['../outside', '/absolute', 'a/../b', 'C:']) {
      await expect(ctx.service.list({ projectId: 'p1', path: bad })).rejects.toMatchObject({
        code: 'fs.invalid_path',
      })
    }
    await expect(ctx.service.delete({ projectId: 'p1', path: '' })).rejects.toMatchObject({
      code: 'fs.invalid_path',
    })
    await expect(ctx.service.list({ projectId: 'missing' })).rejects.toMatchObject({
      code: 'fs.project_not_found',
    })
  })

  it('reports missing paths and non-directory listings', async () => {
    writeFileSync(path.join(ctx.root, 'a.txt'), 'a')
    await expect(ctx.service.list({ projectId: 'p1', path: 'missing' })).rejects.toMatchObject({
      code: 'fs.not_found',
    })
    await expect(ctx.service.list({ projectId: 'p1', path: 'a.txt' })).rejects.toMatchObject({
      code: 'fs.not_directory',
    })
    await expect(
      ctx.service.create({ projectId: 'p1', path: 'a.txt/child', kind: 'file' }),
    ).rejects.toMatchObject({
      code: 'fs.not_directory',
    })
    await expect(
      ctx.service.delete({ projectId: 'p1', path: 'missing.txt' }),
    ).rejects.toMatchObject({
      code: 'fs.not_found',
    })
  })

  it('reveals the project root or an entry through the injected callback', async () => {
    writeFileSync(path.join(ctx.root, 'a.txt'), 'a')
    await ctx.service.reveal({ projectId: 'p1' })
    await ctx.service.reveal({ projectId: 'p1', path: 'a.txt' })
    expect(ctx.reveal).toHaveBeenNthCalledWith(1, expect.any(String))
    // 服务端先 realpath 项目根；Windows CI 的临时目录可能是 8.3 短路径（RUNNER~1）。
    expect(ctx.reveal).toHaveBeenNthCalledWith(2, await fsp.realpath(path.join(ctx.root, 'a.txt')))
  })

  it('rejects oversized and malformed relative paths', async () => {
    for (const bad of ['a'.repeat(4097), 'bad\0name', 'a//b', './a']) {
      await expect(ctx.service.list({ projectId: 'p1', path: bad })).rejects.toMatchObject({
        code: 'fs.invalid_path',
      })
    }
  })

  it('reports a missing project directory and works without a reveal callback', async () => {
    const missing = workspace()
    rmSync(missing, { recursive: true, force: true })
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p2', name: 'Gone', path: missing })
    const service = createFileService({ storage })
    await expect(service.list({ projectId: 'p2' })).rejects.toMatchObject({ code: 'fs.not_found' })
    await expect(service.reveal({ projectId: 'p2' })).rejects.toMatchObject({
      code: 'fs.not_found',
    })

    storage.projects.create({ projectId: 'p3', name: 'Here', path: ctx.root })
    await expect(service.reveal({ projectId: 'p3' })).resolves.toEqual({})
  })

  it('reports a file-backed project root as not a directory', async () => {
    const fileRoot = path.join(ctx.root, 'project-file')
    writeFileSync(fileRoot, 'not a directory')
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p4', name: 'File', path: fileRoot })
    const service = createFileService({ storage })
    await expect(service.list({ projectId: 'p4' })).rejects.toMatchObject({
      code: 'fs.not_directory',
    })
  })

  it('treats a missing root path as invalid for mutations', async () => {
    await expect(
      ctx.service.delete({ projectId: 'p1', path: undefined as unknown as string }),
    ).rejects.toMatchObject({ code: 'fs.invalid_path' })
  })

  it('blocks symlinks that escape the project', async () => {
    const outside = workspace()
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(
      outside,
      path.join(ctx.root, 'link'),
      process.platform === 'win32' ? 'junction' : undefined,
    )
    await expect(ctx.service.list({ projectId: 'p1', path: 'link' })).rejects.toMatchObject({
      code: 'fs.invalid_path',
    })
    await expect(
      ctx.service.create({ projectId: 'p1', path: 'link/new.txt', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'fs.invalid_path' })
  })

  it('reports directory symlink targets by kind', async () => {
    mkdirSync(path.join(ctx.root, 'real-dir'))
    symlinkSync(
      path.join(ctx.root, 'real-dir'),
      path.join(ctx.root, 'dir-link'),
      process.platform === 'win32' ? 'junction' : undefined,
    )
    const result = await ctx.service.list({ projectId: 'p1' })
    expect(result.entries).toEqual(
      expect.arrayContaining([{ path: 'dir-link', name: 'dir-link', kind: 'dir', hidden: false }]),
    )
  })

  it.runIf(process.platform !== 'win32')('reports file symlink targets by kind', async () => {
    writeFileSync(path.join(ctx.root, 'real.txt'), 'x')
    symlinkSync(path.join(ctx.root, 'real.txt'), path.join(ctx.root, 'file-link'))
    const result = await ctx.service.list({ projectId: 'p1' })
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { path: 'file-link', name: 'file-link', kind: 'file', hidden: false },
      ]),
    )
  })

  it('maps filesystem failures to RPC errors', async () => {
    const failure = (code: string) => Object.assign(new Error(code), { code })
    writeFileSync(path.join(ctx.root, 'a.txt'), 'a')

    vi.spyOn(fsp, 'realpath').mockRejectedValueOnce(failure('EACCES'))
    await expect(ctx.service.list({ projectId: 'p1' })).rejects.toMatchObject({ code: 'fs.failed' })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(failure('EACCES'))
    await expect(ctx.service.list({ projectId: 'p1' })).rejects.toMatchObject({ code: 'fs.failed' })
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(failure('ENOENT'))
    await expect(ctx.service.list({ projectId: 'p1' })).rejects.toMatchObject({
      code: 'fs.not_found',
    })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(failure('EACCES'))
    await expect(ctx.service.list({ projectId: 'p1' })).rejects.toMatchObject({ code: 'fs.failed' })
    vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(failure('ENOENT'))
    await expect(ctx.service.list({ projectId: 'p1' })).rejects.toMatchObject({
      code: 'fs.not_found',
    })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'realpath')
      .mockResolvedValueOnce(ctx.root)
      .mockRejectedValueOnce(failure('EACCES'))
    await expect(
      ctx.service.create({ projectId: 'p1', path: 'missing/child.txt', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'fs.failed' })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(failure('EACCES'))
    await expect(
      ctx.service.create({ projectId: 'p1', path: 'new.txt', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'fs.failed' })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'access').mockRejectedValueOnce(failure('EACCES'))
    await expect(
      ctx.service.rename({ projectId: 'p1', from: 'a.txt', to: 'b.txt' }),
    ).rejects.toMatchObject({ code: 'fs.failed' })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(failure('EACCES'))
    await expect(
      ctx.service.rename({ projectId: 'p1', from: 'a.txt', to: 'b.txt' }),
    ).rejects.toMatchObject({ code: 'fs.failed' })
    vi.restoreAllMocks()

    vi.spyOn(fsp, 'rm').mockRejectedValueOnce(failure('EACCES'))
    await expect(ctx.service.delete({ projectId: 'p1', path: 'a.txt' })).rejects.toMatchObject({
      code: 'fs.failed',
    })
    vi.spyOn(fsp, 'rm').mockRejectedValueOnce(failure('ENOENT'))
    await expect(ctx.service.delete({ projectId: 'p1', path: 'a.txt' })).rejects.toMatchObject({
      code: 'fs.not_found',
    })
    vi.restoreAllMocks()
  })
})
