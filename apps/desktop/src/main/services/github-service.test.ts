import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_CREDENTIAL_REF, GITHUB_LOG_MAX_CHARS, RpcError } from '@cairn/protocol'
import { createGithubService, type FetchLike, type GithubCredentials } from './github-service.js'

function memoryCredentials(
  initial?: string,
): GithubCredentials & { current(): string | undefined } {
  const keys = new Map<string, string>(
    initial === undefined ? [] : [[GITHUB_CREDENTIAL_REF, initial]],
  )
  return {
    async resolve(ref) {
      const key = keys.get(ref)
      return key === undefined ? undefined : { apiKey: key }
    },
    async set(ref, secret) {
      keys.set(ref, secret)
    },
    async delete(ref) {
      return keys.delete(ref)
    },
    has(ref) {
      return keys.has(ref)
    },
    current: () => keys.get(GITHUB_CREDENTIAL_REF),
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const user = { login: 'mrqin' }

describe('github-service', () => {
  it('reports disconnected when no token is saved', async () => {
    const service = createGithubService({ credentials: memoryCredentials() })
    expect(await service.status()).toEqual({ connected: false })
  })

  it('validates then saves a token, and reports it as connected', async () => {
    const credentials = memoryCredentials()
    const fetchImpl = vi.fn<FetchLike>(async () => json(user))
    const service = createGithubService({ credentials, fetchImpl })
    expect(await service.connect({ token: ' ghp_example ' })).toEqual({
      connected: true,
      login: 'mrqin',
    })
    expect(credentials.current()).toBe('ghp_example')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer ghp_example' }),
      }),
    )
    expect(await service.status()).toMatchObject({ connected: true, login: 'mrqin' })
  })

  it('does not overwrite the saved token when validation fails', async () => {
    const credentials = memoryCredentials('old-token')
    const service = createGithubService({
      credentials,
      fetchImpl: async () => json({ message: 'Bad credentials' }, 401),
    })
    await expect(service.connect({ token: 'new-token' })).rejects.toMatchObject({
      code: 'github.auth_failed',
    })
    expect(credentials.current()).toBe('old-token')
  })

  it('keeps the connection when the token cannot be checked offline', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    expect(await service.status()).toEqual({ connected: true })
  })

  it('disconnects and deletes the token', async () => {
    const credentials = memoryCredentials('token')
    const service = createGithubService({
      credentials,
      fetchImpl: async () => json(user),
    })
    expect(await service.disconnect()).toEqual({ connected: false })
    expect(credentials.current()).toBeUndefined()
  })

  it('maps a pull request and sorts its checks', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: async (input) => {
        if (input.endsWith('/pulls/12')) {
          return json({
            title: 'Fix the thing',
            html_url: 'https://github.com/o/r/pull/12',
            state: 'open',
            draft: false,
            head: { ref: 'fix', sha: 'abcdef1234567890' },
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
      baseRef: 'main',
      mergeableState: 'dirty',
    })
    expect(pull.checks.map((check) => check.name)).toEqual(['lint', 'test'])
    expect(pull.checks[0]).toMatchObject({ conclusion: 'success', startedAt: expect.any(Number) })
  })

  it('maps GitHub errors to stable codes', async () => {
    const failing = (status: number, headers: Record<string, string> = {}) =>
      createGithubService({
        credentials: memoryCredentials('token'),
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
        credentials: memoryCredentials('token'),
        fetchImpl: async () => {
          throw new Error('offline')
        },
      }).pullRequest({ repo: 'o/r', number: 1 }),
    ).rejects.toMatchObject({ code: 'github.network' })
  })

  it('requires a token for reads', async () => {
    const service = createGithubService({ credentials: memoryCredentials() })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toBeInstanceOf(RpcError)
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.not_connected',
    })
  })

  it('unzips the job log and keeps the end when it is too long', async () => {
    const log = `${'x'.repeat(200)}FAILED at the end`
    const archive = zipSync({ 'job.txt': strToU8(log) })
    const service = createGithubService({
      credentials: memoryCredentials('token'),
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
      credentials: memoryCredentials('token'),
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
      credentials: memoryCredentials('token'),
      fetchImpl: async () => json({ id: 7, details_url: 'https://example.com/nothing' }),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).rejects.toMatchObject({
      code: 'github.log_unavailable',
    })
  })

  it('reports a check run that has no address at all', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: async () => json({ id: 7 }),
    })
    await expect(service.checkLog({ repo: 'o/r', checkRunId: 7 })).rejects.toMatchObject({
      code: 'github.log_unavailable',
    })
  })

  it('falls back to the run log when the address names a run', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
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
      credentials: memoryCredentials('token'),
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
    const stub = vi.fn(async () => json(user))
    vi.stubGlobal('fetch', stub)
    try {
      const service = createGithubService({ credentials: memoryCredentials('token') })
      expect(await service.status()).toEqual({ connected: true, login: 'mrqin' })
      expect(stub).toHaveBeenCalledWith('https://api.github.com/user', expect.any(Object))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a saved connection whose profile has no login', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: async () => json({}),
    })
    expect(await service.status()).toEqual({ connected: true })
  })

  it('rejects a connection whose profile has no login', async () => {
    const service = createGithubService({
      credentials: memoryCredentials(),
      fetchImpl: async () => json({}),
    })
    await expect(service.connect({ token: 'token' })).rejects.toMatchObject({
      code: 'github.invalid_response',
    })
  })

  it('reports a network failure that is not an Error', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: () => Promise.reject('offline'),
    })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.network',
    })
  })

  it('rejects a pull request without the needed fields', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
      fetchImpl: async () => json({ title: '', html_url: 'x', head: {}, base: {} }),
    })
    await expect(service.pullRequest({ repo: 'o/r', number: 1 })).rejects.toMatchObject({
      code: 'github.invalid_response',
    })
  })

  it('maps a closed draft without mergeable state or checks', async () => {
    const service = createGithubService({
      credentials: memoryCredentials('token'),
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
      credentials: memoryCredentials('token'),
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
