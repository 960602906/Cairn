/**
 * 隔离工作区（M4-08）的真实 Git 集成测试：用影子仓库（ADR-0008）为项目建基线提交，再创建工作树或
 * 导出副本，独立核对文件内容、依赖目录的共享方式、清理与配额。断言不依赖被测服务的内部状态。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGitRunner, isolatedGitEnv, openShadowRepo, type GitRunner } from '@cairn/checkpoint'
import { createPathResolver } from '@cairn/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceService,
  WorkspaceError,
  WorkspaceErrorCode,
  type WorkspaceService,
} from './workspace-service.js'

const userGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', ...args], {
    cwd,
    stdio: 'pipe',
  }).toString()

let tmp: string
let project: string
let gitDir: string
let root: string
let commit: string
let service: WorkspaceService

const write = (rel: string, content: string) => {
  const file = path.join(project, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** 用生产用的影子仓库创建基线提交（包含排除规则、嵌套仓库与未提交改动）。 */
async function shadowCommit(): Promise<string> {
  const repo = await openShadowRepo({
    gitDir,
    workTree: project,
    maxFileBytes: 1024,
    extraExcludes: ['node_modules/', '.venv/'],
  })
  return (await repo.checkpoint('baseline')).commit
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-workspace-'))
  project = path.join(tmp, 'my project')
  gitDir = path.join(tmp, 'checkpoints', 'p1.git')
  root = path.join(tmp, 'worktrees')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.dirname(gitDir), { recursive: true })
  write('src/a.ts', 'export const a = 1\n')
  write('docs/中文 文件.md', '你好\n')
  write('node_modules/dep/index.js', 'dep\n')
  write('.gitignore', 'dist/\nnode_modules/\n')
  write('dist/out.js', 'built\n')
  commit = await shadowCommit()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const create = (runId = 'r1', sessionId = 's1') =>
  service.createIsolated({ projectPath: project, gitDir, baseCommit: commit, sessionId, runId })

const errorWithCode = (code: string) => Object.assign(new Error(code), { code })

function directoryBytes(root: string): number {
  let total = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += directoryBytes(child)
    else if (entry.isFile()) total += fs.lstatSync(child).size
  }
  return total
}

describe('createIsolated', () => {
  it('checks out the baseline as a detached worktree and shares dependencies', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()

    expect(workspace.mode).toBe('worktree')
    expect(workspace.path).toBe(path.join(root, 's1', 'r1'))
    expect(workspace.checkpoint).toEqual({
      gitDir: path.join(root, 's1', 'r1.checkpoints.git'),
      ref: 'refs/cairn/worktrees/r1',
    })
    expect(fs.readFileSync(path.join(workspace.path, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 1\n',
    )
    expect(fs.readFileSync(path.join(workspace.path, 'docs', '中文 文件.md'), 'utf8')).toBe(
      '你好\n',
    )
    // 被检查点排除的目录不出现
    expect(fs.existsSync(path.join(workspace.path, 'dist'))).toBe(false)
    // 依赖目录以链接共享，不复制
    const linked = fs.lstatSync(path.join(workspace.path, 'node_modules'))
    expect(linked.isSymbolicLink()).toBe(true)
    expect(workspace.sharedDirs).toEqual(['node_modules'])
    // 隔离工作区自己的 .git 文件不进入检查点
    expect(fs.existsSync(path.join(workspace.path, '.git'))).toBe(true)
    expect(await service.list()).toEqual([workspace])
  })

  it('rejects unsafe ids and a malformed baseline', async () => {
    service = createWorkspaceService({ root })
    await expect(create('../evil')).rejects.toMatchObject({
      code: WorkspaceErrorCode.Invalid,
    })
    await expect(create('r1', 'a/b')).rejects.toBeInstanceOf(WorkspaceError)
    await expect(
      service.createIsolated({
        projectPath: 'relative/path',
        gitDir,
        baseCommit: commit,
        sessionId: 's1',
        runId: 'r1',
      }),
    ).rejects.toMatchObject({ code: WorkspaceErrorCode.Invalid })
    await expect(
      service.createIsolated({
        projectPath: project,
        gitDir,
        baseCommit: 'nope',
        sessionId: 's1',
        runId: 'r1',
      }),
    ).rejects.toMatchObject({ code: WorkspaceErrorCode.Invalid })
  })

  it('uses the checkpoint baseline, not uncommitted changes made after it', async () => {
    service = createWorkspaceService({ root })
    write('src/a.ts', 'uncommitted change\n')
    const workspace = await create()
    expect(fs.readFileSync(path.join(workspace.path, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 1\n',
    )
  })

  it('does not copy nested repositories into the isolated workspace', async () => {
    const nested = path.join(project, 'vendor', 'lib')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'lib.js'), 'lib\n')
    userGit(nested, 'init', '-q')
    userGit(nested, 'add', '.')
    userGit(nested, 'commit', '-qm', 'nested')
    // 重新建立包含嵌套仓库的基线
    const repo = await openShadowRepo({
      gitDir,
      workTree: project,
      maxFileBytes: 1024,
      extraExcludes: ['node_modules/', '.venv/'],
    })
    commit = (await repo.checkpoint('baseline with nested repo')).commit

    service = createWorkspaceService({ root })
    const workspace = await create()
    expect(fs.existsSync(path.join(workspace.path, 'vendor', 'lib'))).toBe(false)
  })

  it('keeps three isolated workspaces independent and can clean them all', async () => {
    service = createWorkspaceService({ root })
    const workspaces = await Promise.all([create('r1'), create('r2'), create('r3')])
    for (const [index, workspace] of workspaces.entries()) {
      fs.writeFileSync(path.join(workspace.path, `only-${index}.txt`), `${index}`)
    }
    for (const [index, workspace] of workspaces.entries()) {
      expect(fs.readdirSync(workspace.path).filter((name) => name.startsWith('only-'))).toEqual([
        `only-${index}.txt`,
      ])
    }
    await Promise.all(workspaces.map((workspace) => service.cleanup(workspace.runId)))
    for (const workspace of workspaces) expect(fs.existsSync(workspace.path)).toBe(false)
  })

  it('blocks reads that escape the isolated workspace', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    const resolve = createPathResolver(workspace.path)
    expect(await resolve('src/a.ts')).toMatchObject({
      ok: true,
      path: { relative: 'src/a.ts' },
    })
    expect(await resolve('../r2')).toEqual({ ok: false, code: 'path.outside_workspace' })
    expect(await resolve(path.join(tmp, 'outside.txt'))).toEqual({
      ok: false,
      code: 'path.outside_workspace',
    })
  })

  it('rejects a duplicate run id and clips at the concurrency limit', async () => {
    service = createWorkspaceService({ root, maxConcurrent: 1 })
    await create()
    await expect(create()).rejects.toMatchObject({ code: WorkspaceErrorCode.Invalid })
    await expect(create('r2')).rejects.toMatchObject({ code: WorkspaceErrorCode.Limit })
  })

  it('enforces the disk quota and leaves nothing behind', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, maxDiskBytes: 1, onError })
    await expect(create()).rejects.toMatchObject({ code: WorkspaceErrorCode.Limit })
    expect(fs.existsSync(path.join(root, 's1', 'r1'))).toBe(false)
    expect(await service.list()).toEqual([])
  })

  it('falls back to exporting files when git worktree is unavailable', async () => {
    const git = (indexFile?: string): GitRunner => {
      const real = createGitRunner({
        env: {
          ...isolatedGitEnv(process.env, path.join(tmp, 'empty')),
          ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
        },
      })
      return {
        binary: real.binary,
        run: (args, runOptions) =>
          args.includes('worktree')
            ? Promise.reject(new Error('worktree is not supported here'))
            : real.run(args, runOptions),
      }
    }
    const onError = vi.fn()
    service = createWorkspaceService({ root, git, onError })
    const workspace = await create()

    expect(workspace.mode).toBe('export')
    expect(fs.readFileSync(path.join(workspace.path, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 1\n',
    )
    expect(fs.existsSync(path.join(workspace.path, '.git'))).toBe(false)
    expect(onError).toHaveBeenCalled()
    // 导出用的临时索引文件不残留
    expect(fs.readdirSync(path.join(root, 's1')).sort()).toEqual(['r1', 'r1.workspace.json'])
    // 导出式工作区没有 Git worktree 注册，也能直接清理
    expect(await service.cleanup('r1')).toBe(true)
    expect(fs.existsSync(workspace.path)).toBe(false)
  })

  it('reports a failure when both worktree and export fail', async () => {
    const git = (): GitRunner => ({
      binary: 'git',
      run: () => Promise.reject(new Error('boom')),
    })
    service = createWorkspaceService({ root, git, onError: () => undefined })
    await expect(create()).rejects.toMatchObject({ code: WorkspaceErrorCode.Failed })
    expect(fs.existsSync(path.join(root, 's1', 'r1'))).toBe(false)
  })

  it('accepts an explicit Git binary', async () => {
    service = createWorkspaceService({ root, gitBinary: 'git' })
    const workspace = await create()
    expect(workspace.mode).toBe('worktree')
  })

  it('skips non-directory, symlinked and already-present dependencies', async () => {
    const actualDeps = path.join(project, 'actual-deps')
    fs.renameSync(path.join(project, 'node_modules'), actualDeps)
    fs.symlinkSync(
      actualDeps,
      path.join(project, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    service = createWorkspaceService({
      root,
      dependencyDirs: ['node_modules', 'src/a.ts', 'src'],
    })
    const workspace = await create()
    expect(workspace.sharedDirs).toEqual([])
    expect(fs.existsSync(path.join(workspace.path, 'node_modules'))).toBe(false)
  })

  it('records dependency link failures without failing creation', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    vi.spyOn(fsp, 'symlink').mockRejectedValue(errorWithCode('EPERM'))
    const workspace = await create()
    expect(workspace.sharedDirs).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('records unexpected dependency destination probe errors', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const destination = path.join(root, 's1', 'r1', 'node_modules')
    const realLstat = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementation(((target: string | Buffer | URL) =>
      path.resolve(String(target)) === destination
        ? Promise.reject(errorWithCode('EACCES'))
        : realLstat(target as never)) as never)
    const workspace = await create()
    expect(workspace.sharedDirs).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('skips entries that disappear while measuring the workspace', async () => {
    service = createWorkspaceService({ root })
    const target = path.join(root, 's1', 'r1')
    const ghost = {
      name: 'ghost',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as fs.Dirent
    const pipe = {
      name: 'pipe',
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as fs.Dirent
    const realReaddir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation(((targetPath: string | Buffer | URL) => {
      const resolved = path.resolve(String(targetPath))
      if (resolved === path.join(target, 'ghost')) {
        return Promise.reject(errorWithCode('ENOENT'))
      }
      if (resolved === target) {
        return realReaddir(targetPath as never, { withFileTypes: true }).then((entries) => [
          ...(entries as fs.Dirent[]),
          ghost,
          pipe,
        ])
      }
      return realReaddir(targetPath as never, { withFileTypes: true })
    }) as never)
    const workspace = await create()
    expect(workspace.path).toBe(target)
  })

  it('fails when the workspace cannot be measured', async () => {
    service = createWorkspaceService({ root })
    const target = path.join(root, 's1', 'r1')
    const ghost = {
      name: 'ghost',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as fs.Dirent
    const realReaddir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation(((targetPath: string | Buffer | URL) => {
      const resolved = path.resolve(String(targetPath))
      if (resolved === path.join(target, 'ghost')) {
        return Promise.reject(errorWithCode('EACCES'))
      }
      if (resolved === target) {
        return realReaddir(targetPath as never, { withFileTypes: true }).then((entries) => [
          ...(entries as fs.Dirent[]),
          ghost,
        ])
      }
      return realReaddir(targetPath as never, { withFileTypes: true })
    }) as never)
    await expect(create()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('ignores files that disappear while measuring the workspace', async () => {
    service = createWorkspaceService({ root })
    const vanished = path.join(root, 's1', 'r1', 'src', 'a.ts')
    const realLstat = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementation(((target: string | Buffer | URL) =>
      path.resolve(String(target)) === vanished
        ? Promise.reject(errorWithCode('ENOENT'))
        : realLstat(target as never)) as never)
    const workspace = await create()
    expect(workspace.mode).toBe('worktree')
  })

  it('fails on unexpected stat errors while measuring the workspace', async () => {
    service = createWorkspaceService({ root })
    const vanished = path.join(root, 's1', 'r1', 'src', 'a.ts')
    const realLstat = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementation(((target: string | Buffer | URL) =>
      path.resolve(String(target)) === vanished
        ? Promise.reject(errorWithCode('EACCES'))
        : realLstat(target as never)) as never)
    await expect(create()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects creation when live workspaces already fill the quota', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    const size = directoryBytes(workspace.path)
    await service.cleanup('r1')

    service = createWorkspaceService({ root, maxDiskBytes: size })
    await create('r1')
    await expect(create('r2')).rejects.toMatchObject({ code: WorkspaceErrorCode.Limit })
  })
})

describe('cleanup / list / sweep', () => {
  it('removes the worktree, its checkpoints and the metadata', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    fs.writeFileSync(path.join(workspace.path, 'new.txt'), 'x')

    expect(await service.cleanup('r1')).toBe(true)
    expect(fs.existsSync(workspace.path)).toBe(false)
    expect(fs.existsSync(workspace.checkpoint.gitDir)).toBe(false)
    expect(fs.existsSync(path.join(root, 's1', 'r1.workspace.json'))).toBe(false)
    expect(await service.list()).toEqual([])
    // 重复清理是安全的
    expect(await service.cleanup('r1')).toBe(false)
    expect(await service.cleanup('../../evil')).toBe(false)
  })

  it('keeps working when the directory was already removed', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const workspace = await create()
    fs.rmSync(workspace.path, { recursive: true, force: true })
    expect(await service.cleanup('r1')).toBe(true)
    expect(fs.existsSync(path.join(root, 's1', 'r1.workspace.json'))).toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('lists workspaces from disk in creation order', async () => {
    let clock = 1
    service = createWorkspaceService({ root, now: () => clock++ })
    const a = await create('r1')
    const b = await create('r2')
    const fresh = createWorkspaceService({ root })
    expect((await fresh.list()).map((workspace) => workspace.path)).toEqual([a.path, b.path])
  })

  it('ignores unreadable or unsafe metadata', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const workspace = await create()
    const meta = path.join(root, 's1', 'r1.workspace.json')
    const original = fs.readFileSync(meta, 'utf8')
    for (const bad of ['not json', JSON.stringify({ ...JSON.parse(original), path: '/etc' })]) {
      fs.writeFileSync(meta, bad)
      expect(await service.list()).toEqual([])
    }
    fs.writeFileSync(meta, original)
    expect(await service.list()).toHaveLength(1)
    expect(workspace.path).toContain('r1')
    expect(onError).toHaveBeenCalled()
  })

  it('sweeps orphan directories left by a previous run', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    const orphan = path.join(root, 's1', 'r9')
    fs.mkdirSync(orphan, { recursive: true })
    fs.writeFileSync(path.join(orphan, 'x'), 'x')

    expect(await service.sweep()).toBe(2)
    expect(fs.existsSync(workspace.path)).toBe(false)
    expect(fs.existsSync(orphan)).toBe(false)
    expect(await createWorkspaceService({ root }).list()).toEqual([])
  })

  it('registers the worktree in the project shadow repository', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    const listed = execFileSync('git', ['--git-dir', gitDir, 'worktree', 'list'], {
      stdio: 'pipe',
    }).toString()
    expect(listed).toContain('r1')
    await service.cleanup('r1')
    const after = execFileSync('git', ['--git-dir', gitDir, 'worktree', 'list'], {
      stdio: 'pipe',
    }).toString()
    expect(after).not.toContain('r1')
    expect(workspace.mode).toBe('worktree')
  })
})

describe('failure handling and metadata integrity', () => {
  interface MutableMeta {
    path: string
    mode: string
    sessionId: string
    runId: string
    baseCommit: string
    createdAt: number
    projectGitDir: string
    sharedDirs: unknown[]
    checkpoint: { gitDir: string; ref: string }
  }

  it('rejects tampered or malformed metadata', async () => {
    service = createWorkspaceService({ root })
    await create()
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    const original = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MutableMeta
    const mutations: ((meta: MutableMeta) => void)[] = [
      (meta) => (meta.mode = 'copy'),
      (meta) => delete (meta as Partial<MutableMeta>).checkpoint,
      (meta) => (meta.sharedDirs = [1]),
      (meta) => (meta.sharedDirs = ['../escape']),
      (meta) => (meta.baseCommit = 'nope'),
      (meta) => (meta.createdAt = 'now' as unknown as number),
      (meta) => (meta.projectGitDir = 'relative'),
      (meta) => (meta.path = 'relative'),
      (meta) => (meta.checkpoint.gitDir = 'relative'),
      (meta) => (meta.checkpoint.ref = 'refs/heads/main'),
      (meta) => (meta.sessionId = '../s1'),
      (meta) => (meta.runId = '../r1'),
      (meta) => (meta.path = path.join(root, 's1', 'other')),
      (meta) => (meta.checkpoint.gitDir = path.join(tmp, 'outside.git')),
    ]

    for (const mutate of mutations) {
      const meta = structuredClone(original)
      mutate(meta)
      fs.writeFileSync(metaPath, JSON.stringify(meta))
      const fresh = createWorkspaceService({ root })
      expect(await fresh.list()).toEqual([])
    }
  })

  it('never deletes paths outside the canonical workspace from tampered metadata', async () => {
    service = createWorkspaceService({ root })
    await create()
    const outside = path.join(tmp, 'outside-checkpoints')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MutableMeta
    meta.checkpoint.gitDir = outside
    fs.writeFileSync(metaPath, JSON.stringify(meta))

    const fresh = createWorkspaceService({ root })
    expect(await fresh.cleanup('r1')).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('reports unreadable metadata instead of treating it as a workspace', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    await create()
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    fs.rmSync(metaPath)
    fs.mkdirSync(metaPath)

    const fresh = createWorkspaceService({ root, onError })
    expect(await fresh.cleanup('r1')).toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('propagates unexpected root read errors from cleanup and list', async () => {
    service = createWorkspaceService({ root })
    const denied = errorWithCode('EACCES')
    vi.spyOn(fsp, 'readdir').mockRejectedValue(denied)
    await expect(service.cleanup('r1')).rejects.toBe(denied)
    await expect(service.list()).rejects.toBe(denied)
  })

  it('propagates unexpected session read errors from list', async () => {
    const sessionDir = path.join(root, 's1')
    fs.mkdirSync(sessionDir, { recursive: true })
    const denied = errorWithCode('EACCES')
    const realReaddir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation(((target: string | Buffer | URL) =>
      path.resolve(String(target)) === sessionDir
        ? Promise.reject(denied)
        : realReaddir(target as never, { withFileTypes: true })) as never)
    service = createWorkspaceService({ root })
    await expect(service.list()).rejects.toBe(denied)
  })

  it('finds and cleans a workspace recorded on disk', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    const fresh = createWorkspaceService({ root })
    expect(await fresh.cleanup('r1')).toBe(true)
    expect(fs.existsSync(workspace.path)).toBe(false)
  })

  it('keeps metadata when workspace deletion fails', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const workspace = await create()
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    const realRm = fsp.rm.bind(fsp)
    vi.spyOn(fsp, 'rm').mockImplementation(((target: string | Buffer | URL, options?: object) =>
      path.resolve(String(target)) === workspace.path
        ? Promise.reject(errorWithCode('EBUSY'))
        : realRm(target as never, options as never)) as never)

    expect(await service.cleanup('r1')).toBe(false)
    expect(fs.existsSync(metaPath)).toBe(true)
    expect(onError).toHaveBeenCalled()
  })

  it('keeps metadata when checkpoint deletion fails', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const workspace = await create()
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    const realRm = fsp.rm.bind(fsp)
    vi.spyOn(fsp, 'rm').mockImplementation(((target: string | Buffer | URL, options?: object) =>
      path.resolve(String(target)) === workspace.checkpoint.gitDir
        ? Promise.reject(errorWithCode('EBUSY'))
        : realRm(target as never, options as never)) as never)

    expect(await service.cleanup('r1')).toBe(false)
    expect(fs.existsSync(metaPath)).toBe(true)
    expect(onError).toHaveBeenCalled()
  })

  it('keeps metadata when metadata deletion fails', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const workspace = await create()
    const metaPath = path.join(root, 's1', 'r1.workspace.json')
    const realRm = fsp.rm.bind(fsp)
    vi.spyOn(fsp, 'rm').mockImplementation(((target: string | Buffer | URL, options?: object) =>
      path.resolve(String(target)) === metaPath
        ? Promise.reject(errorWithCode('EBUSY'))
        : realRm(target as never, options as never)) as never)

    expect(await service.cleanup('r1')).toBe(false)
    expect(fs.existsSync(workspace.path)).toBe(false)
    expect(fs.existsSync(metaPath)).toBe(true)
    expect(onError).toHaveBeenCalled()
  })

  it('records worktree prune failures but still completes cleanup', async () => {
    const onError = vi.fn()
    const realGit = createGitRunner({
      env: isolatedGitEnv(process.env, path.join(tmp, 'empty')),
    })
    const git = (): GitRunner => ({
      binary: realGit.binary,
      run: (args, runOptions) =>
        args.includes('prune')
          ? Promise.reject(errorWithCode('EBUSY'))
          : realGit.run(args, runOptions),
    })
    service = createWorkspaceService({ root, git, onError })
    await create()
    expect(await service.cleanup('r1')).toBe(true)
    expect(onError).toHaveBeenCalled()
  })

  it('handles missing roots and ignores non-session entries', async () => {
    const missing = createWorkspaceService({ root: path.join(tmp, 'missing') })
    expect(await missing.list()).toEqual([])
    expect(await missing.sweep()).toBe(0)
    expect(await missing.cleanup('r1')).toBe(false)

    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'plain'), 'x')
    fs.mkdirSync(path.join(root, 'bad name'))
    service = createWorkspaceService({ root })
    expect(await service.list()).toEqual([])
    expect(await service.sweep()).toBe(0)
    expect(await service.cleanup('r1')).toBe(false)
  })

  it('ignores session directories that disappear while listing', async () => {
    const sessionDir = path.join(root, 's1')
    fs.mkdirSync(sessionDir, { recursive: true })
    const realReaddir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation(((target: string | Buffer | URL) =>
      path.resolve(String(target)) === sessionDir
        ? Promise.reject(errorWithCode('ENOENT'))
        : realReaddir(target as never, { withFileTypes: true })) as never)
    service = createWorkspaceService({ root })
    expect(await service.list()).toEqual([])
  })

  it('skips live workspaces without metadata and stray files during sweep', async () => {
    service = createWorkspaceService({ root })
    const workspace = await create()
    fs.rmSync(path.join(root, 's1', 'r1.workspace.json'))
    fs.writeFileSync(path.join(root, 's1', 'stray.txt'), 'x')
    const orphan = path.join(root, 's1', 'r9')
    fs.mkdirSync(orphan)

    expect(await service.sweep()).toBe(1)
    expect(fs.existsSync(workspace.path)).toBe(true)
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('records sweep deletion failures', async () => {
    const onError = vi.fn()
    service = createWorkspaceService({ root, onError })
    const sessionDir = path.join(root, 's1')
    fs.mkdirSync(sessionDir, { recursive: true })
    const orphan = path.join(sessionDir, 'r9')
    fs.mkdirSync(orphan)
    const realRm = fsp.rm.bind(fsp)
    vi.spyOn(fsp, 'rm').mockImplementation(((target: string | Buffer | URL, options?: object) =>
      path.resolve(String(target)) === orphan
        ? Promise.reject(errorWithCode('EBUSY'))
        : realRm(target as never, options as never)) as never)

    expect(await service.sweep()).toBe(0)
    expect(onError).toHaveBeenCalled()
  })

  it('continues sweeping when a session directory cannot be read', async () => {
    const sessionDir = path.join(root, 's1')
    fs.mkdirSync(sessionDir, { recursive: true })
    const denied = errorWithCode('EACCES')
    const realReaddir = fsp.readdir.bind(fsp)
    let sessionReads = 0
    vi.spyOn(fsp, 'readdir').mockImplementation(((target: string | Buffer | URL) => {
      if (path.resolve(String(target)) === sessionDir && ++sessionReads === 2) {
        return Promise.reject(denied)
      }
      return realReaddir(target as never, { withFileTypes: true })
    }) as never)
    service = createWorkspaceService({ root })
    expect(await service.sweep()).toBe(0)
  })
})
