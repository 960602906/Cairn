/**
 * 项目目录的 Git 摘要（输入框上方的当前目录 / 分支）。
 *
 * 读取当前分支与本地分支列表：不是 Git 仓库、Git 不可用、处于游离 HEAD 或输出异常时
 * 都返回空对象，界面只显示目录，不影响输入与发送。切换分支只接受本地分支；
 * 工作区有未提交改动时由 Git 决定是否允许切换。
 */
import { RpcError } from '@cairn/protocol'
import type { GitRunner } from '@cairn/checkpoint'

/** 与协议中的分支长度上限一致。 */
const BRANCH_MAX_LENGTH = 255

export const GitInfoErrorCode = {
  InvalidBranch: 'project.invalid_branch',
  CheckoutFailed: 'project.checkout_failed',
} as const

export interface ProjectGitInfo {
  readonly branch?: string
  readonly branches?: string[]
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

function failureReason(stderr: string, exitCode: number): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .at(-1) ?? ''
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
    return {
      branch,
      ...(listed.code === 0 ? { branches: parseBranches(listed.stdout.toString('utf8')) } : {}),
    }
  } catch {
    return {}
  }
}

/** 切换到本地分支；失败时抛出带 Git 错误首行的 `project.checkout_failed`。 */
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
