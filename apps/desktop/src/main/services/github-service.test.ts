import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_CREDENTIAL_REF, GITHUB_LOG_MAX_CHARS, RpcError } from '@cairn/protocol'
import {
  createGithubService,
  createGithubTokenResolver,
  ghAuthCandidates,
  normalizeGithubApiBase,
  type FetchLike,
  type GithubCredentials,
} from './github-service.js'

function tokenResolver(token?: string): () => Promise<string | undefined> {
  return async () => token
}

function storedCredentials(token?: string): GithubCredentials {
  return {
    async resolve(ref) {
      return ref === GITHUB_CREDENTIAL_REF && token !== undefined ? { apiKey: token } : undefined
    },
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('github token resolution', () => {
  it('prefers GH_TOKEN, then GITHUB_TOKEN', async () => {
    const readGhToken = vi.fn(async () => 'gh-token')
    const ghToken = createGithubTokenResolver({
      credentials: storedCredentials('stored-token'),
      env: { GH_TOKEN: 'GH_TOKEN-value', GITHUB_TOKEN: 'github-token-value' },
      readGhToken,
    })
    expect(await ghToken()).toBe('GH_TOKEN-value')

    const gitHubToken = createGithubTokenResolver({
      credentials: storedCredentials('stored-token'),
      env: { GITHUB_TOKEN: 'github-token-value' },
      readGhToken,
    })
    expect(await gitHubToken()).toBe('github-token-value')
    expect(readGhToken).not.toHaveBeenCalled()
  })

  it('falls back to the token saved by the old settings page', async () => {
    const readGhToken = vi.fn(async () => 'gh-token')
    const resolve = createGithubTokenResolver({
      credentials: storedCredentials('stored-token'),
      env: {},
      readGhToken,
    })
    expect(await resolve()).toBe('stored-token')
    expect(readGhToken).not.toHaveBeenCalled()
  })

  it('caches the gh auth token and its absence', async () => {
    const readGhToken = vi.fn(async () => 'gh-token')
    const resolve = createGithubTokenResolver({
      credentials: storedCredentials(),
      env: {},
      readGhToken,
    })
    expect(await resolve()).toBe('gh-token')
    expect(await resolve()).toBe('gh-token')
    expect(readGhToken).toHaveBeenCalledTimes(1)

    const missing = vi.fn(async () => undefined)
    const resolveMissing = createGithubTokenResolver({
      credentials: storedCredentials(),
      env: {},
      readGhToken: missing,
    })
    expect(await resolveMissing()).toBeUndefined()
    expect(await resolveMissing()).toBeUndefined()
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('ignores blank environment values and survives a failing credential store', async () => {
    const readGhToken = vi.fn(async () => 'gh-token')
    const resolve = createGithubTokenResolver({
      credentials: {
        async resolve() {
          throw new Error('no keyring')
        },
      },
      env: { GH_TOKEN: '  ' },
      readGhToken,
    })
    expect(await resolve()).toBe('gh-token')
  })
})

describe('gh auth token candidates', () => {
  it('looks in Homebrew paths on macOS', () => {
    expect(ghAuthCandidates('darwin', {})).toEqual([
      'gh',
      '/opt/homebrew/bin/gh',
      '/usr/local/bin/gh',
    ])
  })

  it('looks in common install locations on Linux', () => {
    expect(ghAuthCandidates('linux', {})).toEqual([
      'gh',
      '/usr/bin/gh',
      '/usr/local/bin/gh',
      '/snap/bin/gh',
    ])
  })

  it('looks in the GitHub CLI install folder on Windows', () => {
    expect(ghAuthCandidates('win32', { ProgramFiles: 'C:\\Program Files' })).toEqual([
      'gh.exe',
      'C:\\Program Files\\GitHub CLI\\gh.exe',
    ])
  })
})

describe('github-service', () => {
  it('reports not connected when no token can be resolved', async () => {
    const service = createGithubService({ resolveToken: tokenResolver() })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.not_connected',
    })
  })

  it('maps a pull request and sorts its checks', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) => {
        if (input.endsWith('/pulls/12')) {
          return json({
            title: 'Fix the thing',
            html_url: 'https://github.com/o/r/pull/12',
            state: 'open',
            draft: false,
            head: {
              ref: 'fix',
              sha: 'abcdef1234567890',
              repo: { full_name: 'o/r' },
            },
            base: { ref: 'main' },
            mergeable_state: 'dirty',
          })
        }
        return json({
          check_runs: [
            { id: 2, name: 'test', status: 'completed', conclusion: 'failure', details_url: 'x' },
            {
              id: 1,
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-11-18T01:00:00Z',
              completed_at: '2026-11-18T01:02:00Z',
            },
            { id: 3, name: 'bad' },
          ],
        })
      },
    })
    const pull = await service.pullRequest({ repo: 'o/r', number: 12 })
    expect(pull).toMatchObject({
      repo: 'o/r',
      number: 12,
      title: 'Fix the thing',
      state: 'open',
      draft: false,
      headRef: 'fix',
      headRepo: 'o/r',
      baseRef: 'main',
      mergeableState: 'dirty',
    })
    expect(pull.checks.map((check) => check.name)).toEqual(['lint', 'test'])
    expect(pull.checks[0]).toMatchObject({ conclusion: 'success', startedAt: expect.any(Number) })
  })

  it('maps GitHub errors to stable codes', async () => {
    const failing = (status: number, headers: Record<string, string> = {}) =>
      createGithubService({
        resolveToken: tokenResolver('token'),
        fetchImpl: async () => json({}, status, headers),
      })
    await expect(failing(404).pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.not_found',
    })
    await expect(
      failing(403, { 'x-ratelimit-remaining': '0' }).pullRequest({ repo: 'o/r', number: 1 }),
    ).rejects.toMatchObject({ code: 'github.rate_limited' })
    await expect(failing(500).pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.network',
    })
    await expect(
      createGithubService({
        resolveToken: tokenResolver('token'),
        fetchImpl: async () => {
          throw new Error('offline')
        },
      }).pullRequest({ repo: 'o/r', number: 1 }),
    ).rejects.toMatchObject({ code: 'github.network' })
  })

  it('maps review comments oldest first and drops invalid entries', async () => {
    const calls: string[] = []
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) => {
        calls.push(input)
        return json([
          { id: 42, user: { login: 'bob' }, body: 'latest', path: 'src/a.ts', line: 3 },
          { id: 40, user: { login: 'ann' }, body: 'first' },
          { id: 'bad', user: { login: 'x' }, body: 'x' },
          { id: 41, user: { login: 'x' }, body: '   ' },
          { id: 43, user: { login: 'ann' }, body: 'no location', path: 5, line: -1 },
        ])
      },
    })
    await expect(service.reviewComments({ repo: 'o/r', number: 12 })).resolves.toEqual([
      { id: 40, author: 'ann', body: 'first' },
      { id: 42, author: 'bob', body: 'latest', path: 'src/a.ts', line: 3 },
      { id: 43, author: 'ann', body: 'no location' },
    ])
    expect(calls[0]).toBe(
      'https://api.github.com/repos/o/r/pulls/12/comments?per_page=100&sort=created&direction=desc',
    )
  })

  it('treats an unexpected comment list as empty and maps errors', async () => {
    const unexpected = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async () => json({ message: 'not a list' }),
    })
    await expect(unexpected.reviewComments({ repo: 'o/r', number: 12 })).resolves.toEqual([])

    const missing = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        json(
          {},
          input.endsWith('/pulls/12/comments?per_page=100&sort=created&direction=desc') ? 404 : 200,
        ),
    })
    await expect(missing.reviewComments({ repo: 'o/r', number: 12 })).rejects.toMatchObject({
      code: 'github.not_found',
    })
  })

  it('requires a token for reads', async () => {
    const service = createGithubService({ resolveToken: tokenResolver() })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toBeInstanceOf(RpcError)
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.not_connected',
    })
  })

  it('unzips the job log and keeps the end when it is too long', async () => {
    const log = `${'x'.repeat(200)}FAILED at the end`
    const archive = zipSync({ 'job.txt': strToU8(log) })
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) => {
        if (input.includes('/check-runs/7')) {
          return json({
            id: 7,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            details_url: 'https://github.com/o/r/actions/runs/55/job/99',
          })
        }
        if (input.endsWith('/actions/jobs/99/logs')) {
          return new Response(archive, { status: 200 })
        }
        return json({}, 404)
      },
    })
    const result = await service.checkLog({ repo: 'o/r', checkRunId: 7 })
    expect(result).toEqual({ text: log, truncated: false })

    const long = `${'y'.repeat(GITHUB_LOG_MAX_CHARS + 10)}TAIL`
    const truncating = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        input.includes('/check-runs/7')
          ? json({ details_url: 'https://github.com/o/r/actions/runs/55/job/99' })
          : new Response(zipSync({ 'job.txt': strToU8(long) }), { status: 200 }),
    })
    const clipped = await truncating.checkLog({ repo: 'o/r', checkRunId: 7 })
    expect(clipped.truncated).toBe(true)
    expect(clipped.text).toHaveLength(GITHUB_LOG_MAX_CHARS)
    expect(clipped.text.endsWith('TAIL')).toBe(true)
  })

  it('reports a missing log address', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async () => json({ id: 7, details_url: 'https://example.com/nothing' }),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).rejects.toMatchObject({
      code: 'github.log_unavailable',
    })
  })

  it('reports a check run that has no address at all', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async () => json({ id: 7 }),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).rejects.toMatchObject({
      code: 'github.log_unavailable',
    })
  })

  it('falls back to the run log when the address names a run', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        input.includes('/check-runs/7')
          ? json({ details_url: 'https://github.com/o/r/actions/runs/55' })
          : new Response('plain log text', { status: 200 }),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).resolves.toEqual({
      text: 'plain log text',
      truncated: false,
    })
  })

  it('reports a log body that cannot be read', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        input.includes('/check-runs/7')
          ? json({ details_url: 'https://github.com/o/r/actions/runs/55/job/99' })
          : ({ ok: true, arrayBuffer: () => Promise.reject('boom') } as unknown as Response),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).rejects.toMatchObject({
      code: 'github.log_unavailable',
    })
  })

  it('falls back to the global fetch without an injected client', async () => {
    const stub = vi.fn(async (input: string) =>
      input.endsWith('/pulls/12')
        ? json({
            title: 'Fix',
            html_url: 'https://github.com/o/r/pull/12',
            state: 'open',
            head: { ref: 'fix', sha: 'abcdef1234567890' },
            base: { ref: 'main' },
          })
        : json({ check_runs: [] }),
    )
    vi.stubGlobal('fetch', stub)
    try {
      const service = createGithubService({ resolveToken: tokenResolver('token') })
      const pull = await service.pullRequest({ repo: 'o/r', number: 12 })
      expect(pull.title).toBe('Fix')
      expect(stub).toHaveBeenCalledWith(
        'https://api.github.com/repos/o/r/pulls/12',
        expect.any(Object),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a network failure that is not an Error', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: () => Promise.reject('offline'),
    })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.network',
    })
  })

  it('rejects a pull request without the needed fields', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async () => json({ title: '', html_url: 'x', head: {}, base: {} }),
    })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.invalid_response',
    })
  })

  it('maps a closed draft without mergeable state or checks', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        input.endsWith('/pulls/12')
          ? json({
              title: 'Old thing',
              html_url: 'https://github.com/o/r/pull/12',
              state: 'closed',
              draft: true,
              head: { ref: 'fix', sha: 'abcdef1234567890' },
              base: { ref: 'main' },
            })
          : json({}),
    })
    const pull = await service.pullRequest({ repo: 'o/r', number: 12 })
    expect(pull).toMatchObject({ state: 'closed', draft: true, checks: [] })
    expect(pull.mergeableState).toBeUndefined()
  })

  it('drops checks with unknown conclusions or unusable fields', async () => {
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl: async (input) =>
        input.endsWith('/pulls/12')
          ? json({
              title: 'Fix',
              html_url: 'https://github.com/o/r/pull/12',
              state: 'open',
              head: { ref: 'fix', sha: 'abcdef1234567890' },
              base: { ref: 'main' },
            })
          : json({
              check_runs: [
                { id: 'x', name: 'bad id', status: 'completed' },
                { id: 5, name: '', status: 'completed' },
                {
                  id: 7,
                  name: 'odd',
                  status: 'completed',
                  conclusion: 'weird',
                  started_at: 'not-a-date',
                },
                { id: 6, name: 'running', status: 'in_progress' },
              ],
            }),
    })
    const pull = await service.pullRequest({ repo: 'o/r', number: 12 })
    expect(pull.checks.map((check) => check.name)).toEqual(['odd', 'running'])
    expect(pull.checks[0]).toEqual({ id: 7, name: 'odd', status: 'completed' })
  })
})

describe('github API base for tests (M8-05)', () => {
  it('accepts HTTPS and loopback HTTP only', () => {
    expect(normalizeGithubApiBase('https://github.example.com/')).toBe('https://github.example.com')
    expect(normalizeGithubApiBase('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321')
    expect(normalizeGithubApiBase('http://localhost:4321')).toBe('http://localhost:4321')
    expect(normalizeGithubApiBase('http://github.example.com')).toBeUndefined()
    expect(normalizeGithubApiBase('https://u:p@github.example.com')).toBeUndefined()
    expect(normalizeGithubApiBase('not a url')).toBeUndefined()
    expect(normalizeGithubApiBase('  ')).toBeUndefined()
  })

  it('routes API calls to the configured base', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      input.endsWith('/pulls/1')
        ? json({
            title: 'Fix',
            html_url: 'https://github.com/o/r/pull/1',
            state: 'open',
            head: { ref: 'fix', sha: 'abcdef1234567890' },
            base: { ref: 'main' },
          })
        : json({ check_runs: [] }),
    )
    const service = createGithubService({
      resolveToken: tokenResolver('token'),
      fetchImpl,
      apiBase: 'http://127.0.0.1:4321/',
    })
    await service.pullRequest({ repo: 'o/r', number: 1 })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/repos/o/r/pulls/1',
      expect.objectContaining({ headers: expect.anything() }),
    )
  })
})
