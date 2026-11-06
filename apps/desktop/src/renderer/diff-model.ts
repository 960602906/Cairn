/**
 * diff 卡片的数据（M2-07，视觉规范 §7.2）：按行对齐改动前后的文本，切成 hunk，hunk 之间未改动的行折叠。
 *
 * - 行对齐用 jsdiff 的 `diffArrays`（先去掉相同的首尾行），超过 `DIFF_TIMEOUT_MS` 时退回“整段删除再整段新增”；
 * - 同一处改动中删除行与新增行按顺序配对，再用 `diffWordsWithSpace` 找出行内真正改动的部分（词级着色）。
 *   改动太多（相同部分不足 `WORD_DIFF_MIN_SAME`）或行太长时不标词，只整行着色；
 * - hunk 标题的函数名沿用 git 的默认规则：hunk 之前最近一行以字母、`_` 或 `$` 开头的旧文本。
 */
import { diffArrays, diffWordsWithSpace } from 'diff'

export const DIFF_CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 500
/** 两行合计超过这个长度时不做词级比较。 */
export const WORD_DIFF_MAX_CHARS = 1000
/** 词级比较后相同的字符占比低于这个值时不标词。 */
export const WORD_DIFF_MIN_SAME = 0.4
const FUNCTION_NAME_MAX_CHARS = 80

/** 行内的一段 [开始, 结束)（UTF-16 下标）。 */
export type Range = readonly [number, number]

export interface DiffRow {
  readonly type: 'context' | 'add' | 'del'
  /** 旧文件的行号（新增行没有）。 */
  readonly oldNo?: number
  /** 新文件的行号（删除行没有）。 */
  readonly newNo?: number
  readonly text: string
  /** 行内真正改动的部分。 */
  readonly words?: readonly Range[]
}

export interface HunkHeader {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly fn?: string
}

export type DiffSegment =
  | { readonly kind: 'hunk'; readonly header: HunkHeader; readonly rows: readonly DiffRow[] }
  | { readonly kind: 'gap'; readonly rows: readonly DiffRow[] }

export interface FileDiff {
  readonly segments: readonly DiffSegment[]
  readonly added: number
  readonly removed: number
}

/** 按 CRLF、LF、CR 分行；末尾的换行不产生空行。 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 行级对齐：返回按顺序的未改动、删除、新增行。 */
export function diffRows(before: readonly string[], after: readonly string[]): DiffRow[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  const oldMid = before.slice(head, before.length - tail)
  const newMid = after.slice(head, after.length - tail)
  const parts = diffArrays(oldMid, newMid, { timeout: DIFF_TIMEOUT_MS }) ?? [
    { value: oldMid, count: oldMid.length, added: false, removed: true },
    { value: newMid, count: newMid.length, added: true, removed: false },
  ]

  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  const same = (text: string) =>
    rows.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text })
  before.slice(0, head).forEach(same)
  for (const part of parts) {
    for (const text of part.value) {
      if (part.removed) rows.push({ type: 'del', oldNo: oldNo++, text })
      else if (part.added) rows.push({ type: 'add', newNo: newNo++, text })
      else same(text)
    }
  }
  before.slice(before.length - tail).forEach(same)
  return withWordDiff(rows)
}

/** 两行之间改动的部分；改动太多或行太长时返回 undefined。 */
export function wordRanges(
  oldText: string,
  newText: string,
): { readonly old: Range[]; readonly new: Range[] } | undefined {
  if (oldText.length + newText.length > WORD_DIFF_MAX_CHARS) return undefined
  const parts = diffWordsWithSpace(oldText, newText)
  const old: Range[] = []
  const next: Range[] = []
  let oldAt = 0
  let newAt = 0
  let same = 0
  for (const part of parts) {
    const length = part.value.length
    if (part.removed) {
      old.push([oldAt, oldAt + length])
      oldAt += length
    } else if (part.added) {
      next.push([newAt, newAt + length])
      newAt += length
    } else {
      same += length
      oldAt += length
      newAt += length
    }
  }
  const total = Math.max(oldText.length, newText.length)
  if (total > 0 && same / total < WORD_DIFF_MIN_SAME) return undefined
  return { old, new: next }
}

/** 同一处改动中的删除行与新增行按顺序配对，标出行内改动的部分。 */
function withWordDiff(rows: DiffRow[]): DiffRow[] {
  const out = [...rows]
  let i = 0
  while (i < out.length) {
    if (out[i]!.type === 'context') {
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (i < out.length && out[i]!.type !== 'context') {
      ;(out[i]!.type === 'del' ? dels : adds).push(i)
      i++
    }
    const pairs = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairs; k++) {
      const del = out[dels[k]!]!
      const add = out[adds[k]!]!
      const ranges = wordRanges(del.text, add.text)
      if (!ranges) continue
      out[dels[k]!] = { ...del, words: ranges.old }
      out[adds[k]!] = { ...add, words: ranges.new }
    }
  }
  return out
}

/** hunk 之前最近一行以字母、`_` 或 `$` 开头的旧文本（git 默认的 funcname 规则）。 */
export function functionName(before: readonly string[], oldStart: number): string | undefined {
  for (let i = Math.min(oldStart, before.length + 1) - 2; i >= 0; i--) {
    const line = before[i]!
    if (/^[A-Za-z_$]/.test(line)) {
      const trimmed = line.trimEnd()
      return trimmed.length > FUNCTION_NAME_MAX_CHARS
        ? `${trimmed.slice(0, FUNCTION_NAME_MAX_CHARS)}…`
        : trimmed
    }
  }
  return undefined
}

/** 把行切成 hunk（改动前后各留 `context` 行）与之间折叠的未改动行。 */
export function segment(
  rows: readonly DiffRow[],
  before: readonly string[],
  context = DIFF_CONTEXT_LINES,
): DiffSegment[] {
  const changed = rows.flatMap((row, i) => (row.type === 'context' ? [] : [i]))
  if (changed.length === 0) return rows.length === 0 ? [] : [{ kind: 'gap', rows }]
  const ranges: [number, number][] = []
  for (const i of changed) {
    const start = Math.max(0, i - context)
    const end = Math.min(rows.length, i + context + 1)
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  const segments: DiffSegment[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) segments.push({ kind: 'gap', rows: rows.slice(at, start) })
    const hunkRows = rows.slice(start, end)
    segments.push({
      kind: 'hunk',
      header: hunkHeader(hunkRows, rows, start, before),
      rows: hunkRows,
    })
    at = end
  }
  if (at < rows.length) segments.push({ kind: 'gap', rows: rows.slice(at) })
  return segments
}

function hunkHeader(
  hunkRows: readonly DiffRow[],
  rows: readonly DiffRow[],
  start: number,
  before: readonly string[],
): HunkHeader {
  const oldLines = hunkRows.filter((r) => r.type !== 'add').length
  const newLines = hunkRows.filter((r) => r.type !== 'del').length
  // 行数为 0 时起始行是插入或删除位置的前一行（与 unified diff 相同）
  const previous = (key: 'oldNo' | 'newNo') => {
    for (let i = start - 1; i >= 0; i--) {
      const n = rows[i]![key]
      if (n !== undefined) return n
    }
    return 0
  }
  const firstOld = hunkRows.find((r) => r.oldNo !== undefined)?.oldNo
  const firstNew = hunkRows.find((r) => r.newNo !== undefined)?.newNo
  const oldStart = oldLines === 0 ? previous('oldNo') : firstOld!
  const newStart = newLines === 0 ? previous('newNo') : firstNew!
  const fn = functionName(before, oldLines === 0 ? oldStart + 1 : oldStart)
  return { oldStart, oldLines, newStart, newLines, ...(fn === undefined ? {} : { fn }) }
}

export const formatHunkHeader = ({ oldStart, oldLines, newStart, newLines }: HunkHeader) =>
  `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`

/** 两段文本的 diff（`create` 的 before、`delete` 的 after 为空字符串）。 */
export function fileDiff(before: string, after: string, context = DIFF_CONTEXT_LINES): FileDiff {
  const oldLines = splitLines(before)
  const rows = diffRows(oldLines, splitLines(after))
  return {
    segments: segment(rows, oldLines, context),
    added: rows.filter((r) => r.type === 'add').length,
    removed: rows.filter((r) => r.type === 'del').length,
  }
}

/** 分栏视图的一行：左旧右新，对侧没有对应行时为 undefined。 */
export interface SplitRow {
  readonly left?: DiffRow
  readonly right?: DiffRow
}

/** 合并视图的行转成分栏视图：未改动的行两侧都有，同一处改动的删除与新增按顺序并排。 */
export function toSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (row.type === 'context') {
      out.push({ left: row, right: row })
      i++
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i]!.type !== 'context') {
      ;(rows[i]!.type === 'del' ? dels : adds).push(rows[i]!)
      i++
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = dels[k]
      const right = adds[k]
      out.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) })
    }
  }
  return out
}

/** 增删比例的 5 个小方块：新增、删除与空白各几个（没有改动时全是空白）。 */
export function ratioBlocks(added: number, removed: number, total = 5) {
  const sum = added + removed
  if (sum === 0) return { add: 0, del: 0, empty: total }
  let add = Math.round((added / sum) * total)
  if (added > 0 && add === 0) add = 1
  if (removed > 0 && add === total) add = total - 1
  return { add, del: total - add, empty: 0 }
}
