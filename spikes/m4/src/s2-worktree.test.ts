/**
 * S2：以影子仓库的检查点提交为基线创建隔离工作区。
 *
 * 假设：`git worktree add --detach <checkpoint>` 可以在 Windows 与 Linux 上从影子仓库检出工作区，
 * 不复制被排除的 `node_modules` / 超大文件 / 嵌套仓库；主工作区不受影响；清理后没有残留。
 *
 * 本测试使用真实的 `@cairn/checkpoint` 与系统 Git（≥ 2.32）。结果以 `M4_S2_RESULT` JSON 行输出。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openShadowRepo, type ShadowRepo } from '@cairn/checkpoint'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-m4-s2-'))
  roots.push(root)
  return root
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function initRepo(cwd: string): void {
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.name', 'Spike'])
  git(cwd, ['config', 'user.email', 'spike@cairn.invalid'])
  git(cwd, ['config', 'commit.gpgSign', 'false'])
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', 'initial'])
}

interface Project {
  readonly root: string
  readonly shadow: ShadowRepo
  readonly checkpoint: string
}

async function prepare(gitRepo: boolean): Promise<Project> {
  const base = tempRoot()
  const root = path.join(base, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true })
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true })

  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# spike\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(root, 'assets', 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'first\r\nsecond\r\n')

  fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'nested repo\n')
  initRepo(path.join(root, 'nested'))

  if (gitRepo) initRepo(root)
  // 未提交改动必须进入检查点
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 2\n')

  const shadow = await openShadowRepo({
    gitDir: path.join(base, 'shadow.git'),
    workTree: root,
    maxFileBytes: 1024 * 1024,
    extraExcludes: ['node_modules/'],
  })
  const checkpoint = await shadow.checkpoint('m4 s2 baseline')
  return { root, shadow, checkpoint: checkpoint.commit }
}

function addWorktree(project: Project, destination: string): void {
  git(project.root, [
    '--git-dir',
    project.shadow.gitDir,
    '--work-tree',
    project.root,
    'worktree',
    'add',
    '--detach',
    destination,
    project.checkpoint,
  ])
}

function removeWorktree(project: Project, destination: string): void {
  git(project.root, [
    '--git-dir',
    project.shadow.gitDir,
    '--work-tree',
    project.root,
    'worktree',
    'remove',
    '--force',
    destination,
  ])
  git(project.root, [
    '--git-dir',
    project.shadow.gitDir,
    '--work-tree',
    project.root,
    'worktree',
    'prune',
  ])
}

function status(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
}

function countFiles(root: string): number {
  let count = 0
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) count += 1
    }
  }
  walk(root)
  return count
}

describe('S2 隔离工作区', () => {
  it('从检查点检出隔离工作区，排除依赖与大文件，不触碰主工作区', async () => {
    const project = await prepare(true)
    const destination = path.join(path.dirname(project.root), 'worktree')
    const started = performance.now()
    addWorktree(project, destination)
    const checkoutMs = Math.round(performance.now() - started)
    const worktreeFiles = countFiles(destination)

    expect(fs.readFileSync(path.join(destination, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 2\n',
    )
    expect(fs.readFileSync(path.join(destination, 'crlf.txt'))).toEqual(
      Buffer.from('first\r\nsecond\r\n'),
    )
    expect(fs.existsSync(path.join(destination, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(destination, 'assets', 'large.bin'))).toBe(false)
    expect(fs.existsSync(path.join(destination, 'nested'))).toBe(false)
    expect(status(destination)).toBe('')

    fs.writeFileSync(path.join(destination, 'src', 'index.ts'), 'export const value = 3\n')
    fs.writeFileSync(path.join(destination, 'tests.test.ts'), 'export const test = true\n')
    const childStatus = status(destination)
    expect(childStatus).toContain('src/index.ts')
    expect(childStatus).toContain('tests.test.ts')

    // 主工作区不受子工作区改动影响
    expect(fs.readFileSync(path.join(project.root, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 2\n',
    )
    expect(fs.existsSync(path.join(project.root, 'tests.test.ts'))).toBe(false)
    // 子工作区复用外壳仓库，不新增用户自己的 .git
    expect(fs.statSync(path.join(destination, '.git')).isFile()).toBe(true)

    removeWorktree(project, destination)
    expect(fs.existsSync(destination)).toBe(false)

    console.log(
      `M4_S2_RESULT ${JSON.stringify({
        platform: process.platform,
        checkoutMs,
        worktreeFiles,
        projectFiles: countFiles(project.root),
      })}`,
    )
  })

  it('非 Git 项目也能创建工作区，并支持依赖 junction 与长路径', async () => {
    const project = await prepare(false)
    expect(fs.existsSync(path.join(project.root, '.git'))).toBe(false)

    const deepRelative = Array.from(
      { length: 10 },
      (_, index) => `segment-${index}-0123456789`,
    ).join(path.sep)
    const deepDir = path.join(project.root, 'deep', deepRelative)
    fs.mkdirSync(deepDir, { recursive: true })
    fs.writeFileSync(path.join(deepDir, 'leaf.txt'), 'deep\n')

    const refreshed = await project.shadow.checkpoint('deep path')

    const destination = path.join(path.dirname(project.root), 'worktree')
    git(project.root, [
      '--git-dir',
      project.shadow.gitDir,
      '--work-tree',
      project.root,
      'worktree',
      'add',
      '--detach',
      destination,
      refreshed.commit,
    ])

    const deepLeaf = path.join(destination, 'deep', deepRelative, 'leaf.txt')
    expect(fs.readFileSync(deepLeaf, 'utf8')).toBe('deep\n')

    const link = path.join(destination, 'node_modules')
    fs.symlinkSync(
      path.join(project.root, 'node_modules'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(fs.readFileSync(path.join(link, 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')

    removeWorktree(project, destination)
  })
})
