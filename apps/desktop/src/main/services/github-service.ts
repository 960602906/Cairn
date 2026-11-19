/**
 * GitHub 只读服务（M8-01 / M8-04）：PR 快照、失败检查日志与行内评审意见。
 *
 * - 令牌自动解析，不需要界面配置：先看环境变量 `GH_TOKEN` / `GITHUB_TOKEN`，再看旧版设置页
 *   保存的凭据，最后问本机 `gh auth token`；明文只在本进程的请求里使用；
 * - 不轮询、不订阅、不写回：轮询由自动修复服务负责，推送经受控 Git 工具在主进程执行（M8-03）；
 * - 网络错误统一映射成 `github.*` 错误码；
 * - 不在日志或错误参数里带令牌，也不把完整响应体塞进错误；
 * - 端到端测试用 `CAIRN_GITHUB_API_URL` 指向本机假服务（仅开发构建，只接受 HTTPS 或回环 HTTP）。
 *
 * 不依赖 Electron：`fetch` 与令牌来源都由调用方注入，单元测试用假实现。
 */
import { execFile } from 'node:child_process'
import { unzipSync } from 'fflate'
import {
  GITHUB_CREDENTIAL_REF,
  GITHUB_LOG_MAX_CHARS,
  GITHUB_REPO_PATTERN,
  GithubCheckConclusion,
  GithubErrorCode,
  RpcError,
  type GithubCheckLog,
  type GithubCheckRun,
  type GithubPullRequest,
  type GithubReviewComment,
} from '@cairn/protocol'
import type { LocalKeyStore } from './credential-store.js'

/** 只用到凭据存储的 `resolve`；测试更容易替身。 */
export type GithubCredentials = Pick<LocalKeyStore, 'resolve'>

/** 令牌解析函数：没有可用令牌时返回 `undefined`。 */
export type GithubTokenResolver = () => Promise<string | undefined>

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GithubServiceOptions {
  /** 每次请求前解析令牌；见 `createGithubTokenResolver`。 */
  readonly resolveToken: GithubTokenResolver
  /** 默认使用全局 `fetch`。 */
  readonly fetchImpl?: FetchLike
  /** API 根地址；默认 GitHub 公共 API。端到端测试用 `CAIRN_GITHUB_API_URL` 指向本机假服务。 */
  readonly apiBase?: string
}

export interface GithubService {
  pullRequest(input: { repo: string; number: number }): Promise<GithubPullRequest>
  checkLog(input: { repo: string; checkRunId: number }): Promise<GithubCheckLog>
  /** PR 的行内评审意见，按 id 升序（M8-04）；最多最近 100 条。 */
  reviewComments(input: { repo: string; number: number }): Promise<GithubReviewComment[]>
}

export interface GithubTokenSources {
  /** 旧版设置页保存的令牌；保留下来，升级后无需重新配置。 */
  readonly credentials: GithubCredentials
  /** 默认是 `process.env`。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 读取 `gh auth token`；测试注入。默认调用本机 `gh`。 */
  readonly readGhToken?: () => Promise<string | undefined>
}

/** `gh` 的结果缓存多久；轮询时不必每次都起子进程。 */
const GH_TOKEN_TTL_MS = 60_000

/** 本机 `gh` 的登录令牌；没装、未登录或超时都返回 `undefined`。 */
export function readGhAuthToken(): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile('gh', ['auth', 'token'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolvePromise(undefined)
        return
      }
      const token = stdout.trim()
      resolvePromise(token === '' ? undefined : token)
    })
  })
}

/**
 * 自动解析 GitHub 令牌（M8-01 静默化）：环境变量优先，其次是旧版界面保存的凭据，
 * 最后使用本机 `gh auth token`。这样用户只要在该环境里能提交/创建 PR，自动修复就能直接工作。
 */
export function createGithubTokenResolver(sources: GithubTokenSources): GithubTokenResolver {
  let cached: { readonly value: string | undefined; readonly at: number } | undefined
  return async () => {
    const env = sources.env ?? process.env
    const fromEnv = (env['GH_TOKEN'] ?? env['GITHUB_TOKEN'])?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    try {
      const stored = await sources.credentials.resolve(GITHUB_CREDENTIAL_REF)
      if (stored !== undefined && stored.apiKey !== '') return stored.apiKey
    } catch {
      // 凭据存储不可用（例如 Linux 没有密钥环）时继续尝试 gh。
    }
    const now = Date.now()
    if (cached !== undefined && now - cached.at < GH_TOKEN_TTL_MS) return cached.value
    const value = await (sources.readGhToken ?? readGhAuthToken)()
    cached = { value, at: now }
    return value
  }
}

const API = 'https://api.github.com'

/**
 * 校验并归一化测试用的 API 根地址（M8-05）：只接受 HTTPS 或回环地址上的 HTTP，
 * 其它值忽略，免得把令牌发到别处。只在开发构建里由启动代码调用。
 */
export function normalizeGithubApiBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url.origin
}

/** 详情地址里的 Actions 任务 / 运行 id。 */
const JOB_IN_URL = /\/job\/(\d+)/
const RUN_IN_URL = /\/runs\/(\d+)/

interface PullResponse {
  readonly title?: unknown
  readonly html_url?: unknown
  readonly state?: unknown
  readonly draft?: unknown
  readonly head?: {
    readonly ref?: unknown
    readonly sha?: unknown
    readonly repo?: { readonly full_name?: unknown } | null
  }
  readonly base?: { readonly ref?: unknown }
  readonly mergeable_state?: unknown
}

interface CheckRunResponse {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
  readonly details_url?: unknown
  readonly started_at?: unknown
  readonly completed_at?: unknown
}

interface CheckListResponse {
  readonly check_runs?: unknown
}

interface ReviewCommentResponse {
  readonly id?: unknown
  readonly user?: { readonly login?: unknown }
  readonly body?: unknown
  readonly path?: unknown
  readonly line?: unknown
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

function ms(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function conclusion(value: unknown): GithubCheckConclusion | undefined {
  return GithubCheckConclusion.safeParse(value).success
    ? (value as GithubCheckConclusion)
    : undefined
}

function toReviewComment(raw: ReviewCommentResponse): GithubReviewComment | undefined {
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id < 0) return undefined
  const author = text(raw.user?.login, 120)
  const body = text(raw.body, 4000)
  if (author === undefined || body === undefined) return undefined
  const path = text(raw.path, 1024)
  const line =
    typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line >= 0
      ? raw.line
      : undefined
  return {
    id: raw.id,
    author,
    body,
    ...(path === undefined ? {} : { path }),
    ...(line === undefined ? {} : { line }),
  }
}

function toCheckRun(raw: CheckRunResponse): GithubCheckRun | undefined {
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id < 0) return undefined
  const name = text(raw.name, 300)
  const status = text(raw.status, 40)
  if (name === undefined || status === undefined) return undefined
  const detailsUrl = text(raw.details_url, 4096)
  const startedAt = ms(raw.started_at)
  const completedAt = ms(raw.completed_at)
  const verdict = conclusion(raw.conclusion)
  return {
    id: raw.id,
    name,
    status,
    ...(verdict === undefined ? {} : { conclusion: verdict }),
    ...(detailsUrl === undefined ? {} : { detailsUrl }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

/** 日志文本只保留末尾，失败原因通常在最后。 */
function clip(textValue: string): { text: string; truncated: boolean } {
  const chars = [...textValue]
  if (chars.length <= GITHUB_LOG_MAX_CHARS) return { text: textValue, truncated: false }
  return { text: chars.slice(-GITHUB_LOG_MAX_CHARS).join(''), truncated: true }
}

/** 任务日志是 zip；解压失败时按纯文本处理（测试替身与旧接口）。 */
function decodeLog(bytes: Uint8Array): string {
  try {
    const files = unzipSync(bytes)
    const names = Object.keys(files).sort()
    return names.map((name) => new TextDecoder().decode(files[name])).join('\n')
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

export function createGithubService(options: GithubServiceOptions): GithubService {
  const { resolveToken } = options
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const api = options.apiBase === undefined ? API : options.apiBase.replace(/\/+$/, '')

  async function tokenOrThrow(): Promise<string> {
    const resolved = await resolveToken()
    if (resolved === undefined || resolved === '') {
      throw new RpcError(GithubErrorCode.NotConnected)
    }
    return resolved
  }

  async function call(path: string, token: string): Promise<Response> {
    let response: Response
    try {
      response = await fetchImpl(`${api}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'Cairn',
        },
      })
    } catch (error) {
      throw new RpcError(GithubErrorCode.Network, {
        reason: error instanceof Error ? error.message.slice(0, 300) : 'network error',
      })
    }
    if (response.ok) return response
    if (response.status === 401) throw new RpcError(GithubErrorCode.AuthFailed)
    if (response.status === 404) throw new RpcError(GithubErrorCode.NotFound)
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      throw new RpcError(GithubErrorCode.RateLimited)
    }
    throw new RpcError(GithubErrorCode.Network, { status: response.status })
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T
    } catch {
      throw new RpcError(GithubErrorCode.InvalidResponse)
    }
  }

  return {
    async pullRequest({ repo, number }) {
      const token = await tokenOrThrow()
      const pull = await json<PullResponse>(await call(`/repos/${repo}/pulls/${number}`, token))
      const title = text(pull.title, 500)
      const url = text(pull.html_url, 4096)
      const headRef = text(pull.head?.ref, 255)
      const headSha = text(pull.head?.sha, 64)
      const headRepoName = text(pull.head?.repo?.full_name, 201)
      const headRepo =
        headRepoName !== undefined && GITHUB_REPO_PATTERN.test(headRepoName)
          ? headRepoName
          : undefined
      const baseRef = text(pull.base?.ref, 255)
      if (
        title === undefined ||
        url === undefined ||
        headRef === undefined ||
        headSha === undefined ||
        baseRef === undefined
      ) {
        throw new RpcError(GithubErrorCode.InvalidResponse)
      }
      const checks: GithubCheckRun[] = []
      const listed = await json<CheckListResponse>(
        await call(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, token),
      )
      if (Array.isArray(listed.check_runs)) {
        for (const item of listed.check_runs) {
          const parsed = toCheckRun(item as CheckRunResponse)
          if (parsed !== undefined) checks.push(parsed)
        }
      }
      checks.sort((a, b) => a.name.localeCompare(b.name))
      const mergeableState = text(pull.mergeable_state, 40)
      return {
        repo,
        number,
        title,
        url,
        state: pull.state === 'closed' ? 'closed' : 'open',
        draft: pull.draft === true,
        headRef,
        headSha,
        ...(headRepo === undefined ? {} : { headRepo }),
        baseRef,
        ...(mergeableState === undefined ? {} : { mergeableState }),
        checks,
      }
    },

    async reviewComments({ repo, number }) {
      const token = await tokenOrThrow()
      // 从新到旧取最近的 100 条；只需要找出比上次更新的那些。
      const listed = await json<unknown>(
        await call(
          `/repos/${repo}/pulls/${number}/comments?per_page=100&sort=created&direction=desc`,
          token,
        ),
      )
      const comments: GithubReviewComment[] = []
      if (Array.isArray(listed)) {
        for (const item of listed) {
          const parsed = toReviewComment(item as ReviewCommentResponse)
          if (parsed !== undefined) comments.push(parsed)
        }
      }
      comments.sort((a, b) => a.id - b.id)
      return comments
    },

    async checkLog({ repo, checkRunId }) {
      const token = await tokenOrThrow()
      const run = await json<CheckRunResponse>(
        await call(`/repos/${repo}/check-runs/${checkRunId}`, token),
      )
      const details = text(run.details_url, 4096)
      if (details === undefined) throw new RpcError(GithubErrorCode.LogUnavailable)
      const job = JOB_IN_URL.exec(details)?.[1]
      const actionsRun = RUN_IN_URL.exec(details)?.[1]
      const path =
        job !== undefined
          ? `/repos/${repo}/actions/jobs/${job}/logs`
          : actionsRun !== undefined
            ? `/repos/${repo}/actions/runs/${actionsRun}/logs`
            : undefined
      if (path === undefined) throw new RpcError(GithubErrorCode.LogUnavailable)
      const response = await call(path, token)
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        throw new RpcError(GithubErrorCode.LogUnavailable, {
          reason: error instanceof Error ? error.message.slice(0, 300) : 'log download failed',
        })
      }
      return clip(decodeLog(bytes))
    },
  }
}
