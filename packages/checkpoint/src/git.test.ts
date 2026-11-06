import { describe, expect, it } from 'vitest'
import {
  CheckpointErrorCode,
  createGitRunner,
  detectGit,
  isolatedGitEnv,
  isSupportedGitVersion,
  parseGitVersion,
  type GitRunner,
} from './git.js'

const env = isolatedGitEnv(process.env, '/nonexistent/cairn-global-config')

describe('isolatedGitEnv', () => {
  it('drops inherited GIT_* variables and isolates config', () => {
    const result = isolatedGitEnv(
      { PATH: '/bin', GIT_DIR: '/x', git_index_file: '/y', HOME: '/h', EMPTY: undefined },
      '/empty',
    )
    expect(result).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/empty',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    })
  })
})

describe('Git version', () => {
  it.each([
    ['git version 2.56.0.windows.4', [2, 56, 0]],
    ['git version 2.32', [2, 32, 0]],
    ['git version 3.0.1 (Apple Git-1)', [3, 0, 1]],
  ] as const)('parses %s', (output, expected) => {
    expect(parseGitVersion(output)).toEqual(expected)
  })

  it('rejects unknown output and versions below 2.32', () => {
    expect(parseGitVersion('hello')).toBeUndefined()
    expect(isSupportedGitVersion([2, 32, 0])).toBe(true)
    expect(isSupportedGitVersion([2, 33, 0])).toBe(true)
    expect(isSupportedGitVersion([3, 0, 0])).toBe(true)
    expect(isSupportedGitVersion([2, 31, 9])).toBe(false)
    expect(isSupportedGitVersion([1, 99, 0])).toBe(false)
  })
})

const fake = (output: string | Error): GitRunner => ({
  binary: 'fake-git',
  run: async () => {
    if (output instanceof Error) throw output
    return { code: 0, stdout: Buffer.from(output), stderr: '' }
  },
})

describe('detectGit', () => {
  it('reports availability and the reason when unavailable', async () => {
    await expect(detectGit(fake('git version 2.56.0\n'))).resolves.toEqual({
      available: true,
      binary: 'fake-git',
      version: '2.56.0',
    })
    await expect(detectGit(fake('git version 2.30.1'))).resolves.toEqual({
      available: false,
      binary: 'fake-git',
      reason: 'too_old',
      version: '2.30.1',
    })
    await expect(detectGit(fake('nope'))).resolves.toMatchObject({ reason: 'unrecognized' })
    await expect(detectGit(fake(new Error('ENOENT')))).resolves.toMatchObject({
      reason: 'not_found',
    })
  })

  it('detects the real Git', async () => {
    await expect(detectGit(createGitRunner({ env }))).resolves.toMatchObject({ available: true })
  })
})

describe('createGitRunner', () => {
  const git = createGitRunner({ env })

  it('runs Git with stdin and returns its output', async () => {
    const result = await git.run(['hash-object', '--stdin'], { stdin: 'hello\n' })
    expect(result.stdout.toString().trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('throws on failure unless allowed', async () => {
    await expect(git.run(['no-such-command'])).rejects.toMatchObject({
      code: CheckpointErrorCode.Failed,
      params: { exitCode: expect.any(String) },
    })
    const result = await git.run(['no-such-command'], { allowFail: true })
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toBe('')
  })

  it('reports a missing binary as unavailable', async () => {
    const missing = createGitRunner({ binary: '/nonexistent/git', env })
    expect(missing.binary).toBe('/nonexistent/git')
    await expect(missing.run(['--version'])).rejects.toMatchObject({
      code: CheckpointErrorCode.GitUnavailable,
    })
  })
})
