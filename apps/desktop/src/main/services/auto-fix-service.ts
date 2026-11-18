/**
 * 自动修复的监视与触发（M8-02 / M8-04）。
 *
 * - 轮询而不是 Webhook（桌面应用没有稳定公网入口）：每个启用的监视按固定间隔读取一次 PR；
 * - 去重签名（`headSha + 失败检查名` / `headSha`）：同一份提交只修一次，推送或改了检查才进入下一轮；
 * - 每个监视一个独立 worktree（`<worktrees>/pr-<watchId>`），每次修复前重置到 PR 的 head 提交，
 *   不碰用户自己的工作目录；
 * - 修复会话 `kind = 'auto-fix'`，以无人值守方式运行（ADR-0018）；自动修复会话可以用
 *   `git_commit` / `git_push` 两个受控工具提交并推送到 PR 的 head 分支（M8-03）；
 * - 推送后下一轮轮询：检查通过记为 `passed`；仍有新的失败则进入下一次尝试；达到尝试上限时
 *   关闭监视并记录 `gave_up`，同时通知用户；
 * - 合并冲突时先在工作区里 `git merge origin/<base>`，未合并文件交给会话解决（M8-04）；
 * - 新评审意见按评论 id 触发：新监视先建立基线，之后 id 更大的行内评论才会开一轮修复（M8-04）。
 *
 * 不依赖 Electron：Git、GitHub、会话与时间来源都由调用方注入。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AUTO_FIX_DEFAULT_ATTEMPTS,
  AUTO_FIX_MAX_WATCHES,
  AutoFixGitErrorCode,
  RpcError,
  type AutoFixJob,
  type AutoFixJobStatus,
  type AutoFixSessionContext,
  type AutoFixStatus,
  type AutoFixTrigger,
  type GithubPullRequest,
  type GithubReviewComment,
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
  /** 只用到 PR 快照、失败日志与评审意见。 */
  readonly github: Pick<GithubService, 'pullRequest' | 'checkLog' | 'reviewComments'>
  readonly sessions: Pick<SessionManager, 'prompt' | 'abort'>
  readonly git: GitRunner
  /** `<userData>/worktrees`。 */
  readonly worktreesRoot: string
  /** 读取 GitHub 令牌（M8-03）；只注入一次推送子进程的环境，不经过宿主与日志。 */
  readonly githubToken?: () => Promise<string | undefined>
  /** 任务通过或放弃时通知用户（M8-03）；失败不应影响任务本身。 */
  readonly onJobFinished?: (job: AutoFixJob, watch: PullRequestWatchRecord) => void
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
  /** 会话对应的自动修复上下文；不是自动修复会话时为 undefined（宿主据此注册 Git 工具）。 */
  contextFor(sessionId: string): AutoFixSessionContext | undefined
  /** 在监视工作区提交（M8-03）。校验会话、监视与工作区，使用受控身份，不接受 amend。 */
  commit(sessionId: string, input: { message: string }): Promise<{ sha: string }>
  /** 推送到 PR 的 head 分支（M8-03）：拒绝强制推送、非 PR 分支与分叉历史。 */
  push(sessionId: string): Promise<{ sha: string; branch: string }>
  /** 启动轮询并清理上次遗留的任务。 */
  start(): void
  stop(): void
  /** 立即评估一轮；已在评估时直接返回。 */
  poll(): Promise<void>
  /** 监视或任务变化时通知（网关据此推送 `autofix.changed`）。 */
  subscribe(listener: () => void): () => void
}

/** 一次修复的触发信息：哪一类、去重签名、失败检查与新评审意见。 */
export interface AutoFixRepair {
  readonly trigger: AutoFixTrigger
  readonly signature: string
  readonly failed: readonly string[]
  readonly comments?: readonly GithubReviewComment[]
}

/**
 * 需要修复时的触发项与去重签名；不需要时返回 undefined。
 * `newComments` 只包含上次处理之后的新评审意见（M8-04）。
 */
export function repairTrigger(
  pull: GithubPullRequest,
  triggers: readonly AutoFixTrigger[],
  newComments: readonly GithubReviewComment[] = [],
): AutoFixRepair | undefined {
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
  if (newComments.length > 0) {
    const latest = Math.max(...newComments.map((comment) => comment.id))
    return {
      trigger: 'comment',
      signature: `${pull.headSha}:comment:${latest}`.slice(0, SIGNATURE_MAX),
      failed: [],
      comments: newComments,
    }
  }
  return undefined
}

/** 单条评审意见在提示里的长度上限；长评论只保留开头。 */
const COMMENT_IN_BRIEF = 800
const COMMENTS_IN_BRIEF = 20

/** 修复会话的提示：说明范围与禁区、冲突与评审意见，以及提交推送的受控方式（M8-03 / M8-04）。 */
export function repairBrief(input: {
  pull: GithubPullRequest
  trigger: AutoFixTrigger
  failed: readonly string[]
  worktree: string
  log?: string | undefined
  /** 触发为 `conflict` 时工作区里未合并的文件。 */
  conflicts?: readonly string[] | undefined
  /** 触发为 `comment` 时需要处理的评审意见。 */
  comments?: readonly GithubReviewComment[] | undefined
}): string {
  const { pull, trigger, failed, worktree, log, conflicts = [], comments = [] } = input
  const headline =
    trigger === 'ci'
      ? `失败的检查：${failed.join('、')}`
      : trigger === 'conflict'
        ? `合并冲突：当前分支与 ${pull.baseRef} 存在冲突`
        : `评审意见：${comments.length} 条新的行内评论`
  const lines = [
    '自动修复任务（改代码、运行检查、提交并推送到 PR 分支）',
    '',
    `PR：${pull.repo}#${pull.number} ${pull.title}`,
    `地址：${pull.url}`,
    headline,
    `本地工作区：${worktree}`,
  ]
  if (trigger === 'conflict') {
    lines.push(
      '',
      `已经在这个工作区里执行 git merge origin/${pull.baseRef}；冲突文件：`,
      ...(conflicts.length === 0 ? ['（没有未合并文件）'] : conflicts.map((file) => `- ${file}`)),
      '',
      '请逐块解决冲突：保留双方的意图，不要直接丢弃对方分支的改动；解决后运行相关检查，',
      '用 git_commit 提交（这次提交会记录合并），再用 git_push 推送。不要 rebase 或改写历史。',
    )
  }
  if (trigger === 'comment') {
    lines.push('', '需要处理的评审意见：')
    for (const comment of comments.slice(0, COMMENTS_IN_BRIEF)) {
      const where =
        comment.path === undefined
          ? ''
          : `（${comment.path}${comment.line === undefined ? '' : `:${comment.line}`}）`
      lines.push(`- @${comment.author}${where}：${comment.body.slice(0, COMMENT_IN_BRIEF)}`)
    }
    if (comments.length > COMMENTS_IN_BRIEF) {
      lines.push(`（其余 ${comments.length - COMMENTS_IN_BRIEF} 条见 PR 页面）`)
    }
  }
  lines.push(
    '',
    '请在这个工作区里：',
    '1. 先定位原因；',
    '2. 修改代码并运行相关检查；',
    '3. 用 git_commit 提交改动，再用 git_push 推送到 PR 的 head 分支；',
    '4. 不要强制推送、不要合并其他分支、不要切换或推送其他分支；',
    '5. 完成后说明改了什么、运行了哪些检查、结果如何。',
  )
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

/**
 * 推送用的 Git 环境：只对这一次子进程加一个 HTTP 头，令牌不进入命令行参数、事件与日志。
 * base64 可逆，但只存在于该子进程的环境里。
 */
function pushEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}

/** 检查是否全部结束且没有失败；没有检查项时只要求没有合并冲突（冲突修复用）。 */
function checksGreen(pull: GithubPullRequest): boolean {
  if (pull.checks.some((check) => check.status !== 'completed')) return false
  if (
    pull.checks.some(
      (check) => check.conclusion !== undefined && FAILED_CONCLUSIONS.has(check.conclusion),
    )
  ) {
    return false
  }
  return pull.mergeableState !== 'dirty'
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
  let polling: Promise<void> | undefined
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

  /**
   * 暂停时收掉所有排队与运行中的任务（M8-05）：任务记为 `cancelled`，并中止对应的修复会话。
   * 取消不算一次尝试，也不记签名，恢复后同一份失败还能再修。
   */
  const cancelActiveJobs = (): number => {
    const active = storage.autoFix.jobs
      .list()
      .filter((job) => job.status === 'queued' || job.status === 'running')
    for (const job of active) {
      storage.autoFix.jobs.update(job.jobId, { status: 'cancelled', detail: 'paused' })
      storage.autoFix.watches.update(job.watchId, {
        lastSignature: null,
        attempts: Math.max(0, job.attempt - 1),
      })
      if (job.sessionId === undefined) continue
      jobsBySession.delete(job.sessionId)
      // 会话可能已经结束或即将结束；取消失败不影响暂停本身。
      try {
        void Promise.resolve(sessions.abort({ sessionId: job.sessionId })).catch(reportError)
      } catch (error) {
        reportError(error)
      }
    }
    return active.length
  }

  /** 完成或放弃时通知用户；通知本身失败不影响任务。 */
  const notifyFinished = (jobId: string, status: AutoFixJobStatus) => {
    if (status !== 'passed' && status !== 'gave_up') return
    const job = storage.autoFix.jobs.get(jobId)
    const watch = job === undefined ? undefined : storage.autoFix.watches.get(job.watchId)
    if (job === undefined || watch === undefined) return
    try {
      options.onJobFinished?.(job, watch)
    } catch (error) {
      reportError(error)
    }
  }

  /** 会话对应的任务与监视；不是自动修复会话时拒绝。 */
  const jobForSession = (sessionId: string) => {
    const job = storage.autoFix.jobs.getBySession(sessionId)
    const watch = job === undefined ? undefined : storage.autoFix.watches.get(job.watchId)
    if (job === undefined || watch === undefined) {
      throw new RpcError(AutoFixGitErrorCode.NotAutoFix)
    }
    return { job, watch }
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

  /** 冲突修复时合并基准分支用的身份；与 `git_commit` 一致，不读取用户的 Git 配置。 */
  const IDENTITY = [
    '-c',
    'user.name=Cairn',
    '-c',
    'user.email=cairn@users.noreply.github.com',
  ] as const

  /**
   * 把监视工作区重置到 PR 的 head 提交；位于用户仓库之外，可随时丢弃。
   * 冲突触发时再执行 `git merge origin/<base>`（M8-04）：冲突是预期结果，未合并文件交给会话解决。
   */
  const prepareWorktree = async (
    watch: PullRequestWatchRecord,
    pull: GithubPullRequest,
    trigger: AutoFixTrigger,
  ): Promise<{ directory: string; conflicts: string[] }> => {
    const fetched = await git.run(['-C', watch.projectPath, 'fetch', '--no-tags', 'origin'], {
      allowFail: true,
    })
    if (fetched.code !== 0) {
      throw new Error(`git fetch 失败：${fetched.stderr.trim()}`)
    }
    const present = await git.run(
      ['-C', watch.projectPath, 'cat-file', '-e', `${pull.headSha}^{commit}`],
      { allowFail: true },
    )
    if (present.code !== 0) throw new Error('fetch 之后仍然找不到 PR 的提交')
    const directory = worktreeOf(options.worktreesRoot, watch.watchId)
    if (existsSync(directory)) {
      const reset = await git.run(['-C', directory, 'reset', '--hard', pull.headSha], {
        allowFail: true,
      })
      if (reset.code !== 0) throw new Error(`重置监视工作区失败：${reset.stderr.trim()}`)
    } else {
      mkdirSync(options.worktreesRoot, { recursive: true })
      const added = await git.run(
        ['-C', watch.projectPath, 'worktree', 'add', '--detach', directory, pull.headSha],
        { allowFail: true },
      )
      if (added.code !== 0) throw new Error(`创建监视工作区失败：${added.stderr.trim()}`)
    }
    if (trigger !== 'conflict') return { directory, conflicts: [] }
    const merged = await git.run(
      ['-C', directory, ...IDENTITY, 'merge', '--no-edit', `origin/${pull.baseRef}`],
      { allowFail: true },
    )
    const unmerged = await git.run(['-C', directory, 'diff', '--name-only', '--diff-filter=U'], {
      allowFail: true,
    })
    const conflicts =
      unmerged.code === 0
        ? unmerged.stdout
            .toString('utf8')
            .split('\n')
            .map((file) => file.trim())
            .filter((file) => file !== '')
        : []
    // 非零且没有未合并文件：不是冲突，而是 base 分支不存在或工作区状态异常，别让会话去猜。
    if (merged.code !== 0 && conflicts.length === 0) {
      throw new Error(`合并 origin/${pull.baseRef} 失败：${merged.stderr.trim()}`)
    }
    return { directory, conflicts }
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
    repair: AutoFixRepair,
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
    // 评审意见同时记下已处理到的最新 id，推送后 head 变了也不会把同一批意见再修一次。
    const latestComment =
      repair.comments === undefined || repair.comments.length === 0
        ? undefined
        : Math.max(...repair.comments.map((comment) => comment.id))
    storage.autoFix.watches.update(watch.watchId, {
      lastSignature: repair.signature,
      attempts: attempt,
      lastEvaluatedAt: now(),
      ...(latestComment === undefined ? {} : { lastCommentId: latestComment }),
    })
    emit()

    try {
      const { directory: worktree, conflicts } = await prepareWorktree(watch, pull, repair.trigger)
      // 准备期间被暂停或取消：不再开会话，任务已经是最终状态。
      if (paused || stopped || storage.autoFix.jobs.get(jobId)?.status !== 'queued') return
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
              conflicts,
              ...(repair.comments === undefined ? {} : { comments: repair.comments }),
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
    // 评审意见（M8-04）：第一次评估只建立基线，之后 id 更大的才算新意见。
    let comments: GithubReviewComment[] | undefined
    if (watch.triggers.includes('comment')) {
      try {
        comments = await github.reviewComments({ repo: watch.repo, number: watch.prNumber })
      } catch (error) {
        // 读不到意见不影响按检查项与冲突判断；下一轮再试。
        reportError(error)
      }
    }
    let lastCommentId = watch.lastCommentId
    if (comments !== undefined && lastCommentId === undefined) {
      lastCommentId = comments.reduce((latest, comment) => Math.max(latest, comment.id), 0)
      storage.autoFix.watches.update(watch.watchId, { lastCommentId })
    }
    const newComments =
      comments === undefined ? [] : comments.filter((comment) => comment.id > (lastCommentId ?? 0))
    const repair = repairTrigger(pull, watch.triggers, newComments)
    // 上一次推送后检查通过：任务记为 passed，不再触发新的修复（M8-03 回检）。
    const pushed = storage.autoFix.jobs
      .list({ watchId: watch.watchId })
      .filter((job) => job.status === 'pushed')
    if (pushed.length > 0 && repair === undefined && checksGreen(pull)) {
      // 之前几次推送也都已经通过（新的推送建立在它们之上），一并收尾，状态列表里不留过期的“已推送”。
      for (const job of pushed) storage.autoFix.jobs.update(job.jobId, { status: 'passed' })
      storage.autoFix.watches.update(watch.watchId, { lastEvaluatedAt: now() })
      emit()
      notifyFinished(pushed[0]!.jobId, 'passed')
      return
    }
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
      const gaveUpId = createId()
      storage.autoFix.jobs.create({
        jobId: gaveUpId,
        watchId: watch.watchId,
        trigger: repair.trigger,
        signature: repair.signature,
        status: 'gave_up',
        attempt: watch.attempts,
      })
      emit()
      notifyFinished(gaveUpId, 'gave_up')
      return
    }
    // 评估期间用户暂停了监视：不再新起修复。
    if (paused || stopped) return
    await startRepair(watch, pull, repair)
  }

  /** 评估一轮；已经在评估时返回同一轮的 promise（恢复监视后立即触发也不会并发读两次）。 */
  const poll = (): Promise<void> => {
    if (stopped || paused) return Promise.resolve()
    if (polling !== undefined) return polling
    const task = (async () => {
      for (const watch of storage.autoFix.watches.list()) {
        if (!watch.enabled || stopped || paused) continue
        try {
          await evaluate(watch)
        } catch (error) {
          reportError(error)
        }
      }
    })()
    const tracked = task.finally(() => {
      if (polling === tracked) polling = undefined
    })
    polling = tracked
    return tracked
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
    contextFor(sessionId) {
      const job = storage.autoFix.jobs.getBySession(sessionId)
      const watch = job === undefined ? undefined : storage.autoFix.watches.get(job.watchId)
      return watch === undefined ? undefined : { repo: watch.repo, prNumber: watch.prNumber }
    },

    async commit(sessionId, { message }) {
      const { watch } = jobForSession(sessionId)
      const directory = worktreeOf(options.worktreesRoot, watch.watchId)
      if (!existsSync(directory)) {
        throw new RpcError(AutoFixGitErrorCode.CommitFailed, {
          reason: 'The auto-fix worktree is missing.',
        })
      }
      const added = await git.run(['-C', directory, 'add', '-A'], { allowFail: true })
      if (added.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.CommitFailed, {
          reason: errorDetail(new Error(added.stderr)),
        })
      }
      const committed = await git.run(['-C', directory, ...IDENTITY, 'commit', '-m', message], {
        allowFail: true,
      })
      if (committed.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.CommitFailed, {
          reason: errorDetail(new Error(committed.stderr)),
        })
      }
      const head = await git.run(['-C', directory, 'rev-parse', 'HEAD'], { allowFail: true })
      const sha = head.stdout.toString('utf8').trim()
      if (head.code !== 0 || sha === '') {
        throw new RpcError(AutoFixGitErrorCode.CommitFailed, {
          reason: 'Could not read the new commit.',
        })
      }
      return { sha }
    },

    async push(sessionId) {
      const { job, watch } = jobForSession(sessionId)
      const directory = worktreeOf(options.worktreesRoot, watch.watchId)
      if (!existsSync(directory)) {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, {
          reason: 'The auto-fix worktree is missing.',
        })
      }
      // 先取远端最新状态：推送目标与分叉判断都以这次读取为准。
      const fetched = await git.run(['-C', directory, 'fetch', '--no-tags', 'origin'], {
        allowFail: true,
      })
      if (fetched.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, {
          reason: errorDetail(new Error(fetched.stderr)),
        })
      }
      let pull: GithubPullRequest
      try {
        pull = await github.pullRequest({ repo: watch.repo, number: watch.prNumber })
      } catch (error) {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, { reason: errorDetail(error) })
      }
      if (pull.state !== 'open') {
        throw new RpcError(AutoFixGitErrorCode.PushDenied, {
          reason: 'The pull request is not open.',
        })
      }
      // 只推送与 PR 同仓库的分支：fork 的同名分支（例如也叫 `main`）不能推到基准仓库。
      if (pull.headRepo !== watch.repo) {
        throw new RpcError(AutoFixGitErrorCode.PushDenied, {
          reason: 'The pull request comes from a fork; only same-repository branches are pushed.',
        })
      }
      const present = await git.run(
        ['-C', directory, 'cat-file', '-e', `${pull.headSha}^{commit}`],
        { allowFail: true },
      )
      if (present.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.PushDenied, {
          reason: 'The current pull request head is not available locally; fetch and retry.',
        })
      }
      // 本地提交必须从 PR 的当前 head 派生：不允许改写已推送的历史，也不允许推别的历史。
      const ancestor = await git.run(
        ['-C', directory, 'merge-base', '--is-ancestor', pull.headSha, 'HEAD'],
        { allowFail: true },
      )
      if (ancestor.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.PushDenied, {
          reason:
            'Local commits do not descend from the pull request head; do not rewrite history.',
        })
      }
      const head = await git.run(['-C', directory, 'rev-parse', 'HEAD'], { allowFail: true })
      const sha = head.stdout.toString('utf8').trim()
      if (head.code !== 0 || sha === '') {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, {
          reason: 'Could not read the local commit.',
        })
      }
      if (sha === pull.headSha) throw new RpcError(AutoFixGitErrorCode.NothingToPush)
      let token: string | undefined
      try {
        token = await options.githubToken?.()
      } catch (error) {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, { reason: errorDetail(error) })
      }
      if (token === undefined || token.trim() === '') {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, { reason: 'GitHub is not connected.' })
      }
      const pushed = await git.run(
        [
          '-C',
          directory,
          'push',
          '--no-verify',
          `https://github.com/${watch.repo}.git`,
          `HEAD:refs/heads/${pull.headRef}`,
        ],
        { allowFail: true, env: pushEnv(token) },
      )
      if (pushed.code !== 0) {
        throw new RpcError(AutoFixGitErrorCode.PushFailed, {
          reason: errorDetail(new Error(pushed.stderr)),
        })
      }
      storage.autoFix.jobs.update(job.jobId, { status: 'pushed' })
      emit()
      return { sha, branch: pull.headRef }
    },

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
      if (next) cancelActiveJobs()
      emit()
      if (!next) void poll()
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
