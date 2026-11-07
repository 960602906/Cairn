/**
 * 文件改动记录（M1-08b；ADR-0008；架构 §11.1、§14.2）：
 *
 * - **记录**（宿主经 `changes.record` 请求）：改动前后的内容写入 blob 存储，记录写入 `file_changes` 与
 *   `hunks`。宿主随后发出 `file.changed`。
 * - **列出**（`changes.list`）：会话的全部改动，按发生顺序，不含文件内容。
 * - **内容**（`changes.content`，M2-07）：一次改动前后的内容，供界面显示 diff。按读取文件的规则解码
 *   （BOM、UTF-16、含 NUL 的视为二进制）；二进制与超过 `FILE_CONTENT_MAX_CHARS` 的文本只返回大小。
 * - **整文件撤销**（`changes.revert`）：按与发生相反的顺序把文件恢复为改动前的内容。
 *   先在内存中逐个核对：文件当前的内容必须与改动后的内容一致（同一文件的多次改动依次核对），任何一处不一致
 *   （改动之后文件又被修改过，或较新的改动没有一起撤销）都整体拒绝，不写任何文件。核对通过后写入文件，
 *   为每个被撤销的改动写一条反向的改动记录（`revertOf`），原记录标记为 `reverted`，并发出 `file.changed`。
 *   会话正在运行时拒绝；撤销期间会话不接受新的输入（`isReverting`）。
 * - **按块撤销**（`changes.revertHunk`，M3-06）：只把这一块的改后内容换回改前内容。按上下文行在当前文件里
 *   定位，允许整块偏移；对不上时报 `changes.hunk_conflict`。块标记为 `reverted`，并发出带 `hunkIndex` 的
 *   `file.changed`（`revertOf` 指向原改动），检查点可以按块把状态放回去。每一块都撤销后，改动状态变为 `reverted`。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  FILE_CONTENT_MAX_CHARS,
  RpcError,
  type FileChangeInput,
  type FileChangeKind,
  type FileChangeSummary,
  type FileContent,
  type UnsequencedEvent,
} from '@cairn/protocol'
import type { FileChangeRecord, Storage } from '@cairn/storage'
import {
  createPathResolver,
  decodeFile,
  encodeText,
  splitLines,
  withLineEnding,
} from '@cairn/tools'
import { sha256, type BlobStore } from './blob-store.js'
import type { SessionEventService } from './event-service.js'
import { applyHunk, inverseHunk, lineChangeCounts, locateHunk } from './hunk-patch.js'

export const ChangeErrorCode = {
  /** 会话或改动记录不存在，或改动不属于该会话。 */
  NotFound: 'changes.not_found',
  /** 改动已经撤销过。 */
  AlreadyReverted: 'changes.already_reverted',
  /** 文件在改动之后又被修改过（或较新的改动没有一起撤销），不能撤销。 */
  Conflict: 'changes.conflict',
  /** 这一块的改后内容在当前文件里对不上，不能按块撤销。 */
  HunkConflict: 'changes.hunk_conflict',
  /** 改动前的内容在 blob 存储中找不到或已损坏。 */
  BlobMissing: 'changes.blob_missing',
  /** 查看改动时，改动前或改动后的内容在 blob 存储中找不到（M2-07）。 */
  ContentMissing: 'changes.content_missing',
  /** 读写文件失败。 */
  Failed: 'changes.failed',
  /** 会话正在运行或正在撤销。 */
  Busy: 'run.busy',
} as const

export interface ChangeServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'changes' | 'transaction'>
  readonly blobs: BlobStore
  readonly events: Pick<SessionEventService, 'publish'>
  /** 会话是否正在运行（会话管理器提供）。 */
  readonly isBusy: (sessionId: string) => boolean
  readonly createId?: () => string
  readonly now?: () => number
}

export interface ChangeService {
  record(sessionId: string, runId: string, input: FileChangeInput): Promise<{ changeId: string }>
  list(params: { sessionId: string }): { changes: FileChangeSummary[] }
  content(params: {
    sessionId: string
    changeId: string
  }): Promise<{ before?: FileContent; after?: FileContent }>
  revert(params: {
    sessionId: string
    changeIds: readonly string[]
  }): Promise<{ changes: FileChangeSummary[] }>
  revertHunk(params: {
    sessionId: string
    changeId: string
    hunkIndex: number
  }): Promise<{ changes: FileChangeSummary[] }>
  /** 会话是否正在撤销改动（期间不接受新的输入）。 */
  isReverting(sessionId: string): boolean
}

export function toChangeSummary(record: FileChangeRecord): FileChangeSummary {
  return {
    changeId: record.changeId,
    path: record.path,
    kind: record.kind,
    status: record.status,
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.revertOf === undefined ? {} : { revertOf: record.revertOf }),
    hunks: record.hunks.map(({ oldStart, oldLines, newStart, newLines, status }) => ({
      oldStart,
      oldLines,
      newStart,
      newLines,
      status,
    })),
    added: record.added,
    removed: record.removed,
    createdAt: record.createdAt,
  }
}

const INVERSE_KIND: Record<FileChangeKind, FileChangeKind> = {
  create: 'delete',
  delete: 'create',
  modify: 'modify',
}

/** 交给界面的文件内容：文本、二进制或过大（只有大小）。 */
export function toFileContent(buffer: Buffer): FileContent {
  const decoded = decodeFile(buffer)
  if (decoded.binary) return { kind: 'binary', size: buffer.length }
  if (decoded.text.length > FILE_CONTENT_MAX_CHARS) {
    return { kind: 'too_large', size: buffer.length }
  }
  return { kind: 'text', text: decoded.text }
}

const fsCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? 'unknown'

export function createChangeService(options: ChangeServiceOptions): ChangeService {
  const { storage, blobs, events } = options
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const reverting = new Set<string>()

  const requireSession = (sessionId: string) => {
    const session = storage.sessions.get(sessionId)
    if (!session) throw new RpcError(ChangeErrorCode.NotFound, { sessionId })
    return session
  }

  /** 文件当前内容的哈希；不存在时为 undefined。 */
  async function currentHash(absolute: string, path: string): Promise<string | undefined> {
    try {
      return sha256(await fs.readFile(absolute))
    } catch (error) {
      const code = fsCode(error)
      if (code === 'ENOENT') return undefined
      if (code === 'EISDIR') throw new RpcError(ChangeErrorCode.Conflict, { path })
      throw new RpcError(ChangeErrorCode.Failed, { path, cause: code })
    }
  }

  async function revert(sessionId: string, changeIds: readonly string[]) {
    const session = requireSession(sessionId)
    const all = storage.changes.list(sessionId)
    const order = new Map(all.map((c, i) => [c.changeId, i]))
    const selected = [...new Set(changeIds)].map((changeId) => {
      const index = order.get(changeId)
      if (index === undefined) throw new RpcError(ChangeErrorCode.NotFound, { changeId })
      const change = all[index]!
      if (change.status === 'reverted') {
        throw new RpcError(ChangeErrorCode.AlreadyReverted, { changeId, path: change.path })
      }
      return change
    })
    // 从最新的改动开始撤销
    selected.sort((a, b) => order.get(b.changeId)! - order.get(a.changeId)!)

    // 1. 核对：模拟依次撤销，每个文件的当前内容必须与改动后的内容一致
    const resolve = createPathResolver(session.workspacePath)
    const files = new Map<string, { path: string; initial?: string; target?: string }>()
    for (const change of selected) {
      const resolution = await resolve(change.path)
      if (!resolution.ok) {
        throw new RpcError(resolution.code, { path: change.path })
      }
      const { absolute } = resolution.path
      let file = files.get(absolute)
      if (!file) {
        const initial = await currentHash(absolute, change.path)
        file = { path: change.path, ...(initial === undefined ? {} : { initial, target: initial }) }
        files.set(absolute, file)
      }
      if (file.target !== change.afterHash) {
        throw new RpcError(ChangeErrorCode.Conflict, { path: change.path })
      }
      if (change.beforeHash === undefined) delete file.target
      else file.target = change.beforeHash
    }

    // 2. 读出要恢复的内容（任何一个缺失都不写文件）
    const writes: { absolute: string; path: string; content?: Buffer }[] = []
    for (const [absolute, file] of files) {
      if (file.target === file.initial) continue
      if (file.target === undefined) {
        writes.push({ absolute, path: file.path })
        continue
      }
      const content = await blobs.get(file.target)
      if (!content) throw new RpcError(ChangeErrorCode.BlobMissing, { path: file.path })
      writes.push({ absolute, path: file.path, content })
    }

    // 3. 写入文件
    for (const write of writes) {
      try {
        if (write.content === undefined) {
          await fs.rm(write.absolute, { force: true })
        } else {
          await fs.mkdir(dirname(write.absolute), { recursive: true })
          await fs.writeFile(write.absolute, write.content)
        }
      } catch (error) {
        throw new RpcError(ChangeErrorCode.Failed, { path: write.path, cause: fsCode(error) })
      }
    }

    // 4. 反向的改动记录、原记录的状态、事件
    const inverse = storage.transaction(() =>
      selected.map((change) => {
        storage.changes.setStatus(change.changeId, 'reverted')
        return storage.changes.create({
          changeId: createId(),
          sessionId,
          path: change.path,
          kind: INVERSE_KIND[change.kind],
          ...(change.afterHash === undefined ? {} : { beforeHash: change.afterHash }),
          ...(change.beforeHash === undefined ? {} : { afterHash: change.beforeHash }),
          revertOf: change.changeId,
          added: change.removed,
          removed: change.added,
          hunks: change.hunks.map((h) => ({
            oldStart: h.newStart,
            oldLines: h.newLines,
            newStart: h.oldStart,
            newLines: h.oldLines,
          })),
        })
      }),
    )
    events.publish(
      inverse.map((change): UnsequencedEvent => ({
        v: 1,
        sessionId,
        runId: sessionId,
        ts: now(),
        type: 'file.changed',
        payload: {
          changeId: change.changeId,
          path: change.path,
          kind: change.kind,
          revertOf: change.revertOf!,
        },
      })),
    )
    return { changes: inverse.map(toChangeSummary) }
  }

  async function revertOneHunk(sessionId: string, changeId: string, hunkIndex: number) {
    const session = requireSession(sessionId)
    const change = storage.changes.get(changeId)
    if (change?.sessionId !== sessionId) throw new RpcError(ChangeErrorCode.NotFound, { changeId })
    if (change.status === 'reverted') {
      throw new RpcError(ChangeErrorCode.AlreadyReverted, { changeId, path: change.path })
    }
    const hunk = change.hunks[hunkIndex]
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || !hunk) {
      throw new RpcError(ChangeErrorCode.NotFound, { changeId, hunkIndex })
    }
    if (hunk.status === 'reverted') {
      throw new RpcError(ChangeErrorCode.AlreadyReverted, {
        changeId,
        path: change.path,
        hunkIndex,
      })
    }

    const resolution = await createPathResolver(session.workspacePath)(change.path)
    if (!resolution.ok) throw new RpcError(resolution.code, { path: change.path })
    const { absolute } = resolution.path
    const conflict = () => new RpcError(ChangeErrorCode.HunkConflict, { path: change.path })

    const linesOf = async (hash: string | undefined) => {
      if (hash === undefined) return undefined
      const content = await blobs.get(hash)
      if (!content) throw new RpcError(ChangeErrorCode.BlobMissing, { path: change.path })
      const decoded = decodeFile(content)
      if (decoded.binary || decoded.lossy) throw conflict()
      return splitLines(decoded.text).lines
    }

    let currentBuf: Buffer
    try {
      currentBuf = await fs.readFile(absolute)
    } catch (error) {
      const code = fsCode(error)
      if (code === 'ENOENT' || code === 'EISDIR') throw conflict()
      throw new RpcError(ChangeErrorCode.Failed, { path: change.path, cause: code })
    }
    const decoded = decodeFile(currentBuf)
    if (decoded.binary || decoded.lossy) throw conflict()
    const split = splitLines(decoded.text)
    const beforeLines = (await linesOf(change.beforeHash)) ?? []
    const afterLines = await linesOf(change.afterHash)
    if (!afterLines) throw conflict()
    const located = locateHunk(split.lines, beforeLines, afterLines, hunk)
    if (!located) throw conflict()

    const nextLines = applyHunk(split.lines, located)
    const trailing =
      decoded.text.length > 0 && (decoded.text.endsWith('\n') || decoded.text.endsWith('\r'))
    const ending = split.lineEndings === 'CRLF' ? 'CRLF' : split.lineEndings === 'CR' ? 'CR' : 'LF'
    const text =
      nextLines.length === 0
        ? ''
        : withLineEnding(nextLines.join('\n') + (trailing ? '\n' : ''), ending)
    const nextBuf = encodeText(text, decoded.encoding)
    const [beforeHash, afterHash] = await Promise.all([blobs.put(currentBuf), blobs.put(nextBuf)])
    try {
      await fs.writeFile(absolute, nextBuf)
    } catch (error) {
      throw new RpcError(ChangeErrorCode.Failed, { path: change.path, cause: fsCode(error) })
    }

    const counts = lineChangeCounts(located.removed, located.added)
    const inverse = storage.transaction(() => {
      storage.changes.setHunkStatus(changeId, hunkIndex, 'reverted')
      return storage.changes.create({
        changeId: createId(),
        sessionId,
        path: change.path,
        kind: 'modify',
        beforeHash,
        afterHash,
        revertOf: change.changeId,
        added: counts.added,
        removed: counts.removed,
        hunks: [inverseHunk(located.at, located.removed.length, located.added.length)],
      })
    })
    events.publish([
      {
        v: 1,
        sessionId,
        runId: sessionId,
        ts: now(),
        type: 'file.changed',
        payload: {
          changeId: inverse.changeId,
          path: inverse.path,
          kind: inverse.kind,
          revertOf: inverse.revertOf!,
          hunkIndex,
        },
      },
    ])
    return { changes: [toChangeSummary(inverse)] }
  }

  return {
    async record(sessionId, runId, input) {
      requireSession(sessionId)
      const before = input.before === undefined ? undefined : Buffer.from(input.before, 'base64')
      const after = input.after === undefined ? undefined : Buffer.from(input.after, 'base64')
      const beforeHash = before && (await blobs.put(before))
      const afterHash = after && (await blobs.put(after))
      const changeId = createId()
      storage.changes.create({
        changeId,
        sessionId,
        runId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        path: input.path,
        kind: input.kind,
        ...(beforeHash === undefined ? {} : { beforeHash }),
        ...(afterHash === undefined ? {} : { afterHash }),
        added: input.added,
        removed: input.removed,
        hunks: input.hunks,
      })
      return { changeId }
    },

    list({ sessionId }) {
      requireSession(sessionId)
      return { changes: storage.changes.list(sessionId).map(toChangeSummary) }
    },

    async content({ sessionId, changeId }) {
      requireSession(sessionId)
      const change = storage.changes.get(changeId)
      if (change?.sessionId !== sessionId) {
        throw new RpcError(ChangeErrorCode.NotFound, { changeId })
      }
      const read = async (hash: string | undefined) => {
        if (hash === undefined) return undefined
        const content = await blobs.get(hash)
        if (!content) throw new RpcError(ChangeErrorCode.ContentMissing, { path: change.path })
        return toFileContent(content)
      }
      const [before, after] = await Promise.all([read(change.beforeHash), read(change.afterHash)])
      return {
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      }
    },

    async revert({ sessionId, changeIds }) {
      if (reverting.has(sessionId) || options.isBusy(sessionId)) {
        throw new RpcError(ChangeErrorCode.Busy, { sessionId })
      }
      reverting.add(sessionId)
      try {
        return await revert(sessionId, changeIds)
      } finally {
        reverting.delete(sessionId)
      }
    },

    async revertHunk({ sessionId, changeId, hunkIndex }) {
      if (reverting.has(sessionId) || options.isBusy(sessionId)) {
        throw new RpcError(ChangeErrorCode.Busy, { sessionId })
      }
      reverting.add(sessionId)
      try {
        return await revertOneHunk(sessionId, changeId, hunkIndex)
      } finally {
        reverting.delete(sessionId)
      }
    },

    isReverting: (sessionId) => reverting.has(sessionId),
  }
}
