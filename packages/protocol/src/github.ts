/**
 * GitHub 只读接入（M8-01）：PR 状态、检查项与失败日志。
 *
 * - 令牌由主进程的凭据存储加密保存（ADR-0010），界面只能连接、断开与查询是否已连接；
 * - 这里只有读取，没有推送或评论：推送经自动修复的受控 Git 工具执行（ADR-0045）；
 * - 所有字段都来自 GitHub REST 的公开结构，错误按固定错误码返回，界面自行翻译。
 */
import { z } from 'zod'
import { Timestamp } from './common.js'

/** `owner/name`；与 GitHub 仓库名的字符范围一致。 */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

export const GithubRepo = z.string().max(201).regex(GITHUB_REPO_PATTERN)
export type GithubRepo = z.infer<typeof GithubRepo>

/**
 * 连接状态。`login` 只在令牌有效时出现；令牌失效时仍为已连接，但读取会报
 * `github.auth_failed`，界面据此提示重新连接。
 */
export const GithubStatus = z.object({
  connected: z.boolean(),
  login: z.string().min(1).max(120).optional(),
})
export type GithubStatus = z.infer<typeof GithubStatus>

/** 检查项结论；`null` 表示还没结束，读取时省略。 */
export const GithubCheckConclusion = z.enum([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'neutral',
  'action_required',
])
export type GithubCheckConclusion = z.infer<typeof GithubCheckConclusion>

/** 一项 CI 检查（Checks API 的 check run）。 */
export const GithubCheckRun = z.object({
  /** Checks API 的 id，读取失败日志时使用。 */
  id: z.number().int().nonnegative(),
  name: z.string().min(1).max(300),
  /** `queued` / `in_progress` / `completed` 等。 */
  status: z.string().min(1).max(40),
  conclusion: GithubCheckConclusion.optional(),
  detailsUrl: z.string().max(4096).optional(),
  startedAt: Timestamp.optional(),
  completedAt: Timestamp.optional(),
})
export type GithubCheckRun = z.infer<typeof GithubCheckRun>

/** 一个 PR 的只读快照，检查项按名称排序以便界面稳定显示。 */
export const GithubPullRequest = z.object({
  repo: GithubRepo,
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: z.string().max(4096),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  headRef: z.string().min(1).max(255),
  headSha: z.string().min(7).max(64),
  /**
   * head 所在仓库（`owner/name`）。来自 fork 的 PR 与 `repo` 不同；自动修复只推送到与 PR
   * 同仓库的分支，防止把 fork 的同名分支推成基准仓库的同名分支（M8-03）。
   */
  headRepo: GithubRepo.optional(),
  baseRef: z.string().min(1).max(255),
  /** `clean` / `dirty` / `unknown` 等；仓库未启用合并检查时省略。 */
  mergeableState: z.string().max(40).optional(),
  checks: z.array(GithubCheckRun).max(500),
})
export type GithubPullRequest = z.infer<typeof GithubPullRequest>

/** 失败检查的日志文本；过长时保留末尾 `GITHUB_LOG_MAX_CHARS` 个字符。 */
export const GITHUB_LOG_MAX_CHARS = 200_000

export const GithubCheckLog = z.object({
  text: z.string(),
  truncated: z.boolean(),
})
export type GithubCheckLog = z.infer<typeof GithubCheckLog>

/** 错误码；界面按当前语言翻译，`message` 只用于诊断细节。 */
export const GithubErrorCode = {
  NotConnected: 'github.not_connected',
  AuthFailed: 'github.auth_failed',
  NotFound: 'github.not_found',
  RateLimited: 'github.rate_limited',
  Network: 'github.network',
  InvalidResponse: 'github.invalid_response',
  LogUnavailable: 'github.log_unavailable',
} as const
export type GithubErrorCode = (typeof GithubErrorCode)[keyof typeof GithubErrorCode]

/** 保存令牌时使用的凭据引用。 */
export const GITHUB_CREDENTIAL_REF = 'github'

// ---------- 自动修复监视（M8-02） ----------

/** 会触发修复的情况；评审意见在 M8-04 接入。 */
export const AutoFixTrigger = z.enum(['ci', 'conflict'])
export type AutoFixTrigger = z.infer<typeof AutoFixTrigger>

/**
 * 任务状态。`ready` 表示 M8-02 的“改动留在监视工作区、等待人工处理”；
 * `pushed` 表示修复已推送到 PR 的 head 分支，等待新一轮检查；`passed` 表示推送后检查通过。
 */
export const AutoFixJobStatus = z.enum([
  'queued',
  'running',
  'ready',
  'pushed',
  'passed',
  'failed',
  'gave_up',
  'cancelled',
])
export type AutoFixJobStatus = z.infer<typeof AutoFixJobStatus>

/** 一个被监视的 PR。`attempts` 是已经开始的修复次数。 */
export const PullRequestWatch = z.object({
  watchId: z.string().min(1).max(64),
  repo: GithubRepo,
  prNumber: z.number().int().positive().max(1_000_000),
  projectPath: z.string().min(1).max(4096),
  triggers: z.array(AutoFixTrigger).min(1).max(2),
  maxAttempts: z.number().int().min(1).max(10),
  enabled: z.boolean(),
  attempts: z.number().int().nonnegative().max(1000),
  lastSignature: z.string().max(1000).optional(),
  lastEvaluatedAt: Timestamp.optional(),
  createdAt: Timestamp,
})
export type PullRequestWatch = z.infer<typeof PullRequestWatch>

/** 一次修复任务。`sessionId` 在会话创建后才有。 */
export const AutoFixJob = z.object({
  jobId: z.string().min(1).max(64),
  watchId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64).optional(),
  trigger: AutoFixTrigger,
  signature: z.string().min(1).max(1000),
  status: AutoFixJobStatus,
  attempt: z.number().int().positive().max(1000),
  detail: z.string().max(2000).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type AutoFixJob = z.infer<typeof AutoFixJob>

/** 自动修复设置页的一次快照：全局暂停、监视列表与最近的任务。 */
export const AutoFixStatus = z.object({
  paused: z.boolean(),
  watches: z.array(PullRequestWatch).max(20),
  jobs: z.array(AutoFixJob).max(100),
})
export type AutoFixStatus = z.infer<typeof AutoFixStatus>

/** 监视的上限与默认尝试次数。 */
export const AUTO_FIX_MAX_WATCHES = 20
export const AUTO_FIX_DEFAULT_ATTEMPTS = 3

// ---------- 自动修复推送（M8-03） ----------

/**
 * 自动修复会话的宿主上下文：只在 `kind === 'auto-fix'` 的会话里下发，宿主据此注册
 * `git_commit` / `git_push` 两个受控工具。仓库与 PR 号只用于提示与校验，推送目标由主进程按
 * 最新的 PR 快照决定。
 */
export const AutoFixSessionContext = z.object({
  repo: GithubRepo,
  prNumber: z.number().int().positive().max(1_000_000),
})
export type AutoFixSessionContext = z.infer<typeof AutoFixSessionContext>

/** 推送/提交被守卫拒绝或失败时的错误码；工具把说明交给模型，界面按当前语言翻译。 */
export const AutoFixGitErrorCode = {
  /** 不是自动修复会话，或会话已没有对应的监视。 */
  NotAutoFix: 'autofix.not_auto_fix',
  /** 提交失败（没有改动、Git 报错）。 */
  CommitFailed: 'autofix.commit_failed',
  /** 没有可推送的提交。 */
  NothingToPush: 'autofix.nothing_to_push',
  /** 推送被分支守卫拒绝。 */
  PushDenied: 'autofix.push_denied',
  /** 推送失败（网络、凭据或远端拒绝）。 */
  PushFailed: 'autofix.push_failed',
} as const
export type AutoFixGitErrorCode = (typeof AutoFixGitErrorCode)[keyof typeof AutoFixGitErrorCode]
