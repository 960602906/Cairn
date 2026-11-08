/**
 * 改动集 diff 解析（M4-10）：`ChangeSetFileInfo.patch` 是 `createTwoFilesPatch` 生成的 unified diff，
 * 而 `DiffCard` 需要改动前后的全文。这里只做与渲染有关的还原，不访问文件系统。
 *
 * - 上下文行同时属于改动前后两侧；删除行只属于改动前，新增行只属于改动后；
 * - `\ No newline at end of file` 标记前一行的换行状态，避免给没有换行的文件凭空补一个换行；
 * - 二进制、过大或无法解析的 diff 返回 `binary` / `too_large` / `error`，由 `DiffCard` 显示说明。
 */
import type { ChangeSetFileInfo, ChangeSetFileKind, FileChangeKind } from '@cairn/protocol'
import type { DiffContent } from './DiffCard.js'

export interface PatchSides {
  readonly before: string
  readonly after: string
}

interface PatchLine {
  text: string
  noNewline: boolean
}

const join = (lines: readonly PatchLine[]): string => {
  if (lines.length === 0) return ''
  const text = lines.map((line) => line.text).join('\n')
  return lines.at(-1)!.noNewline ? text : `${text}\n`
}

/** 还原 unified diff 两侧的全文；没有 hunk 或格式不认识时返回 undefined。 */
export function parseUnifiedPatch(patch: string): PatchSides | undefined {
  const before: PatchLine[] = []
  const after: PatchLine[] = []
  let inHunk = false
  let sawHunk = false
  /** 上一条内容行写到了哪些侧；换行标记要落在这条线上。 */
  let lastSides: PatchLine[][] = []

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!inHunk) {
      if (line.startsWith('@@')) {
        inHunk = true
        sawHunk = true
      }
      continue
    }
    if (line.startsWith('@@')) continue
    if (line === '\\ No newline at end of file') {
      for (const side of lastSides) {
        const entry = side.at(-1)
        if (entry) entry.noNewline = true
      }
      lastSides = []
      continue
    }
    if (line === '') continue
    const marker = line[0]
    if (marker === ' ') {
      const text = line.slice(1)
      const left: PatchLine = { text, noNewline: false }
      before.push(left)
      after.push({ ...left })
      lastSides = [before, after]
    } else if (marker === '-') {
      before.push({ text: line.slice(1), noNewline: false })
      lastSides = [before]
    } else if (marker === '+') {
      after.push({ text: line.slice(1), noNewline: false })
      lastSides = [after]
    } else {
      // 不是 unified diff 的内容行：整体视为无法解析，避免显示错误的全文。
      return undefined
    }
  }

  if (!sawHunk) return undefined
  return { before: join(before), after: join(after) }
}

/** 改动集的 `added` / `modified` / `removed` 对应 diff 卡片的 `create` / `modify` / `delete`。 */
export const changeSetFileKind = (kind: ChangeSetFileKind): FileChangeKind =>
  kind === 'added' ? 'create' : kind === 'removed' ? 'delete' : 'modify'

/** 把改动集文件映射为 diff 卡片内容；二进制与过大文件只显示说明。 */
export function changeSetDiffContent(
  file: Pick<ChangeSetFileInfo, 'kind' | 'added' | 'removed' | 'patch' | 'binary' | 'large'>,
): DiffContent {
  if (file.binary) return { state: 'binary' }
  if (file.large) return { state: 'too_large' }
  if (file.patch === undefined) {
    // 空的新增 / 删除文件没有 hunk，但两侧都是空内容。
    if (
      (file.kind === 'added' && file.added === 0) ||
      (file.kind === 'removed' && file.removed === 0)
    ) {
      return { state: 'ready', before: '', after: '' }
    }
    return { state: 'error' }
  }
  const sides = parseUnifiedPatch(file.patch)
  return sides ? { state: 'ready', ...sides } : { state: 'error' }
}
