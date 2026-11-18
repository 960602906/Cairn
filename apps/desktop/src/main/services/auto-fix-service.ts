/**
 * 自动修复的监视与触发（M8-02）。
 *
 * - 轮询而不是 Webhook（桌面应用没有稳定公网入口）：每个启用的监视按固定间隔读取一次 PR；
 * - 去重签名（`headSha + 失败检查名` / `headSha`）：同一份提交只修一次，推送或改了检查才进入下一轮；
 * - 每个监视一个独立 worktree（`<worktrees>/pr-<watchId>`），每次修复前重置到 PR 的 head 提交，
 *   不碰用户自己的工作目录；
 * - 修复会话 `kind = 'auto-fix'`，以无人值守方式运行（ADR-0018），完成后把状态记为 `ready`；
 * - **M8-02 不提交、不推送**：改动留在监视工作区，由用户检查后手动处理；
 * - 达到尝试上限时关闭监视并记录 `gave_up`，等待人工介入。
 *
 * 不依赖 Electron：Git、GitHub、会话与时间来源都由调用方注入。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AUTO_FIX_DEFAULT_ATTEMPTS,
  AUTO_FIX_MAX_WATCHES,
  RpcError,
  type AutoFixJob,
  type AutoFixStatus,
  type AutoFixTrigger,
  type GithubPullRequest,
} from '@cairn/protocol'
import type { GitRunner } from '@cairn/checkpoint'
import type { PullRequestWatchRecord, Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'
import type { GithubService } from './github-service.js'
import type { SessionManager } from './session-manager.js'

/** 视为需要修复的检查结论。`neutral` / `skipped` 不算失败。 */
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required'])

/** 签名与说明的长度上限；失败检查可能有几百项，签名只需足以区分。 */
const SIGNATURE_MAX = 900
const DETAIL_MAX = 600
const LOG_TAIL = 4_000
const JOBS_IN_STATUS = 20

export const AutoFixErrorCode = {
  Duplicate: 'autofix.duplicate',
  TooMany: 'autofix.too_many',
} as const

export interface AutoFixServiceOptions {
  readonly storage: Pick<Storage, 'autoFix' | 'sessions' | 'projects'>
  readonly events: Pick<SessionEventService, 'publish' | 'subscribe'>
  /** 只用到 PR 快照与失败日志。 */
  readonly github: Pick<GithubService, 'pullRequest' | 'checkLog'>
  readonly sessions: Pick<SessionManager, 'prompt'>
  readonly git: GitRunner
  /** `<userData>/worktrees`。 */
  readonly worktreesRoot: string
  /** 轮询间隔，默认 60 秒。 */
  readonly intervalMs?: number
  readonly now?: () => number
  readonly createId?: () => string
  readonly onError?: (error: unknown) => void
}

export interface AutoFixCommands {
  status(): AutoFixStatus
  addWatch(input: {
    repo: string
    prNumber: number
    projectPath: string
    triggers?: AutoFixTrigger[] | undefined
    maxAttempts?: number | undefined
  }): AutoFixStatus
  updateWatch(input: {
    watchId: string
    enabled?: boolean | undefined
    triggers?: AutoFixTrigger[] | undefined
    maxAttempts?: number | undefined
  }): AutoFixStatus
  removeWatch(input: { watchId: string }): Promise<AutoFixStatus>
  setPaused(input: { paused: boolean }): AutoFixStatus
}

export interface AutoFixService extends AutoFixCommands {
  /** 启动轮询并清理上次遗留的任务。 */
  start(): void
  stop(): void
  /** 立即评估一轮；已在评估时直接返回。 */
  poll(): Promise<void>
  /** 监视或任务变化时通知（网关据此推送 `autofix.changed`）。 */
  subscribe(listener: () => void): () => void
}

/** 需要修复时的触发项与去重签名；不需要时返回 undefined。 */
export function repairTrigger(
  pull: GithubPullRequest,
  triggers: readonly AutoFixTrigger[],
): { trigger: AutoFixTrigger; signature: string; failed: string[] } | undefined {
  const failed = pull.checks
    .filter(
      (check) =>
        check.status === 'completed' &&
        check.conclusion !== undefined &&
        FAILED_CONCLUSIONS.has(check.conclusion),
    )
    .map((check) => check.name)
    .sort()
  if (triggers.includes('ci') && failed.length > 0) {
    return {
      trigger: 'ci',
      signature: `${pull.headSha}:${failed.join(',')}`.slice(0, SIGNATURE_MAX),
      failed,
    }
  }
  if (triggers.includes('conflict') && pull.mergeableState === 'dirty') {
    return { trigger: 'conflict', signature: pull.headSha, failed: [] }
  }
  return undefined
}

/** 修复会话的提示：说明范围与禁区，避免它在 M8-02 里提交或推送。 */
export function repairBrief(input: {
  pull: GithubPullRequest
  trigger: AutoFixTrigger
  failed: readonly string[]
  worktree: string
  log?: string | undefined
}): string {
  const { pull, trigger, failed, worktree, log } = input
  const lines = [
    '自动修复任务（只改代码，不提交、不推送）',
    '',
    `PR：${pull.repo}#${pull.number} ${pull.title}`,
    `地址：${pull.url}`,
    trigger === 'ci'
      ? `失败的检查：${failed.join('、')}`
      : `合并冲突：当前分支与 ${pull.baseRef} 存在冲突`,
    `本地工作区：${worktree}`,
    '',
    '请在这个工作区里：',
    '1. 先定位失败原因（失败日志见下）；',
    '2. 修改代码并运行相关检查；',
    '3. 不要提交、不要推送、不要切换或强制推送分支；',
    '4. 完成后说明改了什么、运行了哪些检查、结果如何。',
    '',
    '改动会留在工作区，由用户检查后手动提交与推送。',
  ]
  if (log !== undefined && log.trim() !== '') {
    lines.push('', '失败日志（末尾）：', '```', log, '```')
  }
  return lines.join('\n')
}

/** 监视工作区目录：只用随机的 watch id，避免路径逃逸。 */
const worktreeOf = (root: string, watchId: string): string => join(root, `pr-${watchId}`)

function errorDetail(error: unknown): string {
  // 远端地址里可能带用户名与密码；错误说明会显示在界面上，先把它们遮掉。
  const text = (error instanceof Error ? error.message : String(error)).replace(
    /\/\/[^/\s@]+@/g,
    '//***@',
  )
  return text.slice(0, DETAIL_MAX)
}

export function createAutoFixService(options: AutoFixServiceOptions): AutoFixService {
  const { storage, events, github, sessions, git } = options
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const intervalMs = options.intervalMs ?? 60_000
  const reportError = options.onError ?? (() => {})
  const listeners = new Set<() => void>()
  /** 正在修复的会话对应的任务；只在本进程内有效，重启后由 `interruptActive` 收尾。 */
  const jobsBySession = new Map<string, string>()
  let paused = false
  let polling = false
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        reportError(error)
      }
    }
  }

  const snapshot = (): AutoFixStatus => ({
    paused,
    watches: storage.autoFix.watches
      .list()
      .map((watch) => ({ ...watch, triggers: [...watch.triggers] })),
    jobs: storage.autoFix.jobs.list({ limit: JOBS_IN_STATUS }),
  })

  const finishJob = (jobId: string, status: AutoFixJob['status'], detail?: string) => {
    const job = storage.autoFix.jobs.get(jobId)
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return
    storage.autoFix.jobs.update(jobId, {
      status,
      ...(detail === undefined ? {} : { detail }),
    })
    if (job.sessionId !== undefined) jobsBySession.delete(job.sessionId)
    emit()
  }

  const unsubscribeEvents = events.subscribe((sessionId, batch) => {
    const jobId = jobsBySession.get(sessionId)
    if (jobId === undefined) return
    for (const event of batch) {
      if (event.type === 'turn.completed') {
        finishJob(jobId, 'ready')
        return
      }
      if (event.type === 'turn.failed' || event.type === 'turn.aborted') {
        finishJob(jobId, 'failed', '修复运行没有完成')
        return
      }
      if (event.type === 'session.crashed') {
        finishJob(jobId, 'failed', '修复会话异常退出')
        return
      }
    }
  })

  /** 把监视工作区重置到 PR 的 head 提交；位于用户仓库之外，可随时丢弃。 */
  const prepareWorktree = async (
    watch: PullRequestWatchRecord,
    headSha: string,
  ): Promise<string> => {
    const fetched = await git.run(['-C', watch.projectPath, 'fetch', '--no-tags', 'origin'], {
      allowFail: true,
    })
    if (fetched.code !== 0) {
      throw new Error(`git fetch 失败：${fetched.stderr.trim()}`)
    }
    const present = await git.run(
      ['-C', watch.projectPath, 'cat-file', '-e', `${headSha}^{commit}`],
      { allowFail: true },
    )
    if (present.code !== 0) throw new Error('fetch 之后仍然找不到 PR 的提交')
    const directory = worktreeOf(options.worktreesRoot, watch.watchId)
    if (existsSync(directory)) {
      const reset = await git.run(['-C', directory, 'reset', '--hard', headSha], {
        allowFail: true,
      })
      if (reset.code !== 0) throw new Error(`重置监视工作区失败：${reset.stderr.trim()}`)
      return directory
    }
    mkdirSync(options.worktreesRoot, { recursive: true })
    const added = await git.run(
      ['-C', watch.projectPath, 'worktree', 'add', '--detach', directory, headSha],
      { allowFail: true },
    )
    if (added.code !== 0) throw new Error(`创建监视工作区失败：${added.stderr.trim()}`)
    return directory
  }

  /** 取第一个失败检查的日志末尾，拼进修复提示；失败时不影响修复。 */
  const failureLog = async (watch: PullRequestWatchRecord, pull: GithubPullRequest) => {
    const check = pull.checks.find(
      (item) =>
        item.status === 'completed' &&
        item.conclusion !== undefined &&
        FAILED_CONCLUSIONS.has(item.conclusion),
    )
    if (check === undefined) return undefined
    try {
      const log = await github.checkLog({ repo: watch.repo, checkRunId: check.id })
      return log.text.slice(-LOG_TAIL)
    } catch (error) {
      reportError(error)
      return undefined
    }
  }

  const startRepair = async (
    watch: PullRequestWatchRecord,
    pull: GithubPullRequest,
    repair: { trigger: AutoFixTrigger; signature: string; failed: string[] },
  ) => {
    const jobId = createId()
    const attempt = watch.attempts + 1
    storage.autoFix.jobs.create({
      jobId,
      watchId: watch.watchId,
      trigger: repair.trigger,
      signature: repair.signature,
      status: 'queued',
      attempt,
    })
    // 先记下签名与次数：即使后面的准备失败，同一份提交也不会每 60 秒重试。
    storage.autoFix.watches.update(watch.watchId, {
      lastSignature: repair.signature,
      attempts: attempt,
      lastEvaluatedAt: now(),
    })
    emit()

    try {
      const worktree = await prepareWorktree(watch, pull.headSha)
      const project =
        storage.projects.getByPath(watch.projectPath) ??
        storage.projects.create({
          projectId: createId(),
          name: basename(watch.projectPath) || watch.repo,
          path: watch.projectPath,
        })
      const sessionId = createId()
      storage.sessions.create({
        sessionId,
        projectId: project.projectId,
        workspacePath: worktree,
        title: `自动修复 ${watch.repo}#${watch.prNumber}`,
        kind: 'auto-fix',
      })
      events.publish([
        {
          v: 1,
          sessionId,
          runId: sessionId,
          ts: now(),
          type: 'session.created',
          payload: {
            projectId: project.projectId,
            projectPath: project.path,
            workspacePath: worktree,
            title: `自动修复 ${watch.repo}#${watch.prNumber}`,
          },
        },
      ])
      storage.autoFix.jobs.update(jobId, { status: 'running', sessionId })
      jobsBySession.set(sessionId, jobId)
      const log = await failureLog(watch, pull)
      sessions.prompt({
        sessionId,
        content: [
          {
            type: 'text',
            text: repairBrief({
              pull,
              trigger: repair.trigger,
              failed: repair.failed,
              worktree,
              log,
            }),
          },
        ],
      })
      emit()
    } catch (error) {
      reportError(error)
      finishJob(jobId, 'failed', errorDetail(error))
    }
  }

  const evaluate = async (watch: PullRequestWatchRecord) => {
    if (storage.autoFix.jobs.activeForWatch(watch.watchId) !== undefined) return
    let pull: GithubPullRequest
    try {
      pull = await github.pullRequest({ repo: watch.repo, number: watch.prNumber })
    } catch (error) {
      reportError(error)
      return
    }
    if (pull.state === 'closed') {
      storage.autoFix.watches.update(watch.watchId, { enabled: false, lastEvaluatedAt: now() })
      emit()
      return
    }
    const repair = repairTrigger(pull, watch.triggers)
    if (repair === undefined || repair.signature === watch.lastSignature) {
      storage.autoFix.watches.update(watch.watchId, { lastEvaluatedAt: now() })
      return
    }
    if (watch.attempts >= watch.maxAttempts) {
      storage.autoFix.watches.update(watch.watchId, {
        enabled: false,
        lastSignature: repair.signature,
        lastEvaluatedAt: now(),
      })
      storage.autoFix.jobs.create({
        jobId: createId(),
        watchId: watch.watchId,
        trigger: repair.trigger,
        signature: repair.signature,
        status: 'gave_up',
        attempt: watch.attempts,
      })
      emit()
      return
    }
    await startRepair(watch, pull, repair)
  }

  const poll = async () => {
    if (stopped || paused || polling) return
    polling = true
    try {
      for (const watch of storage.autoFix.watches.list()) {
        if (!watch.enabled || stopped) continue
        try {
          await evaluate(watch)
        } catch (error) {
          reportError(error)
        }
      }
    } finally {
      polling = false
    }
  }

  /** 删除监视工作区；失败只记录，不影响监视本身的删除。 */
  const removeWorktree = async (watch: PullRequestWatchRecord) => {
    const directory = worktreeOf(options.worktreesRoot, watch.watchId)
    if (existsSync(directory)) {
      const removed = await git.run(
        ['-C', watch.projectPath, 'worktree', 'remove', '--force', directory],
        { allowFail: true },
      )
      if (removed.code !== 0) {
        await git.run(['-C', watch.projectPath, 'worktree', 'prune'], { allowFail: true })
      }
    }
  }

  return {
    status: snapshot,

    addWatch({ repo, prNumber, projectPath, triggers, maxAttempts }) {
      if (storage.autoFix.watches.findByPullRequest(repo, prNumber) !== undefined) {
        throw new RpcError(AutoFixErrorCode.Duplicate, { repo, prNumber })
      }
      if (storage.autoFix.watches.list().length >= AUTO_FIX_MAX_WATCHES) {
        throw new RpcError(AutoFixErrorCode.TooMany, { max: AUTO_FIX_MAX_WATCHES })
      }
      storage.autoFix.watches.create({
        watchId: createId(),
        repo,
        prNumber,
        projectPath,
        triggers: triggers ?? ['ci', 'conflict'],
        maxAttempts: maxAttempts ?? AUTO_FIX_DEFAULT_ATTEMPTS,
      })
      emit()
      void poll()
      return snapshot()
    },

    updateWatch({ watchId, enabled, triggers, maxAttempts }) {
      storage.autoFix.watches.update(watchId, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(triggers === undefined ? {} : { triggers }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        // 重新启用时允许同一份提交再评估一次。
        ...(enabled === true ? { lastSignature: null } : {}),
      })
      emit()
      if (enabled === true) void poll()
      return snapshot()
    },

    async removeWatch({ watchId }) {
      const watch = storage.autoFix.watches.get(watchId)
      if (watch === undefined) throw new RpcError('storage.not_found', { watchId })
      storage.autoFix.watches.remove(watchId)
      await removeWorktree(watch)
      emit()
      return snapshot()
    },

    setPaused({ paused: next }) {
      paused = next
      emit()
      return snapshot()
    },

    start() {
      if (timer !== undefined) return
      stopped = false
      const interrupted = storage.autoFix.jobs.interruptActive()
      if (interrupted > 0) emit()
      timer = setInterval(() => void poll(), intervalMs)
      void poll()
    },

    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      unsubscribeEvents()
    },

    poll,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
