/**
 * GitHub 只读接入（M8-01）：PR 状态、检查项与失败日志。
 *
 * - 令牌由主进程的凭据存储加密保存（ADR-0010），界面只能连接、断开与查询是否已连接；
 * - 这里只有读取，没有推送或评论：自动修复的写回在后续阶段单独设计；
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
