/**
 * 端到端测试用的假 GitHub REST 服务（M8-05）：只监听 127.0.0.1，实现自动修复用到的只读端点。
 *
 * 应用通过 `CAIRN_GITHUB_API_URL`（仅开发构建）指向这里；令牌照常走凭据存储与 `authorization`
 * 头，假服务不校验内容，但会记下每次请求，便于断言“请求确实带上了令牌”。
 */
import { createServer } from 'node:http'

export interface FakeCheck {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion?: string
}

export interface FakeComment {
  readonly id: number
  readonly author: string
  readonly body: string
  readonly path?: string
  readonly line?: number
}

export interface FakeGithubOptions {
  readonly login?: string
  /** `owner/name`；PR 的 head 也指向同一个仓库。 */
  readonly repo: string
  readonly number: number
  readonly title?: string
  readonly headRef: string
  readonly headSha: string
  readonly baseRef?: string
  readonly mergeableState?: string
  readonly checks?: readonly FakeCheck[]
  readonly comments?: readonly FakeComment[]
  /** 失败任务的日志文本。 */
  readonly log?: string
}

export interface FakeGithubRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
}

export interface FakeGithub {
  readonly baseUrl: string
  readonly requests: FakeGithubRequest[]
  close(): Promise<void>
}

export async function startFakeGithub(options: FakeGithubOptions): Promise<FakeGithub> {
  const {
    login = 'e2e-user',
    repo,
    number,
    title = 'Fix the failing check',
    headRef,
    headSha,
    baseRef = 'main',
    mergeableState = 'clean',
    checks = [],
    comments = [],
    log = 'TypeError: boom',
  } = options
  /** @type {FakeGithubRequest[]} */
  const requests: FakeGithubRequest[] = []
  let baseUrl = ''

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: req.headers.authorization,
    })
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const prefix = `/repos/${repo}`
    const path = url.pathname
    if (path === '/user') {
      send({ login })
      return
    }
    if (path === `${prefix}/pulls/${number}`) {
      send({
        number,
        title,
        html_url: `https://github.com/${repo}/pull/${number}`,
        state: 'open',
        draft: false,
        head: { ref: headRef, sha: headSha, repo: { full_name: repo } },
        base: { ref: baseRef },
        mergeable_state: mergeableState,
      })
      return
    }
    if (path === `${prefix}/commits/${headSha}/check-runs`) {
      send({
        check_runs: checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
          details_url: `${baseUrl}/actions/job/${check.id}`,
        })),
      })
      return
    }
    if (path === `${prefix}/pulls/${number}/comments`) {
      send(
        comments.map((comment) => ({
          id: comment.id,
          user: { login: comment.author },
          body: comment.body,
          ...(comment.path === undefined ? {} : { path: comment.path }),
          ...(comment.line === undefined ? {} : { line: comment.line }),
        })),
      )
      return
    }
    const checkRun = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(path)
    if (checkRun !== null) {
      const id = Number(checkRun[1])
      const check = checks.find((item) => item.id === id)
      if (check === undefined) {
        send({ message: 'Not Found' }, 404)
        return
      }
      send({
        id,
        name: check.name,
        status: check.status,
        details_url: `${baseUrl}/actions/job/${id}`,
      })
      return
    }
    const jobLog = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/\d+\/logs$/.exec(path)
    if (jobLog !== null) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(log)
      return
    }
    send({ message: 'Not Found' }, 404)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake GitHub: no address')
  baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
