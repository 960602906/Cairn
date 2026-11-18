import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError, type GithubPullRequest } from '@cairn/protocol'
import type { GitResult, GitRunner } from '@cairn/checkpoint'
import { createMemoryStorage, type Storage } from '@cairn/storage'
import {
  createAutoFixService,
  repairBrief,
  repairTrigger,
  type AutoFixService,
} from './auto-fix-service.js'
import { createSessionEventService } from './event-service.js'
import type { GithubService } from './github-service.js'
import type { SessionManager } from './session-manager.js'

const PULL: GithubPullRequest = {
  repo: 'o/r',
  number: 12,
  title: 'Fix the thing',
  url: 'https://github.com/o/r/pull/12',
  state: 'open',
  draft: false,
  headRef: 'fix',
  headSha: 'abcdef1234567890',
  baseRef: 'main',
  checks: [
    { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'lint', status: 'completed', conclusion: 'success' },
  ],
}

const projectPath = join(tmpdir(), 'cairn-auto-fix-project')

let root: string
let storage: Storage
let events: ReturnType<typeof createSessionEventService>
let prompt: ReturnType<typeof vi.fn>
let gitRun: ReturnType<typeof vi.fn>
let pulls: ReturnType<typeof vi.fn>
let logs: ReturnType<typeof vi.fn>
let errors: unknown[]
let clock: number

function gitResult(code = 0, stderr = ''): GitResult {
  return { code, stdout: Buffer.from(''), stderr }
}

function setup(overrides: { pull?: GithubPullRequest } = {}) {
  clock = 1_000
  storage = createMemoryStorage({ now: () => clock })
  events = createSessionEventService({ storage })
  prompt = vi.fn(() => ({ messageId: 'm1' }))
  gitRun = vi.fn(async () => gitResult())
  pulls = vi.fn(async () => overrides.pull ?? PULL)
  logs = vi.fn(async () => ({ text: 'TypeError: boom', truncated: false }))
  errors = []
  const git = { binary: 'git', run: gitRun } as unknown as GitRunner
  const github = {
    pullRequest: pulls,
    checkLog: logs,
  } as unknown as Pick<GithubService, 'pullRequest' | 'checkLog'>
  const sessions = { prompt } as unknown as Pick<SessionManager, 'prompt'>
  const service = createAutoFixService({
    storage,
    events,
    github,
    sessions,
    git,
    worktreesRoot: root,
    now: () => clock,
    createId: (() => {
      let counter = 0
      return () => `id-${++counter}`
    })(),
    onError: (error) => errors.push(error),
  })
  return service
}

function addWatch(
  service: AutoFixService,
  input?: Partial<Parameters<AutoFixService['addWatch']>[0]>,
) {
  return service.addWatch({
    repo: 'o/r',
    prNumber: 12,
    projectPath,
    ...input,
  })
}

/** 直接写存储，避免 `addWatch` 附带的异步轮询干扰断言。 */
function seedWatch(
  service: AutoFixService,
  patch: { attempts?: number; maxAttempts?: number } = {},
) {
  storage.autoFix.watches.create({
    watchId: 'w1',
    repo: 'o/r',
    prNumber: 12,
    projectPath,
    triggers: ['ci', 'conflict'],
    maxAttempts: patch.maxAttempts ?? 3,
  })
  if (patch.attempts !== undefined) {
    storage.autoFix.watches.update('w1', { attempts: patch.attempts })
  }
  return service
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cairn-autofix-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('repairTrigger', () => {
  it('signs a CI failure with the head commit and sorted check names', () => {
    const pull = {
      ...PULL,
      checks: [
        { id: 3, name: 'zeta', status: 'completed', conclusion: 'timed_out' as const },
        { id: 2, name: 'alpha', status: 'completed', conclusion: 'failure' as const },
        { id: 4, name: 'ok', status: 'completed', conclusion: 'success' as const },
        { id: 5, name: 'skipped', status: 'completed', conclusion: 'skipped' as const },
      ],
    }
    expect(repairTrigger(pull, ['ci'])).toEqual({
      trigger: 'ci',
      signature: 'abcdef1234567890:alpha,zeta',
      failed: ['alpha', 'zeta'],
    })
  })

  it('uses the head commit for a merge conflict and ignores disabled triggers', () => {
    const dirty = { ...PULL, mergeableState: 'dirty', checks: [] }
    expect(repairTrigger(dirty, ['conflict'])).toEqual({
      trigger: 'conflict',
      signature: 'abcdef1234567890',
      failed: [],
    })
    expect(repairTrigger(dirty, ['ci'])).toBeUndefined()
    expect(repairTrigger(PULL, ['conflict'])).toBeUndefined()
  })

  it('does not treat running or neutral checks as failures', () => {
    const pull = {
      ...PULL,
      checks: [
        { id: 1, name: 'running', status: 'in_progress' },
        { id: 2, name: 'neutral', status: 'completed', conclusion: 'neutral' as const },
      ],
    }
    expect(repairTrigger(pull, ['ci'])).toBeUndefined()
  })
})

describe('repairBrief', () => {
  it('states the boundaries and includes the failing log', () => {
    const brief = repairBrief({
      pull: PULL,
      trigger: 'ci',
      failed: ['test'],
      worktree: '/tmp/pr-w1',
      log: 'boom',
    })
    expect(brief).toContain('PR：o/r#12 Fix the thing')
    expect(brief).toContain('失败的检查：test')
    expect(brief).toContain('/tmp/pr-w1')
    expect(brief).toContain('不要提交、不要推送')
    expect(brief).toContain('boom')
  })
})

describe('auto-fix service', () => {
  it('adds a watched pull request and lists it', () => {
    const service = setup()
    const status = addWatch(service)
    expect(status.watches).toHaveLength(1)
    expect(status.watches[0]).toMatchObject({
      repo: 'o/r',
      prNumber: 12,
      enabled: true,
      triggers: ['ci', 'conflict'],
      maxAttempts: 3,
    })
    expect(service.status().paused).toBe(false)
  })

  it('rejects a duplicate watch and more than the limit', () => {
    const service = setup()
    addWatch(service)
    expect(() => addWatch(service)).toThrow(RpcError)
    for (let index = 0; index < 20; index += 1) {
      storage.autoFix.watches.create({
        watchId: `w-${index}`,
        repo: `o/r${index}`,
        prNumber: 1,
        projectPath,
        triggers: ['ci'],
        maxAttempts: 3,
      })
    }
    expect(() => addWatch(service, { repo: 'o/other' })).toThrow(/autofix.too_many/)
  })

  it('opens an auto-fix session in a worktree when CI fails', async () => {
    const service = seedWatch(setup())
    await service.poll()

    const watch = storage.autoFix.watches.get('w1')!
    expect(watch.attempts).toBe(1)
    expect(watch.lastSignature).toBe('abcdef1234567890:test')
    const jobs = storage.autoFix.jobs.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ trigger: 'ci', status: 'running', attempt: 1 })
    expect(jobs[0]!.sessionId).toBe('id-3')

    const session = storage.sessions.get('id-3')!
    expect(session).toMatchObject({ kind: 'auto-fix', title: '自动修复 o/r#12' })
    expect(session.workspacePath).toBe(join(root, 'pr-w1'))
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'id-3',
        content: [
          expect.objectContaining({ type: 'text', text: expect.stringContaining('不提交') }),
        ],
      }),
    )
    expect(logs).toHaveBeenCalledWith({ repo: 'o/r', checkRunId: 1 })
    // 工作区目录由 git worktree add 创建，这里断言调用参数而不依赖真实 Git。
    expect(gitRun).toHaveBeenCalledWith(
      expect.arrayContaining(['worktree', 'add', '--detach', join(root, 'pr-w1')]),
      { allowFail: true },
    )
  })

  it('does not repair the same head commit twice', async () => {
    const service = seedWatch(setup())
    await service.poll()
    await service.poll()
    expect(storage.autoFix.jobs.list()).toHaveLength(1)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('triggers on a merge conflict and records the head commit', async () => {
    const service = seedWatch(setup({ pull: { ...PULL, checks: [], mergeableState: 'dirty' } }))
    await service.poll()
    const job = storage.autoFix.jobs.list()[0]!
    expect(job).toMatchObject({ trigger: 'conflict', signature: 'abcdef1234567890' })
  })

  it('gives up and disables the watch once attempts are exhausted', async () => {
    const service = seedWatch(setup(), { attempts: 3, maxAttempts: 3 })
    await service.poll()
    expect(prompt).not.toHaveBeenCalled()
    expect(storage.autoFix.watches.get('w1')!.enabled).toBe(false)
    expect(storage.autoFix.jobs.list()[0]).toMatchObject({
      status: 'gave_up',
      trigger: 'ci',
      attempt: 3,
    })
  })

  it('disables a watch whose pull request was closed', async () => {
    const service = seedWatch(setup({ pull: { ...PULL, state: 'closed' } }))
    await service.poll()
    expect(storage.autoFix.watches.get('w1')!.enabled).toBe(false)
    expect(storage.autoFix.jobs.list()).toEqual([])
  })

  it('marks the job ready when the repair run completes', async () => {
    const service = seedWatch(setup())
    await service.poll()
    const job = storage.autoFix.jobs.list()[0]!
    events.publish([
      {
        v: 1,
        sessionId: job.sessionId!,
        runId: job.sessionId!,
        ts: clock,
        type: 'turn.completed',
        payload: { durationMs: 5 },
      },
    ])
    expect(storage.autoFix.jobs.get(job.jobId)!.status).toBe('ready')
  })

  it('marks the job failed when the run fails or the session crashes', async () => {
    const service = seedWatch(setup())
    await service.poll()
    const first = storage.autoFix.jobs.list()[0]!
    events.publish([
      {
        v: 1,
        sessionId: first.sessionId!,
        runId: first.sessionId!,
        ts: clock,
        type: 'turn.aborted',
        payload: { reason: 'user' },
      },
    ])
    expect(storage.autoFix.jobs.get(first.jobId)!.status).toBe('failed')
  })

  it('reports a worktree failure without leaking remote credentials', async () => {
    const service = seedWatch(setup())
    const remote = ['https://user:', 'hunter2', '@host/repo'].join('')
    gitRun.mockResolvedValueOnce(gitResult(1, `fatal: ${remote} not found`))
    await service.poll()
    const job = storage.autoFix.jobs.list()[0]!
    expect(job.status).toBe('failed')
    expect(job.detail).toContain('***@')
    expect(job.detail).not.toContain('hunter2')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('keeps polling after a GitHub error and reports it', async () => {
    const service = seedWatch(setup())
    pulls.mockRejectedValueOnce(new RpcError('github.network'))
    await service.poll()
    expect(errors).toHaveLength(1)
    expect(storage.autoFix.jobs.list()).toEqual([])
    await service.poll()
    expect(storage.autoFix.jobs.list()).toHaveLength(1)
  })

  it('skips evaluation while paused and resumes after unpausing', async () => {
    const service = seedWatch(setup())
    service.setPaused({ paused: true })
    await service.poll()
    expect(storage.autoFix.jobs.list()).toEqual([])
    service.setPaused({ paused: false })
    await service.poll()
    expect(storage.autoFix.jobs.list()).toHaveLength(1)
  })

  it('re-enables a watch and re-evaluates the same commit', async () => {
    const service = seedWatch(setup())
    service.updateWatch({ watchId: 'w1', enabled: false })
    service.updateWatch({ watchId: 'w1', enabled: true })
    expect(storage.autoFix.watches.get('w1')!.lastSignature).toBeUndefined()
  })

  it('removes the watch, its jobs and its worktree', async () => {
    const service = seedWatch(setup())
    await service.poll()
    mkdirSync(join(root, 'pr-w1'), { recursive: true })
    await service.removeWatch({ watchId: 'w1' })
    expect(storage.autoFix.watches.list()).toEqual([])
    expect(storage.autoFix.jobs.list()).toEqual([])
    expect(gitRun).toHaveBeenCalledWith(
      ['-C', projectPath, 'worktree', 'remove', '--force', join(root, 'pr-w1')],
      { allowFail: true },
    )
  })

  it('marks jobs left running by the previous process as failed on start', () => {
    const service = seedWatch(setup())
    storage.autoFix.jobs.create({
      jobId: 'old-job',
      watchId: 'w1',
      trigger: 'ci',
      signature: 'abcdef1234567890:test',
      status: 'running',
      attempt: 1,
    })
    service.start()
    service.stop()
    expect(storage.autoFix.jobs.get('old-job')!.status).toBe('failed')
    expect(storage.autoFix.jobs.get('old-job')!.detail).toBe('interrupted')
  })

  it('notifies subscribers when watches or jobs change', async () => {
    const service = seedWatch(setup())
    const listener = vi.fn()
    const off = service.subscribe(listener)
    await service.poll()
    expect(listener).toHaveBeenCalled()
    off()
    listener.mockClear()
    service.setPaused({ paused: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('only refreshes the timestamp when nothing needs repair', async () => {
    const service = seedWatch(
      setup({
        pull: {
          ...PULL,
          checks: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }],
        },
      }),
    )
    await service.poll()
    expect(storage.autoFix.jobs.list()).toEqual([])
    expect(storage.autoFix.watches.get('w1')!.lastEvaluatedAt).toBe(clock)
  })

  it('marks jobs failed when a run fails or the session crashes', async () => {
    const service = seedWatch(setup())
    storage.autoFix.watches.create({
      watchId: 'w2',
      repo: 'o/r',
      prNumber: 13,
      projectPath,
      triggers: ['ci'],
      maxAttempts: 3,
    })
    await service.poll()
    const failed = storage.autoFix.jobs.list().find((job) => job.watchId === 'w1')!
    const crashed = storage.autoFix.jobs.list().find((job) => job.watchId === 'w2')!
    events.publish([
      {
        v: 1,
        sessionId: failed.sessionId!,
        runId: failed.sessionId!,
        ts: clock,
        type: 'turn.failed',
        payload: { error: { code: 'run.internal_error' }, retryable: true },
      },
    ])
    events.publish([
      {
        v: 1,
        sessionId: crashed.sessionId!,
        runId: crashed.sessionId!,
        ts: clock,
        type: 'session.crashed',
        payload: { error: { code: 'host.crashed' } },
      },
    ])
    expect(storage.autoFix.jobs.get(failed.jobId)!.status).toBe('failed')
    expect(storage.autoFix.jobs.get(crashed.jobId)).toMatchObject({
      status: 'failed',
      detail: '修复会话异常退出',
    })
  })

  it('ignores completion events for finished or removed jobs', async () => {
    const service = seedWatch(setup())
    await service.poll()
    const job = storage.autoFix.jobs.list()[0]!
    storage.autoFix.jobs.update(job.jobId, { status: 'ready' })
    const completed = [
      {
        v: 1 as const,
        sessionId: job.sessionId!,
        runId: job.sessionId!,
        ts: clock,
        type: 'turn.completed' as const,
        payload: { durationMs: 1 },
      },
    ]
    events.publish(completed)
    expect(storage.autoFix.jobs.get(job.jobId)!.status).toBe('ready')
    await service.removeWatch({ watchId: 'w1' })
    events.publish(completed)
    expect(storage.autoFix.jobs.list()).toEqual([])
  })

  it('reuses an existing worktree and resets it to the head commit', async () => {
    const service = seedWatch(setup())
    mkdirSync(join(root, 'pr-w1'), { recursive: true })
    await service.poll()
    expect(gitRun).toHaveBeenCalledWith(
      ['-C', join(root, 'pr-w1'), 'reset', '--hard', 'abcdef1234567890'],
      { allowFail: true },
    )
    expect(storage.autoFix.jobs.list()[0]!.status).toBe('running')
  })

  it('fails the job when the commit is missing or the worktree cannot be prepared', async () => {
    const missing = seedWatch(setup())
    gitRun.mockResolvedValueOnce(gitResult()).mockResolvedValueOnce(gitResult(1, 'not found'))
    await missing.poll()
    const missingJob = storage.autoFix.jobs.list()[0]!
    expect(missingJob.status).toBe('failed')
    expect(missingJob.detail).toContain('找不到')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('fails the job when the existing worktree cannot be reset', async () => {
    const service = seedWatch(setup())
    mkdirSync(join(root, 'pr-w1'), { recursive: true })
    gitRun
      .mockResolvedValueOnce(gitResult())
      .mockResolvedValueOnce(gitResult())
      .mockResolvedValueOnce(gitResult(1, 'reset failed'))
    await service.poll()
    expect(storage.autoFix.jobs.list()[0]!.detail).toContain('重置监视工作区失败')
  })

  it('fails the job when the worktree cannot be created', async () => {
    const service = seedWatch(setup())
    gitRun
      .mockResolvedValueOnce(gitResult())
      .mockResolvedValueOnce(gitResult())
      .mockResolvedValueOnce(gitResult(1, 'add failed'))
    await service.poll()
    expect(storage.autoFix.jobs.list()[0]!.detail).toContain('创建监视工作区失败')
  })

  it('reports a non-Error failure as text', async () => {
    const service = seedWatch(setup())
    gitRun.mockRejectedValueOnce('plain failure')
    await service.poll()
    expect(storage.autoFix.jobs.list()[0]!.detail).toBe('plain failure')
  })

  it('starts the repair even when the failure log cannot be read', async () => {
    const service = seedWatch(setup())
    logs.mockRejectedValueOnce(new RpcError('github.log_unavailable'))
    await service.poll()
    expect(errors).toHaveLength(1)
    expect(storage.autoFix.jobs.list()[0]!.status).toBe('running')
    const brief = (prompt.mock.calls[0]![0] as { content: [{ text: string }] }).content[0].text
    expect(brief).not.toContain('```')
  })

  it('reports an error thrown by a subscriber', async () => {
    const service = seedWatch(setup())
    service.subscribe(() => {
      throw new Error('listener failed')
    })
    await service.poll()
    expect(errors.length).toBeGreaterThan(0)
    expect(storage.autoFix.jobs.list()[0]!.status).toBe('running')
  })

  it('updates triggers and attempts without re-enabling the watch', () => {
    const service = seedWatch(setup())
    const status = service.updateWatch({ watchId: 'w1', triggers: ['ci'], maxAttempts: 5 })
    expect(status.watches[0]).toMatchObject({ triggers: ['ci'], maxAttempts: 5, enabled: true })
  })

  it('rejects removing an unknown watch', async () => {
    const service = seedWatch(setup())
    await expect(service.removeWatch({ watchId: 'missing' })).rejects.toThrow(/storage.not_found/)
  })

  it('prunes the worktree list when removal fails', async () => {
    const service = seedWatch(setup())
    mkdirSync(join(root, 'pr-w1'), { recursive: true })
    gitRun.mockResolvedValueOnce(gitResult(1, 'locked'))
    await service.removeWatch({ watchId: 'w1' })
    expect(gitRun).toHaveBeenCalledWith(['-C', projectPath, 'worktree', 'prune'], {
      allowFail: true,
    })
  })

  it('skips disabled watches and stops evaluating mid-poll', async () => {
    const service = seedWatch(setup())
    storage.autoFix.watches.create({
      watchId: 'off',
      repo: 'o/r',
      prNumber: 1,
      projectPath,
      triggers: ['ci'],
      maxAttempts: 3,
    })
    storage.autoFix.watches.update('off', { enabled: false })
    storage.autoFix.watches.create({
      watchId: 'w2',
      repo: 'o/r',
      prNumber: 2,
      projectPath,
      triggers: ['ci'],
      maxAttempts: 3,
    })
    pulls.mockImplementationOnce(async () => {
      service.stop()
      return {
        ...PULL,
        checks: [{ id: 9, name: 'ok', status: 'completed', conclusion: 'success' }],
      }
    })
    await service.poll()
    expect(pulls).toHaveBeenCalledTimes(1)
    expect(storage.autoFix.jobs.list()).toEqual([])
  })

  it('names a project after the repository when the path has no base name', async () => {
    const service = setup()
    storage.autoFix.watches.create({
      watchId: 'w1',
      repo: 'o/r',
      prNumber: 12,
      projectPath: '/',
      triggers: ['ci'],
      maxAttempts: 3,
    })
    await service.poll()
    expect(storage.projects.list().find((project) => project.path === '/')?.name).toBe('o/r')
  })

  it('keeps polling when no error reporter is configured', async () => {
    storage = createMemoryStorage()
    events = createSessionEventService({ storage })
    pulls = vi.fn(async () => {
      throw new RpcError('github.network')
    })
    const github = {
      pullRequest: pulls,
      checkLog: vi.fn(),
    } as unknown as Pick<GithubService, 'pullRequest' | 'checkLog'>
    const sessions = { prompt: vi.fn() } as unknown as Pick<SessionManager, 'prompt'>
    const git = { binary: 'git', run: vi.fn(async () => gitResult()) } as unknown as GitRunner
    const service = createAutoFixService({
      storage,
      events,
      github,
      sessions,
      git,
      worktreesRoot: root,
    })
    storage.autoFix.watches.create({
      watchId: 'w1',
      repo: 'o/r',
      prNumber: 12,
      projectPath,
      triggers: ['ci'],
      maxAttempts: 3,
    })
    await expect(service.poll()).resolves.toBeUndefined()
    expect(storage.autoFix.jobs.list()).toEqual([])
  })

  it('uses the default interval, clock and ids', async () => {
    vi.useFakeTimers()
    try {
      storage = createMemoryStorage()
      events = createSessionEventService({ storage })
      pulls = vi.fn(async () => PULL)
      logs = vi.fn(async () => ({ text: '', truncated: false }))
      prompt = vi.fn(() => ({ messageId: 'm1' }))
      const git = {
        binary: 'git',
        run: vi.fn(async () => gitResult()),
      } as unknown as GitRunner
      const github = {
        pullRequest: pulls,
        checkLog: logs,
      } as unknown as Pick<GithubService, 'pullRequest' | 'checkLog'>
      const sessions = { prompt } as unknown as Pick<SessionManager, 'prompt'>
      const service = createAutoFixService({
        storage,
        events,
        github,
        sessions,
        git,
        worktreesRoot: root,
      })
      storage.autoFix.watches.create({
        watchId: 'w1',
        repo: 'o/r',
        prNumber: 12,
        projectPath,
        triggers: ['ci'],
        maxAttempts: 3,
      })
      service.start()
      service.start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(storage.autoFix.jobs.list()).toHaveLength(1)
      expect(storage.autoFix.watches.get('w1')!.lastEvaluatedAt).toBeTypeOf('number')
      service.stop()
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
