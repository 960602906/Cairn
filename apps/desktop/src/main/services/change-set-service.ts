/**
 * 改动集（M4-09，ADR-0031，多 Agent 协作 §7.3）：把隔离工作区里的改动变成可审阅、可接受、可拒绝、
 * 可回退的改动集。
 *
 * - **生成**（宿主经 `host.changeset.create`）：子运行结束后，以隔离工作区创建时的基线提交为准，
 *   与隔离目录的实际内容比较，得到文件级的 added / modified / removed。文本文件用 jsdiff 生成
 *   unified diff 与增删行数；二进制与超过上限的文件只记录元数据（`binary` / `large`），没有 patch。
 *   基线内容与子运行版本都写入 blob 存储，因此隔离工作区清理之后仍能合并。
 * - **合并**（`changeset.apply`）：先为主工作区建检查点（原因 `before_merge`），恢复它即可回退；
 *   主工作区在基线之后改过同一路径时标记冲突，不写入。`paths` 可以只合并部分文件（按文件接受）。
 * - **冲突**（`changeset.resolveConflict`）：保留主工作区、采用子运行版本，或交给用户手动处理。
 * - **拒绝**（`changeset.reject`）：整体或按文件拒绝，不写主工作区。
 *
 * 路径都经过 `createPathResolver` 校验，不能逃出主工作区；隔离目录里的符号链接（依赖目录）与
 * `.git` 不参与比较。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch, diffLines } from 'diff'
import {
  RpcError,
  type ChangeSetFileInfo,
  type ChangeSetInfo,
  type ChangeSetSummary,
} from '@cairn/protocol'
import type { ChangeSetFileRecord, ChangeSetRecord, Storage } from '@cairn/storage'
import type { GitRunner } from '@cairn/checkpoint'
import { createPathResolver, decodeFile } from '@cairn/tools'
import { sha256, type BlobStore } from './blob-store.js'
import type { SessionEventService } from './event-service.js'
import type { WorkspaceService } from './workspace-service.js'

export const ChangeSetErrorCode = {
  /** 会话或改动集不存在，或改动集不属于该会话。 */
  NotFound: 'changeset.not_found',
  /** 改动集已经合并或拒绝，不能再改。 */
  NotPending: 'changeset.not_pending',
  /** 基线或子运行版本的内容在 blob 存储中找不到。 */
  BlobMissing: 'changeset.blob_missing',
  /** 读取隔离工作区、基线提交或写主工作区失败。 */
  Failed: 'changeset.failed',
  /** 会话正在运行或正在撤销 / 恢复，暂不能合并。 */
  Busy: 'run.busy',
} as const

/** 超过这个大小的文本文件不生成 diff，只记录元数据（仍可自动合并）。 */
export const CHANGE_SET_MAX_PATCH_BYTES = 1024 * 1024
/**
 * 超过这个大小的文件不读取内容，只记录元数据。这类文件没有 blob 引用，不能自动写入主工作区：
 * 用户在编辑器里手动处理后，用 `changeset.apply` 明确点名这些路径即可标记为接受。
 */
export const CHANGE_SET_MAX_FILE_BYTES = 10 * 1024 * 1024

export interface ChangeSetServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'changeSets' | 'transaction'>
  readonly blobs: BlobStore
  readonly events: Pick<SessionEventService, 'publish'>
  readonly workspaces: Pick<WorkspaceService, 'get'>
  /** 在主工作区创建合并前的检查点（`checkpoint.created`，原因 `before_merge`）。 */
  readonly checkpoints: { create(sessionId: string): Promise<{ checkpointId: string }> }
  /** 读取基线提交（`ls-tree` / `cat-file`）。 */
  readonly git: GitRunner
  /** 会话是否正在运行、撤销改动或恢复检查点。 */
  readonly isBusy?: (sessionId: string) => boolean
  readonly now?: () => number
  readonly createId?: () => string
  readonly onError?: (error: unknown) => void
}

export interface ChangeSetService {
  /** 计算并保存一个改动集（子运行结束后、清理隔离工作区之前）。 */
  create(params: { sessionId: string; runId: string; parentRunId?: string }): Promise<{
    changeSetId: string
    files: { path: string; added: number; removed: number }[]
  }>
  list(params: { sessionId: string }): { changeSets: ChangeSetSummary[] }
  get(params: { sessionId: string; changeSetId: string }): { changeSet: ChangeSetInfo }
  apply(params: {
    sessionId: string
    changeSetId: string
    paths?: readonly string[] | undefined
  }): Promise<{ changeSet: ChangeSetInfo; applied: string[]; conflicts: string[] }>
  reject(params: {
    sessionId: string
    changeSetId: string
    paths?: readonly string[] | undefined
  }): Promise<{ changeSet: ChangeSetInfo }>
  resolveConflict(params: {
    sessionId: string
    changeSetId: string
    path: string
    resolution: 'keep-main' | 'take-child' | 'manual'
  }): Promise<{ changeSet: ChangeSetInfo }>
}

interface BaselineEntry {
  /** Git 中的路径。 */
  readonly path: string
  /** 基线内容的 blob id。 */
  readonly oid: string
}

interface WorkspaceFile {
  /** 相对隔离目录的路径，`/` 分隔。 */
  readonly path: string
  readonly absolute: string
  readonly size: number
}

interface ComputedFile {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'removed'
  readonly added: number
  readonly removed: number
  readonly patch?: string
  readonly binary: boolean
  readonly large: boolean
  /** 内容没有读入内存（超过上限）：需要用户手动处理后才能标记为接受。 */
  readonly manual: boolean
  readonly baseHash?: string
  readonly contentHash?: string
}

const isNotFound = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ||
  (error as NodeJS.ErrnoException).code === 'ENOTDIR'

/** Git blob 的对象 id：`sha1("blob <size>\0" + content)`。 */
function gitBlobOid(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.length}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/** 路径比较用小写（Windows 与 macOS 默认大小写不敏感），避免大小写变化被算成删除 + 新增。 */
const fold = (value: string) => value.toLowerCase()

export function createChangeSetService(options: ChangeSetServiceOptions): ChangeSetService {
  const { storage, blobs, events } = options
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const onError = (error: unknown) => options.onError?.(error)

  const requireSession = (sessionId: string) => {
    const session = storage.sessions.get(sessionId)
    if (!session) throw new RpcError(ChangeSetErrorCode.NotFound, { sessionId })
    return session
  }

  const requireChangeSet = (sessionId: string, changeSetId: string): ChangeSetRecord => {
    const record = storage.changeSets.get(changeSetId)
    if (record?.sessionId !== sessionId) {
      throw new RpcError(ChangeSetErrorCode.NotFound, { sessionId, changeSetId })
    }
    return record
  }

  const toFileInfo = (file: ChangeSetFileRecord): ChangeSetFileInfo => ({
    path: file.path,
    status: file.status,
    kind: file.kind,
    added: file.added,
    removed: file.removed,
    ...(file.patch === undefined ? {} : { patch: file.patch }),
    binary: file.binary,
    large: file.large,
  })

  const toInfo = (record: ChangeSetRecord): ChangeSetInfo => {
    const files = storage.changeSets.listFiles(record.changeSetId)
    return {
      changeSetId: record.changeSetId,
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.parentRunId === undefined ? {} : { parentRunId: record.parentRunId }),
      baseCommit: record.baseCommit,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.mergedAt === undefined ? {} : { mergedAt: record.mergedAt }),
      ...(record.checkpointCommit === undefined
        ? {}
        : { checkpointCommit: record.checkpointCommit }),
      files: files.map(toFileInfo),
      conflicts: files.filter((file) => file.status === 'conflict').length,
    }
  }

  const toSummary = (record: ChangeSetRecord): ChangeSetSummary => {
    const files = storage.changeSets.listFiles(record.changeSetId)
    return {
      changeSetId: record.changeSetId,
      runId: record.runId,
      ...(record.parentRunId === undefined ? {} : { parentRunId: record.parentRunId }),
      status: record.status,
      createdAt: record.createdAt,
      ...(record.mergedAt === undefined ? {} : { mergedAt: record.mergedAt }),
      files: files.length,
      conflicts: files.filter((file) => file.status === 'conflict').length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    }
  }

  /** 基线提交里的全部文件：路径（小写）→ 路径与 blob id。 */
  async function readBaseline(gitDir: string, commit: string): Promise<Map<string, BaselineEntry>> {
    const result = await options.git.run(
      ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--full-tree', commit],
      { allowFail: true },
    )
    if (result.code !== 0) {
      throw new RpcError(ChangeSetErrorCode.Failed, { reason: 'ls-tree', code: result.code })
    }
    const entries = new Map<string, BaselineEntry>()
    for (const record of result.stdout.toString('utf8').split('\0')) {
      if (record === '') continue
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, type, oid] = record.slice(0, tab).split(' ')
      // 只看普通文件：子模块（commit）与符号链接（mode 120000）都不参与比较。
      if (type !== 'blob' || oid === undefined || mode === '120000') continue
      const filePath = record.slice(tab + 1)
      entries.set(fold(filePath), { path: filePath, oid })
    }
    return entries
  }

  /** 基线文件的大小（`cat-file -s`），用于判断是否超过读取上限。 */
  async function baselineBlobSize(gitDir: string, oid: string): Promise<number | undefined> {
    const result = await options.git.run(['--git-dir', gitDir, 'cat-file', '-s', oid], {
      allowFail: true,
    })
    if (result.code !== 0) return undefined
    const size = Number.parseInt(result.stdout.toString('utf8').trim(), 10)
    return Number.isFinite(size) ? size : undefined
  }

  /** 隔离目录里的文件；跳过 `.git`、符号链接 / 目录联接（依赖目录）与共享目录。 */
  async function scanWorkspace(
    root: string,
    sharedDirs: readonly string[],
  ): Promise<WorkspaceFile[]> {
    const shared = new Set(sharedDirs)
    const out: WorkspaceFile[] = []
    const walk = async (dir: string, relative: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) return
        throw error
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue
        if (entry.isSymbolicLink()) continue
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
        if (shared.has(childRelative)) continue
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute, childRelative)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.lstat(absolute)
        out.push({ path: childRelative, absolute, size: stat.size })
      }
    }
    await walk(root, '')
    return out
  }

  /** 基线文件的内容。 */
  async function readBaselineBlob(gitDir: string, oid: string): Promise<Buffer | undefined> {
    const result = await options.git.run(['--git-dir', gitDir, 'cat-file', 'blob', oid], {
      allowFail: true,
    })
    return result.code === 0 ? result.stdout : undefined
  }

  /** 文本内容；二进制返回 undefined。 */
  function textOf(content: Buffer): string | undefined {
    const decoded = decodeFile(content)
    return decoded.binary ? undefined : decoded.text
  }

  /**
   * 计算一个改动文件的 patch、行数与 blob 引用。
   * `base` 是基线内容（新增文件为 undefined），`next` 是子运行版本（删除文件为 undefined）。
   * `oversized` 表示内容超过读取上限、没有放进内存：只记录元数据，不写 blob 引用。
   */
  async function computeFile(
    filePath: string,
    kind: ComputedFile['kind'],
    base: Buffer | undefined,
    next: Buffer | undefined,
    oversized = false,
  ): Promise<ComputedFile> {
    if (oversized) {
      return {
        path: filePath,
        kind,
        added: 0,
        removed: 0,
        binary: false,
        large: true,
        manual: true,
      }
    }
    const baseHash = base === undefined ? undefined : await blobs.put(base)
    const contentHash = next === undefined ? undefined : await blobs.put(next)
    const beforeText = base === undefined ? '' : textOf(base)
    const afterText = next === undefined ? '' : textOf(next)
    if (beforeText === undefined || afterText === undefined) {
      // 二进制文件：只记录元数据，不生成 diff。
      return {
        path: filePath,
        kind,
        added: 0,
        removed: 0,
        binary: true,
        large: false,
        manual: false,
        ...(baseHash === undefined ? {} : { baseHash }),
        ...(contentHash === undefined ? {} : { contentHash }),
      }
    }
    let added = 0
    let removed = 0
    for (const part of diffLines(beforeText, afterText)) {
      if (part.added) added += part.count
      else if (part.removed) removed += part.count
    }
    const large = Math.max(base?.length ?? 0, next?.length ?? 0) > CHANGE_SET_MAX_PATCH_BYTES
    return {
      path: filePath,
      kind,
      added,
      removed,
      ...(large
        ? {}
        : {
            patch: createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, beforeText, afterText),
          }),
      binary: false,
      large,
      manual: false,
      ...(baseHash === undefined ? {} : { baseHash }),
      ...(contentHash === undefined ? {} : { contentHash }),
    }
  }

  async function computeChanges(input: {
    gitDir: string
    baseCommit: string
    workspacePath: string
    sharedDirs: readonly string[]
  }): Promise<ComputedFile[]> {
    const baseline = await readBaseline(input.gitDir, input.baseCommit)
    const workspace = await scanWorkspace(input.workspacePath, input.sharedDirs)
    const consumed = new Set<string>()
    const changed: ComputedFile[] = []
    for (const file of workspace) {
      const key = fold(file.path)
      const entry = baseline.get(key)
      const workspaceTooLarge = file.size > CHANGE_SET_MAX_FILE_BYTES
      if (entry === undefined) {
        const content = workspaceTooLarge ? undefined : await fs.readFile(file.absolute)
        changed.push(await computeFile(file.path, 'added', undefined, content, workspaceTooLarge))
        continue
      }
      consumed.add(key)
      const baseSize = await baselineBlobSize(input.gitDir, entry.oid)
      const baseTooLarge = baseSize !== undefined && baseSize > CHANGE_SET_MAX_FILE_BYTES
      const base = baseTooLarge ? undefined : await readBaselineBlob(input.gitDir, entry.oid)
      const content = workspaceTooLarge ? undefined : await fs.readFile(file.absolute)
      const tooLarge = workspaceTooLarge || baseTooLarge
      if (entry.path !== file.path) {
        // 大小写不同（重命名）：基线的旧路径记删除，工作区的新路径记新增。
        changed.push(await computeFile(entry.path, 'removed', base, undefined, base === undefined))
        changed.push(await computeFile(file.path, 'added', undefined, content, tooLarge))
        continue
      }
      if (base === undefined && !baseTooLarge) {
        // 基线内容读不出来（对象缺失）：当作新增，避免丢掉子运行的工作。
        changed.push(await computeFile(file.path, 'added', undefined, content))
        continue
      }
      if (content !== undefined && gitBlobOid(content) === entry.oid) continue
      changed.push(await computeFile(file.path, 'modified', base, content, tooLarge))
    }
    for (const [key, entry] of baseline) {
      if (consumed.has(key)) continue
      const baseSize = await baselineBlobSize(input.gitDir, entry.oid)
      const baseTooLarge = baseSize !== undefined && baseSize > CHANGE_SET_MAX_FILE_BYTES
      const base = baseTooLarge ? undefined : await readBaselineBlob(input.gitDir, entry.oid)
      if (base === undefined && !baseTooLarge) continue
      changed.push(await computeFile(entry.path, 'removed', base, undefined, base === undefined))
    }
    return changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** 冲突：主工作区在基线之后改过这个路径。新增文件只要已存在就冲突。 */
  function conflictsWith(file: ChangeSetFileRecord, currentHash: string | undefined): boolean {
    if (file.kind === 'added') return currentHash !== undefined
    if (file.kind === 'modified') return currentHash !== file.baseHash
    return currentHash !== undefined && currentHash !== file.baseHash
  }

  /**
   * 收尾：没有待处理的文件时定下改动集的最终状态。
   * 有接受的文件就是 `applied`，否则是 `rejected`；还有待处理或冲突的文件时保持 `pending`。
   */
  function finalize(changeSetId: string): ChangeSetRecord {
    const files = storage.changeSets.listFiles(changeSetId)
    const unresolved = files.some(
      (file) => file.status === 'pending' || file.status === 'conflict' || file.status === 'manual',
    )
    if (unresolved) return storage.changeSets.get(changeSetId)!
    // 空改动集没有要合并的内容：应用它即视为完成。
    const status =
      files.length === 0 || files.some((file) => file.status === 'accepted')
        ? 'applied'
        : 'rejected'
    const record = storage.changeSets.get(changeSetId)!
    return record.status === 'pending' ? storage.changeSets.setStatus(changeSetId, status) : record
  }

  /** 把子运行版本写进主工作区（删除文件时直接删）。 */
  async function writeToWorkspace(workspacePath: string, file: ChangeSetFileRecord): Promise<void> {
    const resolution = await createPathResolver(workspacePath)(file.path)
    if (!resolution.ok) throw new RpcError(resolution.code, { path: file.path })
    const { absolute } = resolution.path
    try {
      if (file.kind === 'removed') {
        await removeExact(absolute)
        return
      }
      if (file.contentHash === undefined) {
        throw new RpcError(ChangeSetErrorCode.BlobMissing, { path: file.path })
      }
      const content = await blobs.get(file.contentHash)
      if (!content) throw new RpcError(ChangeSetErrorCode.BlobMissing, { path: file.path })
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, content)
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError(ChangeSetErrorCode.Failed, {
        path: file.path,
        cause: (error as NodeJS.ErrnoException).code ?? 'unknown',
      })
    }
  }

  /**
   * 按目录里的实际大小写删除：大小写不敏感的文件系统上，旧路径 `a.ts` 可能已经被子运行改名为
   * `A.ts`，这时不能把新文件一起删掉。
   */
  async function removeExact(absolute: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(path.dirname(absolute))
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    if (!entries.includes(path.basename(absolute))) return
    await fs.rm(absolute, { force: true })
  }

  const publish = (
    record: ChangeSetRecord,
    type: 'changeset.applied' | 'changeset.rejected' | 'changeset.conflict',
    payload: Record<string, unknown>,
  ) =>
    events.publish([
      {
        v: 1,
        sessionId: record.sessionId,
        runId: record.parentRunId ?? record.sessionId,
        ts: now(),
        type,
        payload,
      } as never,
    ])

  return {
    async create({ sessionId, runId, parentRunId }) {
      requireSession(sessionId)
      const workspace = await options.workspaces.get(runId)
      if (!workspace || workspace.sessionId !== sessionId) {
        throw new RpcError(ChangeSetErrorCode.NotFound, { runId })
      }
      let files: ComputedFile[]
      try {
        files = await computeChanges({
          gitDir: workspace.projectGitDir,
          baseCommit: workspace.baseCommit,
          workspacePath: workspace.path,
          sharedDirs: workspace.sharedDirs,
        })
      } catch (error) {
        if (error instanceof RpcError) throw error
        onError(error)
        throw new RpcError(ChangeSetErrorCode.Failed, { runId })
      }
      const changeSetId = createId()
      storage.transaction(() => {
        storage.changeSets.create({
          changeSetId,
          sessionId,
          runId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          baseCommit: workspace.baseCommit,
          gitDir: workspace.projectGitDir,
          workspacePath: workspace.path,
        })
        for (const file of files) {
          storage.changeSets.addFile({
            changeSetId,
            path: file.path,
            kind: file.kind,
            added: file.added,
            removed: file.removed,
            ...(file.patch === undefined ? {} : { patch: file.patch }),
            binary: file.binary,
            large: file.large,
            ...(file.baseHash === undefined ? {} : { baseHash: file.baseHash }),
            ...(file.contentHash === undefined ? {} : { contentHash: file.contentHash }),
          })
          if (file.manual) {
            // 超过读取上限的文件没有内容，不能自动写入主工作区。
            storage.changeSets.setFileStatus(changeSetId, file.path, 'manual')
          }
        }
      })
      events.publish([
        {
          v: 1,
          sessionId,
          runId: parentRunId ?? sessionId,
          ts: now(),
          type: 'changeset.created',
          payload: {
            changeSetId,
            childRunId: runId,
            files: files.length,
            added: files.reduce((sum, file) => sum + file.added, 0),
            removed: files.reduce((sum, file) => sum + file.removed, 0),
          },
        },
      ])
      return {
        changeSetId,
        files: files.map((file) => ({
          path: file.path,
          added: file.added,
          removed: file.removed,
        })),
      }
    },

    list({ sessionId }) {
      requireSession(sessionId)
      return { changeSets: storage.changeSets.listBySession(sessionId).map(toSummary) }
    },

    get({ sessionId, changeSetId }) {
      requireSession(sessionId)
      return { changeSet: toInfo(requireChangeSet(sessionId, changeSetId)) }
    },

    async apply({ sessionId, changeSetId, paths }) {
      const session = requireSession(sessionId)
      const record = requireChangeSet(sessionId, changeSetId)
      if (record.status !== 'pending') {
        throw new RpcError(ChangeSetErrorCode.NotPending, { changeSetId })
      }
      if (options.isBusy?.(sessionId)) throw new RpcError(ChangeSetErrorCode.Busy, { sessionId })
      const files = storage.changeSets.listFiles(changeSetId)
      const wanted = paths === undefined ? undefined : new Set(paths)
      if (wanted) {
        for (const filePath of wanted) {
          if (!files.some((file) => file.path === filePath)) {
            throw new RpcError(ChangeSetErrorCode.NotFound, { changeSetId, path: filePath })
          }
        }
      }
      const targets = files.filter((file) =>
        wanted === undefined
          ? file.status === 'pending'
          : wanted.has(file.path) && (file.status === 'pending' || file.status === 'manual'),
      )
      if (targets.length === 0) {
        finalize(changeSetId)
        return {
          changeSet: toInfo(storage.changeSets.get(changeSetId)!),
          applied: [],
          conflicts: [],
        }
      }
      const resolve = createPathResolver(session.workspacePath)
      const conflicts: ChangeSetFileRecord[] = []
      const writable: ChangeSetFileRecord[] = []
      /** 用户已在编辑器里手动处理过的文件：只标记接受，不写工作区。 */
      const manual = targets.filter((file) => file.status === 'manual')
      for (const file of targets.filter((item) => item.status === 'pending')) {
        const resolution = await resolve(file.path)
        if (!resolution.ok) throw new RpcError(resolution.code, { path: file.path })
        let currentHash: string | undefined
        try {
          currentHash = sha256(await fs.readFile(resolution.path.absolute))
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
        if (conflictsWith(file, currentHash)) conflicts.push(file)
        else writable.push(file)
      }
      let checkpointCommit: string | undefined
      if (writable.length > 0) {
        // 先建检查点：恢复它就能撤销这次合并。
        checkpointCommit = (await options.checkpoints.create(sessionId)).checkpointId
        storage.changeSets.setCheckpointCommit(changeSetId, checkpointCommit)
      }
      const applied: string[] = []
      for (const file of writable) {
        await writeToWorkspace(session.workspacePath, file)
        storage.changeSets.setFileStatus(changeSetId, file.path, 'accepted')
        applied.push(file.path)
      }
      for (const file of manual) {
        storage.changeSets.setFileStatus(changeSetId, file.path, 'accepted')
        applied.push(file.path)
      }
      for (const file of conflicts) {
        storage.changeSets.setFileStatus(changeSetId, file.path, 'conflict')
        publish(record, 'changeset.conflict', {
          changeSetId,
          path: file.path,
          resolution: 'pending',
        })
      }
      if (applied.length > 0) {
        publish(record, 'changeset.applied', {
          changeSetId,
          paths: applied,
          ...(checkpointCommit === undefined ? {} : { checkpointCommit }),
        })
      }
      finalize(changeSetId)
      return {
        changeSet: toInfo(storage.changeSets.get(changeSetId)!),
        applied,
        conflicts: conflicts.map((file) => file.path),
      }
    },

    async reject({ sessionId, changeSetId, paths }) {
      requireSession(sessionId)
      const record = requireChangeSet(sessionId, changeSetId)
      if (record.status !== 'pending') {
        throw new RpcError(ChangeSetErrorCode.NotPending, { changeSetId })
      }
      const files = storage.changeSets.listFiles(changeSetId)
      if (paths === undefined) {
        storage.transaction(() => {
          for (const file of files) {
            storage.changeSets.setFileStatus(changeSetId, file.path, 'rejected')
          }
          storage.changeSets.setStatus(changeSetId, 'rejected')
        })
        publish(record, 'changeset.rejected', { changeSetId })
        return { changeSet: toInfo(storage.changeSets.get(changeSetId)!) }
      }
      for (const filePath of new Set(paths)) {
        if (!files.some((file) => file.path === filePath)) {
          throw new RpcError(ChangeSetErrorCode.NotFound, { changeSetId, path: filePath })
        }
        storage.changeSets.setFileStatus(changeSetId, filePath, 'rejected')
      }
      finalize(changeSetId)
      return { changeSet: toInfo(storage.changeSets.get(changeSetId)!) }
    },

    async resolveConflict({ sessionId, changeSetId, path: filePath, resolution }) {
      const session = requireSession(sessionId)
      const record = requireChangeSet(sessionId, changeSetId)
      if (record.status !== 'pending') {
        throw new RpcError(ChangeSetErrorCode.NotPending, { changeSetId })
      }
      const file = storage.changeSets.listFiles(changeSetId).find((item) => item.path === filePath)
      if (!file) throw new RpcError(ChangeSetErrorCode.NotFound, { changeSetId, path: filePath })
      if (resolution === 'manual') {
        storage.changeSets.setFileStatus(changeSetId, filePath, 'manual')
        publish(record, 'changeset.conflict', { changeSetId, path: filePath, resolution: 'manual' })
        finalize(changeSetId)
        return { changeSet: toInfo(storage.changeSets.get(changeSetId)!) }
      }
      if (resolution === 'keep-main') {
        storage.changeSets.setFileStatus(changeSetId, filePath, 'rejected')
        publish(record, 'changeset.conflict', {
          changeSetId,
          path: filePath,
          resolution: 'keep-main',
        })
        finalize(changeSetId)
        return { changeSet: toInfo(storage.changeSets.get(changeSetId)!) }
      }
      if (options.isBusy?.(sessionId)) throw new RpcError(ChangeSetErrorCode.Busy, { sessionId })
      if (record.checkpointCommit === undefined) {
        const checkpoint = await options.checkpoints.create(sessionId)
        storage.changeSets.setCheckpointCommit(changeSetId, checkpoint.checkpointId)
      }
      await writeToWorkspace(session.workspacePath, file)
      storage.changeSets.setFileStatus(changeSetId, filePath, 'accepted')
      publish(record, 'changeset.conflict', {
        changeSetId,
        path: filePath,
        resolution: 'take-child',
      })
      finalize(changeSetId)
      return { changeSet: toInfo(storage.changeSets.get(changeSetId)!) }
    },
  }
}
