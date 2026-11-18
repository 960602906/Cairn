/**
 * GitHub 只读服务（M8-01）：连接、PR 快照与失败检查日志。
 *
 * - 令牌经 `LocalKeyStore`（ADR-0010）加密保存，明文只在本进程的请求里使用；
 * - 不轮询、不订阅、不写回：自动修复的触发与推送在后续阶段接入；
 * - 网络错误统一映射成 `github.*` 错误码，界面按当前语言翻译；
 * - 不在日志或错误参数里带令牌，也不把完整响应体塞进错误。
 *
 * 不依赖 Electron：`fetch` 与凭据存储都由调用方注入，单元测试用假实现。
 */
import { unzipSync } from 'fflate'
import {
  GITHUB_CREDENTIAL_REF,
  GITHUB_LOG_MAX_CHARS,
  GithubCheckConclusion,
  GithubErrorCode,
  RpcError,
  type GithubCheckLog,
  type GithubCheckRun,
  type GithubPullRequest,
  type GithubStatus,
} from '@cairn/protocol'
import type { LocalKeyStore } from './credential-store.js'

/** 只用到凭据存储的这几个方法；测试更容易替身。 */
export type GithubCredentials = Pick<LocalKeyStore, 'resolve' | 'set' | 'delete' | 'has'>

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GithubServiceOptions {
  readonly credentials: GithubCredentials
  /** 默认使用全局 `fetch`。 */
  readonly fetchImpl?: FetchLike
}

export interface GithubService {
  status(): Promise<GithubStatus>
  connect(input: { token: string }): Promise<GithubStatus>
  disconnect(): Promise<GithubStatus>
  pullRequest(input: { repo: string; number: number }): Promise<GithubPullRequest>
  checkLog(input: { repo: string; checkRunId: number }): Promise<GithubCheckLog>
}

const API = 'https://api.github.com'

/** 详情地址里的 Actions 任务 / 运行 id。 */
const JOB_IN_URL = /\/job\/(\d+)/
const RUN_IN_URL = /\/runs\/(\d+)/

interface UserResponse {
  readonly login?: unknown
}

interface PullResponse {
  readonly title?: unknown
  readonly html_url?: unknown
  readonly state?: unknown
  readonly draft?: unknown
  readonly head?: { readonly ref?: unknown; readonly sha?: unknown }
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
  const { credentials } = options
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  /** 连接后记住登录名；进程重启后第一次 `status` 再向 GitHub 取。 */
  let login: string | undefined

  async function tokenOrThrow(): Promise<string> {
    const resolved = await credentials.resolve(GITHUB_CREDENTIAL_REF)
    if (resolved === undefined || resolved.apiKey === '') {
      throw new RpcError(GithubErrorCode.NotConnected)
    }
    return resolved.apiKey
  }

  async function call(path: string, token: string): Promise<Response> {
    let response: Response
    try {
      response = await fetchImpl(`${API}${path}`, {
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

  const status = async (): Promise<GithubStatus> => {
    if (!credentials.has(GITHUB_CREDENTIAL_REF)) return { connected: false }
    // 令牌可能已经失效：只是取不到登录名，仍按已连接返回，读取时再报具体错误。
    try {
      const token = await tokenOrThrow()
      const user = await json<UserResponse>(await call('/user', token))
      const name = text(user.login, 120)
      if (name !== undefined) login = name
    } catch {
      // 离线或令牌失效都不影响“已保存令牌”这一事实。
    }
    return { connected: true, ...(login === undefined ? {} : { login }) }
  }

  return {
    status,

    async connect({ token }) {
      const value = token.trim()
      const response = await call('/user', value)
      const user = await json<UserResponse>(response)
      const name = text(user.login, 120)
      if (name === undefined) throw new RpcError(GithubErrorCode.InvalidResponse)
      // 验证通过才保存，避免把无效令牌覆盖掉原来可用的那个。
      await credentials.set(GITHUB_CREDENTIAL_REF, value)
      login = name
      return { connected: true, login: name }
    },

    async disconnect() {
      await credentials.delete(GITHUB_CREDENTIAL_REF)
      login = undefined
      return { connected: false }
    },

    async pullRequest({ repo, number }) {
      const token = await tokenOrThrow()
      const pull = await json<PullResponse>(await call(`/repos/${repo}/pulls/${number}`, token))
      const title = text(pull.title, 500)
      const url = text(pull.html_url, 4096)
      const headRef = text(pull.head?.ref, 255)
      const headSha = text(pull.head?.sha, 64)
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
        baseRef,
        ...(mergeableState === undefined ? {} : { mergeableState }),
        checks,
      }
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
