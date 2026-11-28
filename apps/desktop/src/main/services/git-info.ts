/**
 * 项目目录的 Git 摘要与分支操作（输入框上方的上下文条与分支菜单）。
 *
 * 读取当前分支与本地分支列表：不是 Git 仓库、Git 不可用、处于游离 HEAD 或输出异常时
 * 都返回空对象，界面只显示目录，不影响输入与发送。切换 / 新建分支只接受本地分支名称；
 * 工作区有未提交改动时由 Git 决定是否允许切换。拉取只接受快进（`--ff-only`），避免在对话
 * 进行中出现合并提交；推送沿用用户自己的 Git 环境（凭据助手 / SSH），失败时把 Git 的说明
 * 带回界面。
 */
import { RpcError } from '@cairn/protocol'
import type { GitRunner } from '@cairn/checkpoint'

/** 与协议中的分支长度上限一致。 */
const BRANCH_MAX_LENGTH = 255

export const GitInfoErrorCode = {
  InvalidBranch: 'project.invalid_branch',
  CheckoutFailed: 'project.checkout_failed',
  BranchCreateFailed: 'project.branch_create_failed',
  PullFailed: 'project.pull_failed',
  PushFailed: 'project.push_failed',
} as const

/** 远端平台：GitHub、Gitee，或其它自建 / 私有 Git。 */
export type GitRemoteKind = 'github' | 'gitee' | 'git'

export interface ProjectGitInfo {
  readonly branch?: string
  readonly branches?: string[]
  readonly remote?: GitRemoteKind
  /** 远端主机名（例如 `github.com`）；本地路径远端没有主机名。 */
  readonly remoteHost?: string
}

function remoteHostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    // scp 形式（git@host:owner/repo.git）不是合法 URL。
    return /^[^@\s]+@([^:/\s]+)[:/]/.exec(url)?.[1] ?? ''
  }
}

/** 从 origin 的地址判断平台；识别不了主机名时归为私有 Git。 */
function parseRemote(url: string): { remote: GitRemoteKind; remoteHost?: string } | undefined {
  if (url === '') return undefined
  const lower = remoteHostOf(url).toLowerCase()
  if (lower === 'github.com' || lower.endsWith('.github.com')) {
    return { remote: 'github', remoteHost: 'github.com' }
  }
  if (lower === 'gitee.com' || lower.endsWith('.gitee.com')) {
    return { remote: 'gitee', remoteHost: 'gitee.com' }
  }
  return { remote: 'git', ...(lower === '' ? {} : { remoteHost: lower.slice(0, 255) }) }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) < 32) return true
  }
  return false
}

function validBranch(value: string): string | undefined {
  const branch = value.trim()
  if (branch === '' || branch === 'HEAD') return undefined
  if (branch.length > BRANCH_MAX_LENGTH || hasControlChars(branch) || branch.startsWith('-')) {
    return undefined
  }
  return branch
}

function parseBranches(stdout: string): string[] {
  const branches = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const branch = validBranch(line)
    if (branch !== undefined) branches.add(branch)
  }
  return [...branches]
}

/** Git 的说明：优先 `fatal:` / `error:` 行，没有时用第一行，避免把末尾的提示命令当成原因。 */
function failureReason(stderr: string, exitCode: number): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  const line = lines.find((item) => /^(fatal|error):/i.test(item)) ?? lines[0] ?? ''
  return line === '' ? `git exited with ${exitCode}` : line.slice(0, 400)
}

export async function readGitInfo(git: GitRunner, path: string): Promise<ProjectGitInfo> {
  try {
    const result = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path,
      allowFail: true,
    })
    if (result.code !== 0) return {}
    const branch = validBranch(result.stdout.toString('utf8'))
    if (branch === undefined) return {}
    const listed = await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: path,
      allowFail: true,
    })
    const origin = await git.run(['remote', 'get-url', 'origin'], { cwd: path, allowFail: true })
    const parsed =
      origin.code === 0 ? parseRemote(origin.stdout.toString('utf8').trim()) : undefined
    return {
      branch,
      ...(listed.code === 0 ? { branches: parseBranches(listed.stdout.toString('utf8')) } : {}),
      ...(parsed ?? {}),
    }
  } catch {
    return {}
  }
}

/** 切换到本地分支；失败时抛出带 Git 说明的 `project.checkout_failed`。 */
export async function checkoutGitBranch(
  git: GitRunner,
  path: string,
  value: string,
): Promise<ProjectGitInfo> {
  const branch = validBranch(value)
  if (branch === undefined) throw new RpcError(GitInfoErrorCode.InvalidBranch, { branch: value })
  const result = await git.run(['checkout', branch], { cwd: path, allowFail: true })
  if (result.code !== 0) {
    throw new RpcError(GitInfoErrorCode.CheckoutFailed, {
      reason: failureReason(result.stderr, result.code),
    })
  }
  return { branch }
}

/** 从当前分支新建本地分支并切换（`git checkout -b`）；失败时抛出 `project.branch_create_failed`。 */
export async function createGitBranch(
  git: GitRunner,
  path: string,
  value: string,
): Promise<ProjectGitInfo> {
  const branch = validBranch(value)
  if (branch === undefined) throw new RpcError(GitInfoErrorCode.InvalidBranch, { branch: value })
  const result = await git.run(['checkout', '-b', branch], { cwd: path, allowFail: true })
  if (result.code !== 0) {
    throw new RpcError(GitInfoErrorCode.BranchCreateFailed, {
      reason: failureReason(result.stderr, result.code),
    })
  }
  return { ...(await readGitInfo(git, path)), branch }
}

/** 拉取当前分支；只接受快进，失败时抛出带 Git 说明的 `project.pull_failed`。 */
export async function pullGitBranch(git: GitRunner, path: string): Promise<ProjectGitInfo> {
  const result = await git.run(['pull', '--ff-only'], { cwd: path, allowFail: true })
  if (result.code !== 0) {
    throw new RpcError(GitInfoErrorCode.PullFailed, {
      reason: failureReason(result.stderr, result.code),
    })
  }
  return readGitInfo(git, path)
}

/** 推送当前分支；失败（没有上游、认证、网络）时抛出带 Git 说明的 `project.push_failed`。 */
export async function pushGitBranch(git: GitRunner, path: string): Promise<ProjectGitInfo> {
  const result = await git.run(['push'], { cwd: path, allowFail: true })
  if (result.code !== 0) {
    throw new RpcError(GitInfoErrorCode.PushFailed, {
      reason: failureReason(result.stderr, result.code),
    })
  }
  return readGitInfo(git, path)
}
