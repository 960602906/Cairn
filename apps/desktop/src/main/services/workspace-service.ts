/**
 * 隔离工作区（M4-08，ADR-0031，多 Agent 协作 §7）：写入类子 Agent 在应用数据目录中的独立副本中工作，
 * 结束后由改动集（M4-09）审阅与合并。
 *
 * - 基线是父工作区在委派时刻的检查点提交（影子仓库，ADR-0008）；优先用
 *   `git worktree add --detach` 从影子仓库检出，失败时从该提交导出文件（`read-tree` +
 *   `checkout-index`），项目本身不需要是 Git 仓库。
 * - 目录：`<worktrees>/<sessionId>/<runId>`；元数据放在同级的 `<runId>.workspace.json`，
 *   子运行自己的影子仓库放在 `<runId>.checkpoints.git`，都不会进入隔离工作区。
 * - `node_modules`、`.venv` 等依赖目录不复制，以只读目录联接（Windows junction）或目录符号链接共享。
 * - 并发上限与磁盘配额在创建时检查；清理失败（Windows 文件锁）保留元数据，下次启动 `sweep` 再试。
 * - 路径只在 `<worktrees>` 之内；run id / session id 只接受安全字符，避免 `..` 或绝对路径逃逸。
 */
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createGitRunner, isolatedGitEnv, type GitRunner } from '@cairn/checkpoint'

export const WorkspaceErrorCode = {
  /** 参数无效（id 不安全、路径不是绝对路径、提交 id 格式错误等）。 */
  Invalid: 'workspace.invalid',
  /** 超过并发上限或磁盘配额。 */
  Limit: 'workspace.limit',
  /** 创建或清理失败。 */
  Failed: 'workspace.failed',
} as const

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Readonly<Record<string, string | number>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WorkspaceError'
  }
}

export type IsolatedWorkspaceMode = 'worktree' | 'export'

export interface IsolatedWorkspaceCheckpoint {
  /** 子运行自己的影子仓库（检查点以隔离目录为根）。 */
  readonly gitDir: string
  readonly ref: string
}

export interface IsolatedWorkspace {
  readonly path: string
  readonly mode: IsolatedWorkspaceMode
  readonly sessionId: string
  readonly runId: string
  readonly baseCommit: string
  readonly createdAt: number
  /** 只读共享的依赖目录（相对隔离工作区，`/` 分隔）。 */
  readonly sharedDirs: readonly string[]
  readonly checkpoint: IsolatedWorkspaceCheckpoint
}

export interface CreateIsolatedWorkspaceInput {
  readonly projectPath: string
  /** 项目影子仓库目录（`<checkpoints>/<projectId>.git`）。 */
  readonly gitDir: string
  readonly baseCommit: string
  readonly sessionId: string
  readonly runId: string
}

export interface WorkspaceServiceOptions {
  /** `<appData>/Cairn/worktrees`。 */
  readonly root: string
  readonly gitBinary?: string
  /** 随包 MinGit 的受控环境变量（M5-03）。 */
  readonly gitEnv?: Readonly<Record<string, string>>
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 同时存在的隔离工作区上限，默认 8。 */
  readonly maxConcurrent?: number
  /** 隔离工作区的总磁盘上限，默认 10 GiB。 */
  readonly maxDiskBytes?: number
  /** 不复制、改为只读共享的依赖目录，默认 `node_modules` 与 `.venv`。 */
  readonly dependencyDirs?: readonly string[]
  /** 测试用：替换 Git 调用；参数是导出回退时使用的索引文件。 */
  readonly git?: (indexFile?: string) => GitRunner
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export interface WorkspaceService {
  createIsolated(input: CreateIsolatedWorkspaceInput): Promise<IsolatedWorkspace>
  cleanup(runId: string): Promise<boolean>
  list(): Promise<IsolatedWorkspace[]>
  /** 按子运行 id 找隔离工作区（M4-09：改动集按基线与隔离目录计算）。找不到时为 undefined。 */
  get(runId: string): Promise<IsolatedWorkspaceInfo | undefined>
  /** 启动时清扫上次留下的工作区（包括没有元数据的目录）。 */
  sweep(): Promise<number>
}

/** 隔离工作区加上它的影子仓库（M4-09：改动集需要按基线提交读出基线文件）。 */
export interface IsolatedWorkspaceInfo extends IsolatedWorkspace {
  /** 基线提交所在的影子仓库。 */
  readonly projectGitDir: string
}

interface WorkspaceMeta extends IsolatedWorkspace {
  /** 项目影子仓库：`git worktree remove` 与 `prune` 用它。 */
  readonly projectGitDir: string
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const META_SUFFIX = '.workspace.json'
const CHECKPOINT_SUFFIX = '.checkpoints.git'
const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_MAX_DISK_BYTES = 10 * 1024 * 1024 * 1024
export const DEFAULT_DEPENDENCY_DIRS: readonly string[] = ['node_modules', '.venv']

const isNotFound = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ||
  (error as NodeJS.ErrnoException).code === 'ENOTDIR'

const isSafeSharedDir = (dir: string) =>
  dir.length > 0 &&
  !dir.includes('\\') &&
  !dir.includes(':') &&
  !path.isAbsolute(dir) &&
  dir.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

/** `target` 是否严格位于 `root` 之内（不含 root 本身）。 */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function requireId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) {
    throw new WorkspaceError(WorkspaceErrorCode.Invalid, `invalid ${field}`, { field })
  }
  return value
}

function requireAbsolute(value: string, field: string): string {
  if (!path.isAbsolute(value)) {
    throw new WorkspaceError(WorkspaceErrorCode.Invalid, `${field} must be absolute`, { field })
  }
  return path.resolve(value)
}

/** Git 的 `--prefix` 需要 `/` 分隔并以 `/` 结尾。 */
const gitPrefix = (target: string) => `${target.split(path.sep).join('/')}/`

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** 目录大小；不跟随符号链接（依赖目录不重复计入）。 */
async function directorySize(root: string): Promise<number> {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) continue
      throw error
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        try {
          total += (await fsp.lstat(child)).size
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
    }
  }
  return total
}

export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  const root = requireAbsolute(options.root, 'root')
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const maxDiskBytes = options.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES
  const dependencyDirs = options.dependencyDirs ?? DEFAULT_DEPENDENCY_DIRS
  const now = options.now ?? Date.now
  const onError = (error: unknown) => options.onError?.(error)
  const baseEnv = isolatedGitEnv(
    options.env ?? process.env,
    path.join(root, 'no-global-config'),
    options.gitEnv,
  )
  const runnerFor = (indexFile?: string): GitRunner =>
    options.git
      ? options.git(indexFile)
      : createGitRunner({
          ...(options.gitBinary !== undefined ? { binary: options.gitBinary } : {}),
          env: indexFile === undefined ? baseEnv : { ...baseEnv, GIT_INDEX_FILE: indexFile },
        })
  const git = runnerFor()
  /** 已创建、尚未清理的工作区。 */
  const live = new Map<string, WorkspaceMeta>()
  const sizes = new Map<string, number>()
  const creating = new Set<string>()

  const metaFile = (sessionId: string, runId: string) =>
    path.join(root, sessionId, `${runId}${META_SUFFIX}`)

  const parseMeta = (raw: string, file: string): WorkspaceMeta | undefined => {
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>
      if (
        typeof parsed.path !== 'string' ||
        typeof parsed.mode !== 'string' ||
        (parsed.mode !== 'worktree' && parsed.mode !== 'export') ||
        typeof parsed.sessionId !== 'string' ||
        typeof parsed.runId !== 'string' ||
        typeof parsed.baseCommit !== 'string' ||
        typeof parsed.createdAt !== 'number' ||
        typeof parsed.projectGitDir !== 'string' ||
        !Array.isArray(parsed.sharedDirs) ||
        parsed.sharedDirs.some((dir) => typeof dir !== 'string') ||
        typeof parsed.checkpoint !== 'object' ||
        parsed.checkpoint === null ||
        typeof parsed.checkpoint.gitDir !== 'string' ||
        typeof parsed.checkpoint.ref !== 'string'
      ) {
        return undefined
      }
      if (
        !SAFE_ID.test(parsed.sessionId) ||
        !SAFE_ID.test(parsed.runId) ||
        !COMMIT.test(parsed.baseCommit) ||
        !Number.isFinite(parsed.createdAt) ||
        !path.isAbsolute(parsed.path) ||
        !path.isAbsolute(parsed.checkpoint.gitDir) ||
        !path.isAbsolute(parsed.projectGitDir) ||
        path.resolve(parsed.path) !== path.join(root, parsed.sessionId, parsed.runId) ||
        path.resolve(parsed.checkpoint.gitDir) !==
          path.join(root, parsed.sessionId, `${parsed.runId}${CHECKPOINT_SUFFIX}`) ||
        parsed.checkpoint.ref !== `refs/cairn/worktrees/${parsed.runId}` ||
        !parsed.sharedDirs.every(isSafeSharedDir)
      ) {
        return undefined
      }
      return {
        path: path.join(root, parsed.sessionId, parsed.runId),
        mode: parsed.mode,
        sessionId: parsed.sessionId,
        runId: parsed.runId,
        baseCommit: parsed.baseCommit,
        createdAt: parsed.createdAt,
        sharedDirs: parsed.sharedDirs as string[],
        checkpoint: {
          gitDir: path.join(root, parsed.sessionId, `${parsed.runId}${CHECKPOINT_SUFFIX}`),
          ref: parsed.checkpoint.ref,
        },
        projectGitDir: path.resolve(parsed.projectGitDir),
      }
    } catch {
      onError(new WorkspaceError(WorkspaceErrorCode.Failed, `invalid workspace metadata: ${file}`))
      return undefined
    }
  }

  const readMeta = async (file: string): Promise<WorkspaceMeta | undefined> => {
    try {
      return parseMeta(await fsp.readFile(file, 'utf8'), file)
    } catch (error) {
      if (isNotFound(error)) return undefined
      onError(error)
      return undefined
    }
  }

  const findMeta = async (runId: string): Promise<WorkspaceMeta | undefined> => {
    const known = live.get(runId)
    if (known) return known
    let sessions: Dirent[]
    try {
      sessions = await fsp.readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !SAFE_ID.test(session.name)) continue
      const meta = await readMeta(metaFile(session.name, runId))
      if (meta) {
        live.set(runId, meta)
        return meta
      }
    }
    return undefined
  }

  const allMeta = async (): Promise<WorkspaceMeta[]> => {
    let sessions: Dirent[]
    try {
      sessions = await fsp.readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const out: WorkspaceMeta[] = []
    for (const session of sessions) {
      if (!session.isDirectory() || !SAFE_ID.test(session.name)) continue
      let entries: Dirent[]
      try {
        entries = await fsp.readdir(path.join(root, session.name), { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(META_SUFFIX)) continue
        const meta = await readMeta(path.join(root, session.name, entry.name))
        if (meta) {
          live.set(meta.runId, meta)
          out.push(meta)
        }
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  const totalSize = () => [...sizes.values()].reduce((sum, size) => sum + size, 0)

  const removePath = async (target: string) => {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  /** 从影子提交导出文件；导出式工作区没有 Git 索引，M4-09 用内容比较生成改动集。 */
  const exportCommit = async (
    gitDir: string,
    commit: string,
    target: string,
    sessionDir: string,
    runId: string,
    projectPath: string,
  ) => {
    const indexFile = path.join(sessionDir, `${runId}.export-index`)
    const runner = runnerFor(indexFile)
    await removePath(indexFile)
    try {
      await runner.run(['--git-dir', gitDir, 'read-tree', commit], { cwd: projectPath })
      await fsp.mkdir(target, { recursive: true })
      await runner.run(
        [
          '--git-dir',
          gitDir,
          '--work-tree',
          target,
          'checkout-index',
          '-a',
          '-f',
          `--prefix=${gitPrefix(target)}`,
        ],
        { cwd: projectPath },
      )
    } finally {
      await removePath(indexFile)
    }
  }

  /** 依赖目录以只读目录联接 / 符号链接共享，不复制。失败只记录，不影响工作区创建。 */
  const linkDependencies = async (projectPath: string, target: string): Promise<string[]> => {
    const linked: string[] = []
    for (const dir of dependencyDirs) {
      const source = path.join(projectPath, dir)
      const destination = path.join(target, dir)
      try {
        const stat = await fsp.lstat(source)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        if (await pathExists(destination)) continue
        await fsp.mkdir(path.dirname(destination), { recursive: true })
        await fsp.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
        linked.push(dir.split(path.sep).join('/'))
      } catch (error) {
        onError(error)
      }
    }
    return linked
  }

  const cleanup = async (runId: string): Promise<boolean> => {
    if (!SAFE_ID.test(runId)) return false
    const meta = await findMeta(runId)
    if (!meta) return false
    let cleaned = true
    if (meta.mode === 'worktree') {
      try {
        await git.run(
          ['--git-dir', meta.projectGitDir, 'worktree', 'remove', '--force', meta.path],
          { cwd: meta.path },
        )
      } catch (error) {
        // 目录可能已经被手动删除，或 Windows 上有文件锁；下面仍尝试直接删除。
        onError(error)
      }
    }
    try {
      await removePath(meta.path)
    } catch (error) {
      onError(error)
      cleaned = false
    }
    try {
      await removePath(meta.checkpoint.gitDir)
    } catch (error) {
      onError(error)
      cleaned = false
    }
    if (meta.mode === 'worktree') {
      try {
        await git.run(['--git-dir', meta.projectGitDir, 'worktree', 'prune'], {
          cwd: meta.projectGitDir,
        })
      } catch (error) {
        onError(error)
      }
    }
    if (cleaned) {
      try {
        await removePath(metaFile(meta.sessionId, meta.runId))
      } catch (error) {
        onError(error)
        cleaned = false
      }
    }
    if (cleaned) {
      live.delete(runId)
      sizes.delete(runId)
    }
    return cleaned
  }

  return {
    async createIsolated(input) {
      const projectPath = requireAbsolute(input.projectPath, 'projectPath')
      const gitDir = requireAbsolute(input.gitDir, 'gitDir')
      const sessionId = requireId(input.sessionId, 'sessionId')
      const runId = requireId(input.runId, 'runId')
      if (!COMMIT.test(input.baseCommit)) {
        throw new WorkspaceError(WorkspaceErrorCode.Invalid, 'invalid base commit', {
          field: 'baseCommit',
        })
      }
      if (live.has(runId) || creating.has(runId)) {
        throw new WorkspaceError(WorkspaceErrorCode.Invalid, 'workspace already exists', {
          runId,
        })
      }
      if (live.size + creating.size >= maxConcurrent) {
        throw new WorkspaceError(WorkspaceErrorCode.Limit, 'too many isolated workspaces', {
          maxConcurrent,
        })
      }
      const before = totalSize()
      if (before >= maxDiskBytes) {
        throw new WorkspaceError(WorkspaceErrorCode.Limit, 'workspace disk quota exceeded', {
          maxDiskBytes,
        })
      }
      creating.add(runId)
      try {
        const sessionDir = path.join(root, sessionId)
        await fsp.mkdir(sessionDir, { recursive: true })
        const target = path.join(sessionDir, runId)
        await removePath(target)
        let mode: IsolatedWorkspaceMode = 'worktree'
        try {
          await git.run(
            ['--git-dir', gitDir, 'worktree', 'add', '--detach', target, input.baseCommit],
            { cwd: projectPath },
          )
        } catch (error) {
          onError(error)
          await removePath(target)
          mode = 'export'
          try {
            await exportCommit(gitDir, input.baseCommit, target, sessionDir, runId, projectPath)
          } catch (exportError) {
            await removePath(target)
            throw new WorkspaceError(
              WorkspaceErrorCode.Failed,
              'cannot create isolated workspace',
              { runId },
              { cause: exportError },
            )
          }
        }
        const sharedDirs = await linkDependencies(projectPath, target)
        const meta: WorkspaceMeta = {
          path: target,
          mode,
          sessionId,
          runId,
          baseCommit: input.baseCommit,
          createdAt: now(),
          sharedDirs,
          checkpoint: {
            gitDir: path.join(sessionDir, `${runId}${CHECKPOINT_SUFFIX}`),
            ref: `refs/cairn/worktrees/${runId}`,
          },
          projectGitDir: gitDir,
        }
        await fsp.writeFile(metaFile(sessionId, runId), JSON.stringify(meta))
        live.set(runId, meta)
        const size = await directorySize(target)
        sizes.set(runId, size)
        if (before + size > maxDiskBytes) {
          await cleanup(runId)
          throw new WorkspaceError(WorkspaceErrorCode.Limit, 'workspace disk quota exceeded', {
            maxDiskBytes,
          })
        }
        return meta
      } finally {
        creating.delete(runId)
      }
    },

    cleanup,

    async get(runId) {
      const meta = await findMeta(runId)
      return meta && { ...meta, projectGitDir: meta.projectGitDir }
    },

    async list() {
      return allMeta()
    },

    async sweep() {
      let cleaned = 0
      for (const meta of await allMeta()) {
        if (await cleanup(meta.runId)) cleaned += 1
      }
      let sessions: Dirent[]
      try {
        sessions = await fsp.readdir(root, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) return cleaned
        throw error
      }
      const known = new Set<string>()
      for (const meta of live.values()) {
        known.add(path.resolve(meta.path))
        known.add(path.resolve(meta.checkpoint.gitDir))
      }
      for (const session of sessions) {
        if (!session.isDirectory() || !SAFE_ID.test(session.name)) continue
        const sessionDir = path.join(root, session.name)
        let entries: Dirent[]
        try {
          entries = await fsp.readdir(sessionDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const target = path.resolve(path.join(sessionDir, entry.name))
          if (known.has(target) || !isInside(root, target)) continue
          try {
            await removePath(target)
            cleaned += 1
          } catch (error) {
            onError(error)
          }
        }
      }
      return cleaned
    },
  }
}
