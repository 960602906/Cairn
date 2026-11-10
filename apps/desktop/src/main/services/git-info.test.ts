import type { GitRunner } from '@cairn/checkpoint'
import { describe, expect, it, vi } from 'vitest'
import { checkoutGitBranch, readGitInfo } from './git-info.js'

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
  it('reads the current branch and local branches for the project directory', async () => {
    const git = runner(
      { stdout: 'feature/git-bar\n' },
      { stdout: 'feature/git-bar\nmain\nrelease/1.0\n' },
    )
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({
      branch: 'feature/git-bar',
      branches: ['feature/git-bar', 'main', 'release/1.0'],
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
  })

  it('drops invalid, overlong and duplicate branch entries', async () => {
    const git = runner(
      { stdout: 'main\n' },
      { stdout: `main\r\nmain\n\n HEAD \n-leading\n${'a'.repeat(256)}\nfeature/x\n` },
    )
    await expect(readGitInfo(git, '/work/demo')).resolves.toEqual({
      branch: 'main',
      branches: ['main', 'feature/x'],
    })
  })

  it('keeps the branch when listing local branches fails', async () => {
    const git = runner({ stdout: 'main\n' }, { code: 128, stdout: '' })
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

  it('reports the last Git error line when checkout fails', async () => {
    const git = runner({
      code: 1,
      stderr: 'error: Your local changes would be overwritten\nAborting\n',
    })
    await expect(checkoutGitBranch(git, '/work/demo', 'main')).rejects.toMatchObject({
      code: 'project.checkout_failed',
      params: { reason: 'Aborting' },
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
