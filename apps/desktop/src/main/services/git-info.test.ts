import type { GitRunner } from '@cairn/checkpoint'
import { describe, expect, it, vi } from 'vitest'
import {
  checkoutGitBranch,
  createGitBranch,
  pullGitBranch,
  pushGitBranch,
  readGitInfo,
} from './git-info.js'

interface RunResult {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
}

function runner(...results: (RunResult | Error)[]): GitRunner {
  let index = 0
  return {
    binary: 'git',
    run: vi.fn(async () => {
      const result = results[Math.min(index, results.length - 1)]!
      index += 1
      if (result instanceof Error) throw result
      return {
        code: result.code ?? 0,
        stdout: Buffer.from(result.stdout ?? ''),
        stderr: result.stderr ?? '',
      }
    }),
  }
}

describe('readGitInfo', () => {
  it('reads the current branch, local branches and the GitHub origin', async () => {
    const git = runner(
      { stdout: 'feature/git-bar\n' },
      { stdout: 'feature/git-bar\nmain\nrelease/1.0\n' },
      { stdout: 'git@github.com:acme/demo.git\n' },
    )
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({
      branch: 'feature/git-bar',
      branches: ['feature/git-bar', 'main', 'release/1.0'],
      remote: 'github',
      remoteHost: 'github.com',
    })
    expect(git.run).toHaveBeenNthCalledWith(1, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/work/demo',
      allowFail: true,
    })
    expect(git.run).toHaveBeenNthCalledWith(
      2,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { cwd: '/work/demo', allowFail: true },
    )
    expect(git.run).toHaveBeenNthCalledWith(3, ['remote', 'get-url', 'origin'], {
      cwd: '/work/demo',
      allowFail: true,
    })
  })

  it('drops invalid, overlong and duplicate branch entries', async () => {
    const git = runner(
      { stdout: 'main\n' },
      { stdout: `main\r\nmain\n\n HEAD \n-leading\n${'a'.repeat(256)}\nfeature/x\n` },
      { stdout: 'https://gitee.com/acme/demo.git\n' },
    )
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({
      branch: 'main',
      branches: ['main', 'feature/x'],
      remote: 'gitee',
      remoteHost: 'gitee.com',
    })
  })

  it.each([
    [
      'a self-hosted SSH remote',
      'ssh://git@git.example.com:2222/acme/demo.git\n',
      'git.example.com',
    ],
    ['a local path remote', '/srv/git/demo.git\n', undefined],
    ['an unparseable remote', 'demo\n', undefined],
  ])('maps %s to the generic Git logo', async (_label, stdout, host) => {
    const git = runner({ stdout: 'main\n' }, { stdout: 'main\n' }, { stdout })
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({
      branch: 'main',
      branches: ['main'],
      remote: 'git',
      ...(host === undefined ? {} : { remoteHost: host }),
    })
  })

  it('keeps the branch when listing local branches fails', async () => {
    const git = runner({ stdout: 'main\n' }, { code: 128, stdout: '' }, { code: 2, stdout: '' })
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({ branch: 'main' })
  })

  it.each([
    ['a failing command', { code: 128, stdout: '' }],
    ['a detached HEAD', { stdout: 'HEAD\n' }],
    ['empty output', { stdout: '   \n' }],
    ['an overlong branch', { stdout: `${'a'.repeat(256)}\n` }],
    ['a branch starting with a dash', { stdout: '-danger\n' }],
    ['a branch with control characters', { stdout: 'bad\u0001name\n' }],
  ])('returns no branch for %s', async (_label, result) => {
    const git = runner(result)
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({})
    expect(git.run).toHaveBeenCalledOnce()
  })

  it('returns no branch when Git cannot be started', async () => {
    await expect(readGitInfo(runner(new Error('git unavailable')), '/work/demo')).resolves.toEqual(
      {},
    )
  })
})

describe('checkoutGitBranch', () => {
  it('checks out the branch and reports it', async () => {
    const git = runner({ stdout: '' })
    await expect(checkoutGitBranch(git, '/work/demo', ' feature/x ')).resolves.toEqual({
      branch: 'feature/x',
    })
    expect(git.run).toHaveBeenCalledWith(['checkout', 'feature/x'], {
      cwd: '/work/demo',
      allowFail: true,
    })
  })

  it.each([
    ['an empty branch', '  '],
    ['HEAD', 'HEAD'],
    ['an overlong branch', 'a'.repeat(256)],
    ['a branch starting with a dash', '-f'],
    ['a branch with control characters', 'bad\u0001name'],
  ])('rejects %s without running Git', async (_label, branch) => {
    const git = runner({ stdout: '' })
    await expect(checkoutGitBranch(git, '/work/demo', branch)).rejects.toMatchObject({
      code: 'project.invalid_branch',
    })
    expect(git.run).not.toHaveBeenCalled()
  })

  it('reports the first Git error line when checkout fails', async () => {
    const git = runner({
      code: 1,
      stderr: 'error: Your local changes would be overwritten\nAborting\n',
    })
    await expect(checkoutGitBranch(git, '/work/demo', 'main')).rejects.toMatchObject({
      code: 'project.checkout_failed',
      params: { reason: 'error: Your local changes would be overwritten' },
    })
  })

  it('falls back to the exit code when Git explains nothing', async () => {
    const git = runner({ code: 2, stderr: '\n \n' })
    await expect(checkoutGitBranch(git, '/work/demo', 'main')).rejects.toMatchObject({
      code: 'project.checkout_failed',
      params: { reason: 'git exited with 2' },
    })
  })
})

describe('createGitBranch', () => {
  it('creates the branch from the current one and returns the refreshed branch list', async () => {
    const git = runner(
      { code: 0 },
      { stdout: 'feature/login\n' },
      { stdout: 'main\nfeature/login\n' },
      { code: 2, stdout: '' },
    )
    await expect(createGitBranch(git, '/work/demo', 'feature/login')).resolves.toEqual({
      branch: 'feature/login',
      branches: ['main', 'feature/login'],
    })
    expect(git.run).toHaveBeenNthCalledWith(1, ['checkout', '-b', 'feature/login'], {
      cwd: '/work/demo',
      allowFail: true,
    })
  })

  it('reports the Git reason when the name is taken', async () => {
    const git = runner({
      code: 128,
      stderr: "fatal: a branch named 'main' already exists\n",
    })
    await expect(createGitBranch(git, '/work/demo', 'main')).rejects.toMatchObject({
      code: 'project.branch_create_failed',
      params: { reason: "fatal: a branch named 'main' already exists" },
    })
  })

  it('rejects an invalid branch without running Git', async () => {
    const git = runner({ code: 0 })
    await expect(createGitBranch(git, '/work/demo', '-x')).rejects.toMatchObject({
      code: 'project.invalid_branch',
    })
    expect(git.run).not.toHaveBeenCalled()
  })
})

describe('pullGitBranch', () => {
  it('fast-forwards the current branch and refreshes the summary', async () => {
    const git = runner(
      { code: 0, stdout: 'Already up to date.\n' },
      { stdout: 'main\n' },
      { stdout: 'main\ndev\n' },
      { code: 2, stdout: '' },
    )
    await expect(pullGitBranch(git, '/work/demo')).resolves.toEqual({
      branch: 'main',
      branches: ['main', 'dev'],
    })
    expect(git.run).toHaveBeenNthCalledWith(1, ['pull', '--ff-only'], {
      cwd: '/work/demo',
      allowFail: true,
    })
  })

  it('reports the Git reason when the pull cannot fast-forward', async () => {
    const git = runner({
      code: 1,
      stderr: 'fatal: Not possible to fast-forward, aborting.\n',
    })
    await expect(pullGitBranch(git, '/work/demo')).rejects.toMatchObject({
      code: 'project.pull_failed',
      params: { reason: 'fatal: Not possible to fast-forward, aborting.' },
    })
  })
})

describe('pushGitBranch', () => {
  it('pushes the current branch and refreshes the summary', async () => {
    const git = runner(
      { code: 0 },
      { stdout: 'main\n' },
      { stdout: 'main\n' },
      { code: 2, stdout: '' },
    )
    await expect(pushGitBranch(git, '/work/demo')).resolves.toEqual({
      branch: 'main',
      branches: ['main'],
    })
    expect(git.run).toHaveBeenNthCalledWith(1, ['push'], {
      cwd: '/work/demo',
      allowFail: true,
    })
  })

  it('reports the Git reason when there is no upstream branch', async () => {
    const git = runner({
      code: 128,
      stderr:
        'fatal: The current branch main has no upstream branch.\nTo push the current branch...\n',
    })
    await expect(pushGitBranch(git, '/work/demo')).rejects.toMatchObject({
      code: 'project.push_failed',
      params: { reason: 'fatal: The current branch main has no upstream branch.' },
    })
  })
})
