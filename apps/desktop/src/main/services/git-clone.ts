/**
 * 新建工作空间时的 Git 克隆：只接受绝对父目录、单段目录名与普通远端地址。
 *
 * 与 LiveAgent 的做法一致，先在父目录下创建目标目录再在其中执行 `git clone -- <url> .`；
 * 失败时只删除本次创建的目标目录。Git 运行器由入口注入，沿用随包 MinGit 与隔离环境。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_NAME_MAX_LENGTH, RpcError } from '@cairn/protocol'
import type { GitRunner } from '@cairn/checkpoint'

export const ProjectCloneErrorCode = {
  InvalidPath: 'project.invalid_path',
  InvalidName: 'project.invalid_name',
  InvalidRemote: 'project.invalid_remote',
  TargetExists: 'project.clone_target_exists',
  GitUnavailable: 'project.git_unavailable',
  Failed: 'project.clone_failed',
} as const

export interface CloneRepositoryInput {
  readonly remoteUrl: string
  readonly parentPath: string
  readonly name: string
  readonly branch?: string | undefined
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function hasControlChars(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) < 32) return true
  }
  return false
}

/** 从 `https://host/team/repo.git` 或 `git@host:team/repo.git` 推导单段目录名。 */
export function workspaceNameFromRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const segment =
    value
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) ?? ''
  return segment.slice(0, PROJECT_NAME_MAX_LENGTH)
}

function validateName(value: string): string {
  const name = value.trim()
  if (name === '') throw new RpcError(ProjectCloneErrorCode.InvalidName)
  if (name.length > PROJECT_NAME_MAX_LENGTH) throw new RpcError(ProjectCloneErrorCode.InvalidName)
  if (name === '.' || name === '..') throw new RpcError(ProjectCloneErrorCode.InvalidName)
  if (/[\\/:*?"<>|]/.test(name) || hasControlChars(name)) {
    throw new RpcError(ProjectCloneErrorCode.InvalidName)
  }
  if (/[. ]$/.test(name) || WINDOWS_RESERVED.test(name)) {
    throw new RpcError(ProjectCloneErrorCode.InvalidName)
  }
  return name
}

function validateRemoteUrl(value: string): string {
  const remoteUrl = value.trim()
  if (remoteUrl === '' || remoteUrl.length > 4096 || hasControlChars(remoteUrl)) {
    throw new RpcError(ProjectCloneErrorCode.InvalidRemote)
  }
  // `ext::` 等 remote helper 会执行任意程序；与 LiveAgent 一样在入口直接拒绝。
  const scheme = /^[A-Za-z0-9+.-]*/.exec(remoteUrl)?.[0] ?? ''
  if (remoteUrl.slice(scheme.length).startsWith('::')) {
    throw new RpcError(ProjectCloneErrorCode.InvalidRemote)
  }
  return remoteUrl
}

function validateBranch(value: string | undefined): string | undefined {
  const branch = value?.trim()
  if (!branch) return undefined
  if (branch.length > 255 || hasControlChars(branch)) {
    throw new RpcError(ProjectCloneErrorCode.InvalidName)
  }
  return branch
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

export async function cloneGitRepository(
  git: GitRunner,
  input: CloneRepositoryInput,
): Promise<string> {
  const remoteUrl = validateRemoteUrl(input.remoteUrl)
  const name = validateName(input.name)
  const branch = validateBranch(input.branch)
  const parentPath = input.parentPath.trim()
  if (!path.isAbsolute(parentPath)) {
    throw new RpcError(ProjectCloneErrorCode.InvalidPath, { path: parentPath })
  }
  const parent = await fsp.realpath(parentPath).catch(() => {
    throw new RpcError(ProjectCloneErrorCode.InvalidPath, { path: parentPath })
  })
  const stat = await fsp.stat(parent).catch(() => undefined)
  if (!stat?.isDirectory()) {
    throw new RpcError(ProjectCloneErrorCode.InvalidPath, { path: parentPath })
  }
  const target = path.join(parent, name)
  try {
    await fsp.mkdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RpcError(ProjectCloneErrorCode.TargetExists, { path: target })
    }
    throw new RpcError(ProjectCloneErrorCode.Failed, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    const result = await git.run(
      ['clone', ...(branch === undefined ? [] : ['--branch', branch]), '--', remoteUrl, '.'],
      { cwd: target, allowFail: true },
    )
    if (result.code !== 0) {
      throw new RpcError(ProjectCloneErrorCode.Failed, {
        reason: failureReason(result.stderr, result.code),
      })
    }
    return target
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
    if (error instanceof RpcError) throw error
    const code = (error as { code?: string }).code
    if (code === 'checkpoint.git_unavailable') {
      throw new RpcError(ProjectCloneErrorCode.GitUnavailable)
    }
    throw new RpcError(ProjectCloneErrorCode.Failed, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
