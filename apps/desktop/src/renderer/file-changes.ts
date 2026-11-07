/**
 * 按文件汇总改动记录（M2-07）：本轮变更与顶栏的本会话改动都按文件显示，一行一个文件。
 *
 * - 只算仍然有效的改动：已撤销的改动（`reverted`）与撤销产生的反向记录（`revertOf`）互相抵消，都不算；
 * - 同一文件的多次改动合成一项：diff 取最早一次改动之前与最后一次改动之后的内容，撤销时一起撤销；
 * - 新建后又删除的文件不显示；增删行数是各次改动之和（显示 diff 后以实际 diff 为准）。
 */
import type { FileChangeKind, FileChangeStatus, FileChangeSummary } from '@cairn/protocol'

/** 一条改动里可以单独撤销的块（只有这一项只含一条改动时才有）。 */
export interface EntryHunk {
  readonly index: number
  readonly status: FileChangeStatus
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

export interface FileEntry {
  readonly path: string
  readonly kind: FileChangeKind
  /** 按发生顺序的有效改动。 */
  readonly changeIds: readonly string[]
  readonly added: number
  readonly removed: number
  /** 仍然有效的改动里，已撤销的块与块的总数。 */
  readonly revertedHunks: number
  readonly hunkCount: number
  /** 这一项只有一条改动时，按记录下来的块撤销。 */
  readonly hunks?: readonly EntryHunk[]
}

export const isEffective = (change: FileChangeSummary) =>
  change.status !== 'reverted' && change.revertOf === undefined

/** 按文件合并有效的改动，按每个文件第一次改动的顺序排列。 */
export function fileEntries(
  changes: readonly FileChangeSummary[],
  include: (change: FileChangeSummary) => boolean = () => true,
): FileEntry[] {
  const byPath = new Map<string, FileChangeSummary[]>()
  for (const change of changes) {
    if (!isEffective(change) || !include(change)) continue
    const list = byPath.get(change.path)
    if (list) list.push(change)
    else byPath.set(change.path, [change])
  }
  const entries: FileEntry[] = []
  for (const [path, list] of byPath) {
    const created = list[0]!.kind === 'create'
    const deleted = list.at(-1)!.kind === 'delete'
    if (created && deleted) continue
    const only = list.length === 1 ? list[0] : undefined
    entries.push({
      path,
      kind: created ? 'create' : deleted ? 'delete' : 'modify',
      changeIds: list.map((c) => c.changeId),
      added: list.reduce((n, c) => n + c.added, 0),
      removed: list.reduce((n, c) => n + c.removed, 0),
      revertedHunks: list.reduce(
        (n, c) => n + (c.hunks ?? []).filter((h) => h.status === 'reverted').length,
        0,
      ),
      hunkCount: list.reduce((n, c) => n + (c.hunks ?? []).length, 0),
      ...(only
        ? {
            hunks: (only.hunks ?? []).map((h, index) => ({
              index,
              status: h.status ?? 'pending',
              oldStart: h.oldStart,
              oldLines: h.oldLines,
              newStart: h.newStart,
              newLines: h.newLines,
            })),
          }
        : {}),
    })
  }
  return entries
}

export const turnEntries = (changes: readonly FileChangeSummary[], turnId: string) =>
  fileEntries(changes, (c) => c.turnId === turnId)

export function totals(entries: readonly FileEntry[]) {
  return {
    files: entries.length,
    added: entries.reduce((n, e) => n + e.added, 0),
    removed: entries.reduce((n, e) => n + e.removed, 0),
  }
}
