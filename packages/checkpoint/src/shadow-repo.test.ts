/**
 * 影子仓库的真实 Git 测试。校验不依赖被测实现（移植 S5）：恢复后按内容哈希（含可执行位与符号链接
 * 目标）比对整个工作区，并确认被排除的文件、用户的 `.git` 与嵌套仓库都没有被改动。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointErrorCode, createGitRunner, isolatedGitEnv, type GitRunner } from './git.js'
import { CHECKPOINT_REF, openShadowRepo, type ShadowRepoOptions } from './shadow-repo.js'

const IS_WINDOWS = process.platform === 'win32'
const MAX = 1000

let tmp: string
let work: string
let gitDir: string

const file = (rel: string) => path.join(work, ...rel.split('/'))
const write = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true })
  fs.writeFileSync(file(rel), content)
}
const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')

/** 用户自己的 Git（与被测实现无关）。 */
const userGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', ...args], {
    cwd,
    stdio: 'pipe',
  }).toString()

function walk(root: string, rel = '', out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(root, child, out)
    else out.push(child)
  }
  return out
}

/** 工作区清单：路径 → 内容哈希（含可执行位、符号链接目标）。 */
function manifest(filter: (rel: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of walk(work).sort()) {
    if (!filter(rel)) continue
    const st = fs.lstatSync(file(rel))
    if (st.isSymbolicLink()) {
      out[rel] = `link:${fs.readlinkSync(file(rel))}`
      continue
    }
    const hash = crypto
      .createHash('sha1')
      .update(fs.readFileSync(file(rel)))
      .digest('hex')
    out[rel] = `${!IS_WINDOWS && (st.mode & 0o111) !== 0 ? 'x' : '-'}${hash}`
  }
  return out
}

/** 检查点应包含的文件（按 fixture 规则独立判断）。 */
const tracked = (rel: string) =>
  !rel.startsWith('.git/') &&
  !rel.startsWith('dist/') &&
  !rel.endsWith('.log') &&
  !rel.includes('node_modules/') &&
  !rel.startsWith('vendor/') &&
  !rel.startsWith('pkg/generated/') &&
  !rel.startsWith('big')
const untracked = (rel: string) => !tracked(rel)

function emptyDirs(rel = '', out: string[] = []): string[] {
  const entries = fs.readdirSync(path.join(work, rel), { withFileTypes: true })
  if (rel && entries.length === 0) out.push(rel)
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    // 用户的仓库与嵌套仓库不在检查点范围内
    if (e.isDirectory() && e.name !== '.git' && !child.startsWith('vendor')) emptyDirs(child, out)
  }
  return out
}

function fixture() {
  write('.gitignore', 'dist/\n*.log\n')
  write('pkg/.gitignore', 'generated/\n')
  write('pkg/generated/out.js', 'generated')
  write('dist/bundle.js', 'bundle')
  write('debug.log', 'log')
  write('node_modules/a/index.js', 'dep')
  write('pkg/node_modules/b/index.js', 'dep')
  write('src/a.ts', 'export const a = 1\n')
  write('src/deep/b.ts', 'export const b = 2\n')
  write('crlf.txt', 'one\r\ntwo\r\n')
  write('lf.txt', 'one\ntwo\n')
  write('.gitattributes', '*.txt text eol=crlf\n*.bin filter=lfs diff=lfs merge=lfs -text\n')
  write('asset.bin', Buffer.from([0, 1, 2, 255]))
  write('docs/中文 文件名.md', '你好\n')
  write('docs/a & b #[1]!.md', 'special\n')
  write('big.dat', Buffer.alloc(MAX + 1, 1))
  write('almost.dat', Buffer.alloc(MAX, 2))
  if (!IS_WINDOWS) {
    write('run.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(file('run.sh'), 0o755)
    fs.symlinkSync('src/a.ts', file('link.ts'))
  }
  // 用户自己的仓库与嵌套仓库
  userGit(work, 'init', '-q')
  userGit(work, 'add', '.gitignore')
  userGit(work, 'commit', '-qm', 'user commit')
  write('vendor/lib/lib.js', 'lib')
  userGit(file('vendor/lib'), 'init', '-q')
  userGit(file('vendor/lib'), 'add', '.')
  userGit(file('vendor/lib'), 'commit', '-qm', 'lib')
  fs.mkdirSync(file('vendor/unborn'), { recursive: true })
  userGit(file('vendor/unborn'), 'init', '-q')
  write('vendor/unborn/x.js', 'x')
}

/** 模拟一轮对话的改动：修改、新增、删除（含整个目录），并改动被排除的文件。 */
function change() {
  write('src/a.ts', 'export const a = 100\n')
  write('src/new.ts', 'new\n')
  write('new/dir/n.ts', 'nested new\n')
  fs.rmSync(file('src/deep'), { recursive: true })
  fs.rmSync(file('docs/中文 文件名.md'))
  write('crlf.txt', 'changed\r\n')
  write('dist/bundle.js', 'bundle 2')
  write('node_modules/a/index.js', 'dep 2')
  write('vendor/lib/lib.js', 'lib 2')
  write('big2.dat', Buffer.alloc(MAX * 2, 3))
}

const options = (extra: Partial<ShadowRepoOptions> = {}): ShadowRepoOptions => ({
  gitDir,
  workTree: work,
  maxFileBytes: MAX,
  ...extra,
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-checkpoint-'))
  work = path.join(tmp, 'work')
  gitDir = path.join(tmp, 'shadow', 'p1.git')
  fs.mkdirSync(work)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('openShadowRepo: checkpoint and restore', () => {
  it('snapshots only the expected files and restores them byte for byte', async () => {
    fixture()
    const userGitBefore = manifest((rel) => rel.startsWith('.git/'))
    const repo = await openShadowRepo(options())
    expect(repo.rebuilt).toBe(false)
    expect(repo.head()).toBeUndefined()

    const first = await repo.checkpoint('turn 1')
    expect(first.created).toBe(true)
    expect(first.skippedLarge).toEqual(['big.dat'])
    expect(first.nestedRepos).toEqual(['vendor/lib', 'vendor/unborn'])
    expect(first.warnings).toBe('')
    expect(repo.head()).toBe(first.commit)

    // 检查点中的文件与独立算出的列表一致
    const listed = execFileSync('git', [
      '--git-dir',
      gitDir,
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      first.commit,
    ])
      .toString()
      .split('\0')
      .filter(Boolean)
      .sort()
    expect(listed).toEqual(Object.keys(manifest(tracked)))

    // 无改动时复用；只改修改时间也复用
    const again = await repo.checkpoint('turn 2')
    expect(again).toMatchObject({ commit: first.commit, created: false })
    const later = new Date(Date.now() + 60_000)
    for (const rel of walk(work)) if (tracked(rel)) fs.lutimesSync(file(rel), later, later)
    expect((await repo.checkpoint('touch')).created).toBe(false)

    const original = manifest(tracked)
    change()
    const changed = manifest(tracked)
    const excludedBefore = manifest(untracked)

    const plan = await repo.preview(first.commit)
    expect(plan.before).not.toBe(first.commit)
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'deleted' },
        { path: 'new/dir/n.ts', status: 'deleted' },
        { path: 'src/deep/b.ts', status: 'added' },
        { path: 'docs/中文 文件名.md', status: 'added' },
        { path: 'crlf.txt', status: 'modified' },
      ]),
    )
    expect(plan.changes).toHaveLength(6)
    expect(manifest(tracked)).toEqual(changed) // 预览不改动工作区

    const restored = await repo.restore(first.commit)
    expect(restored).toEqual(plan)
    expect(manifest(tracked)).toEqual(original)
    expect(read('crlf.txt')).toBe('one\r\ntwo\r\n')
    expect(read('lf.txt')).toBe('one\ntwo\n')
    expect(emptyDirs()).toEqual([])
    expect(fs.existsSync(file('new'))).toBe(false)
    // 被排除的文件、嵌套仓库与用户的 .git 不受影响
    expect(manifest(untracked)).toEqual(excludedBefore)
    expect(manifest((rel) => rel.startsWith('.git/'))).toEqual(userGitBefore)

    // 撤销恢复
    await repo.restore(restored.before)
    expect(manifest(tracked)).toEqual(changed)
    expect(manifest((rel) => rel.startsWith('.git/'))).toEqual(userGitBefore)
  })

  it('re-includes files that shrink below the limit and drops ones that grow', async () => {
    write('a.txt', 'a')
    write('grow.dat', 'small')
    write('shrink.dat', Buffer.alloc(MAX + 1))
    const repo = await openShadowRepo(options())
    const first = await repo.checkpoint('1')
    expect(first.skippedLarge).toEqual(['shrink.dat'])

    write('grow.dat', Buffer.alloc(MAX + 1))
    write('shrink.dat', 'small now')
    const second = await repo.checkpoint('2')
    expect(second.skippedLarge).toEqual(['grow.dat'])
    const changes = await repo.diff(first.commit, second.commit)
    expect(changes).toEqual([
      { path: 'grow.dat', status: 'deleted' },
      { path: 'shrink.dat', status: 'added' },
    ])

    // 恢复：检查点中较小的版本覆盖现在超过上限的文件；当时超限（没有快照）、现在被收录的文件被删除
    await repo.restore(first.commit)
    expect(read('grow.dat')).toBe('small')
    expect(fs.existsSync(file('shrink.dat'))).toBe(false)
  })

  it('keeps its state across reopen and ignores the user Git environment', async () => {
    const home = path.join(tmp, 'home')
    fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[core]\n\tautocrlf = true\n\thooksPath = /nonexistent\n[commit]\n\tgpgSign = true\n',
    )
    fs.writeFileSync(path.join(home, '.config', 'git', 'ignore'), '*.md\n')
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_DIR: path.join(tmp, 'elsewhere'),
      GIT_INDEX_FILE: path.join(tmp, 'elsewhere-index'),
      GIT_WORK_TREE: path.join(tmp, 'elsewhere-work'),
    }
    write('readme.md', 'line\n')
    write('big.dat', Buffer.alloc(MAX + 1))
    const repo = await openShadowRepo(options({ env }))
    const first = await repo.checkpoint('1')
    expect(first.skippedLarge).toEqual(['big.dat'])

    const reopened = await openShadowRepo(options({ env }))
    expect(reopened.rebuilt).toBe(false)
    expect(reopened.head()).toBe(first.commit)
    expect(reopened.gitVersion).toMatch(/^\d+\.\d+\.\d+$/)
    const again = await reopened.checkpoint('2')
    expect(again).toMatchObject({ commit: first.commit, created: false, skippedLarge: ['big.dat'] })

    write('readme.md', 'changed\n')
    await reopened.restore(first.commit)
    expect(read('readme.md')).toBe('line\n')
    expect(fs.existsSync(path.join(tmp, 'elsewhere'))).toBe(false)
  })

  it('runs operations one at a time and supports gc', async () => {
    write('a.txt', 'a')
    const repo = await openShadowRepo(options())
    const results = await Promise.all([repo.checkpoint('1'), repo.checkpoint('2')])
    expect(results.map((r) => r.created)).toEqual([true, false])
    await repo.gc()
    // gc 之后引用被打包，重新打开仍能读到
    const reopened = await openShadowRepo(options())
    expect(reopened.head()).toBe(results[0].commit)
    await expect(reopened.has(results[0].commit)).resolves.toBe(true)
  })

  it('snapshots an empty workspace', async () => {
    const repo = await openShadowRepo(options())
    const result = await repo.checkpoint('empty')
    expect(result).toMatchObject({ created: true, skippedLarge: [], nestedRepos: [] })
    await expect(repo.diff(result.commit, result.commit)).resolves.toEqual([])
  })
})

describe('openShadowRepo: errors', () => {
  it('rejects unknown and malformed checkpoint ids', async () => {
    write('a.txt', 'a')
    const repo = await openShadowRepo(options())
    const { commit } = await repo.checkpoint('1')
    for (const id of ['f'.repeat(40), '--output=/tmp/x', 'HEAD', CHECKPOINT_REF]) {
      await expect(repo.has(id)).resolves.toBe(false)
      await expect(repo.restore(id)).rejects.toMatchObject({ code: CheckpointErrorCode.NotFound })
      await expect(repo.diff(commit, id)).rejects.toMatchObject({
        code: CheckpointErrorCode.NotFound,
        params: { checkpointId: id },
      })
    }
    // 失败之后仍可继续操作
    await expect(repo.preview(commit)).resolves.toMatchObject({ changes: [] })
  })

  it('rebuilds a corrupted shadow repository', async () => {
    write('a.txt', 'a')
    const repo = await openShadowRepo(options())
    await repo.checkpoint('1')
    for (const entry of walk(path.join(gitDir, 'objects'))) {
      fs.rmSync(path.join(gitDir, 'objects', ...entry.split('/')))
    }
    const reopened = await openShadowRepo(options())
    expect(reopened.rebuilt).toBe(true)
    expect(reopened.head()).toBeUndefined()
    await expect(reopened.checkpoint('fresh')).resolves.toMatchObject({ created: true })
  })

  it('fails when Git is unavailable', async () => {
    await expect(
      openShadowRepo(options({ gitBinary: path.join(tmp, 'no-git') })),
    ).rejects.toMatchObject({
      code: CheckpointErrorCode.GitUnavailable,
      params: { reason: 'not_found' },
    })
    const old: GitRunner = {
      binary: 'old-git',
      run: async () => ({ code: 0, stdout: Buffer.from('git version 2.20.1'), stderr: '' }),
    }
    await expect(openShadowRepo(options({ git: old }))).rejects.toMatchObject({
      code: CheckpointErrorCode.GitUnavailable,
      params: { reason: 'too_old', version: '2.20.1' },
    })
  })

  it('reports add warnings and fails on other add errors', async () => {
    const real = createGitRunner({
      env: isolatedGitEnv(process.env, path.join(tmp, 'no-global')),
    })
    let addResult: { code: number; stderr: string } | undefined
    const git: GitRunner = {
      binary: real.binary,
      run: async (args, opts) =>
        addResult && args.includes('add')
          ? { ...addResult, stdout: Buffer.alloc(0) }
          : real.run(args, opts),
    }
    write('a.txt', 'a')
    const repo = await openShadowRepo(options({ git }))
    addResult = {
      code: 1,
      stderr: 'error: open("locked.txt"): Permission denied\nfatal: adding files failed',
    }
    await expect(repo.checkpoint('1')).resolves.toMatchObject({
      warnings: expect.stringContaining('Permission denied'),
    })
    addResult = { code: 128, stderr: 'fatal: bad index file' }
    await expect(repo.checkpoint('2')).rejects.toMatchObject({ code: CheckpointErrorCode.Failed })
  })

  it('rejects refs outside refs/cairn/', async () => {
    for (const ref of ['refs/heads/main', 'refs/cairn/../heads/x', 'refs/cairn/a.lock', 'HEAD']) {
      await expect(openShadowRepo(options({ ref }))).rejects.toMatchObject({
        code: CheckpointErrorCode.Failed,
      })
    }
  })
})

describe('openShadowRepo: sessions sharing a project', () => {
  it('keeps separate checkpoint chains on one shadow repository', async () => {
    write('a.txt', 'a')
    const s1 = await openShadowRepo(options({ ref: 'refs/cairn/sessions/s1' }))
    const s2 = await openShadowRepo(options({ ref: 'refs/cairn/sessions/s2' }))
    const first = await s1.checkpoint('s1 turn')
    write('a.txt', 'b')
    const second = await s2.checkpoint('s2 turn')
    write('a.txt', 'c')
    const [third] = await Promise.all([s1.checkpoint('s1 again'), s2.checkpoint('s2 again')])
    // 两个会话的检查点互相可见（共用对象），各自的提交链独立
    await s2.restore(first.commit)
    expect(read('a.txt')).toBe('a')
    await s1.restore(second.commit)
    expect(read('a.txt')).toBe('b')
    const reopened = await openShadowRepo(options({ ref: 'refs/cairn/sessions/s1' }))
    expect(reopened.head()).not.toBe(second.commit)
    await expect(reopened.has(third.commit)).resolves.toBe(true)
  })

  it('continues the chain when another process moved the same ref', async () => {
    write('a.txt', 'a')
    const host = await openShadowRepo(options({ ref: 'refs/cairn/sessions/s1' }))
    const first = await host.checkpoint('turn')
    // 另一个进程（主进程恢复时）在同一个引用上创建检查点
    const main = await openShadowRepo(options({ ref: 'refs/cairn/sessions/s1' }))
    write('a.txt', 'b')
    const { before } = await main.restore(first.commit)
    expect(read('a.txt')).toBe('a')
    write('a.txt', 'c')
    const next = await host.checkpoint('turn again')
    expect(next.created).toBe(true)
    const parent = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `${next.commit}^`])
    expect(parent.toString().trim()).toBe(before)
    // 引用没有变化时复用上一个检查点
    await expect(host.checkpoint('same')).resolves.toMatchObject({
      commit: next.commit,
      created: false,
    })
  })

  it('waits for a Git lock held by another process', async () => {
    write('a.txt', 'a')
    const repo = await openShadowRepo(options({ lockTimeoutMs: 5000 }))
    const lock = path.join(gitDir, 'index.lock')
    fs.writeFileSync(lock, '')
    setTimeout(() => fs.rmSync(lock), 200)
    await expect(repo.checkpoint('1')).resolves.toMatchObject({ created: true })

    const short = await openShadowRepo(options({ lockTimeoutMs: 100 }))
    fs.writeFileSync(lock, '')
    write('a.txt', 'b')
    await expect(short.checkpoint('2')).rejects.toMatchObject({ code: CheckpointErrorCode.Failed })
    fs.rmSync(lock)
    await expect(short.checkpoint('3')).resolves.toMatchObject({ created: true })
  })

  it('does not snapshot a shadow repository inside the workspace', async () => {
    write('a.txt', 'a')
    const inside = path.join(work, 'app-data', 'checkpoints', 'p1.git')
    const repo = await openShadowRepo(options({ gitDir: inside }))
    const { commit } = await repo.checkpoint('1')
    const listed = execFileSync('git', [
      '--git-dir',
      inside,
      'ls-tree',
      '-r',
      '--name-only',
      commit,
    ])
      .toString()
      .trim()
      .split('\n')
    expect(listed).toEqual(['a.txt'])
  })
})
