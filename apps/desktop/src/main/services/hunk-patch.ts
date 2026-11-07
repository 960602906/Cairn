/**
 * 按块撤销时定位 diff 块（M3-06）。
 *
 * 块的行号来自改动发生时的统一 diff，含上下文。在当前文件里找这一块的“改后”行：整块可以平移，
 * 有多处完全相同的内容时取离原来行号最近的一处。对不上时返回 undefined，调用方报 `changes.hunk_conflict`。
 */
export interface HunkSpan {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

/** 在当前文件中的位置：从 `at`（0 起）开始的 `removed` 行换成 `added`。 */
export interface HunkLocation {
  readonly at: number
  readonly removed: readonly string[]
  readonly added: readonly string[]
}

function sliceLines(
  lines: readonly string[],
  start: number,
  count: number,
): readonly string[] | undefined {
  if (count === 0) return []
  if (!Number.isInteger(start) || start < 1) return undefined
  const from = start - 1
  if (from + count > lines.length) return undefined
  return lines.slice(from, from + count)
}

/** 完全相同的一段；多处时取离 `hint`（0 起）最近的。 */
function findSequence(
  haystack: readonly string[],
  needle: readonly string[],
  hint: number,
): number | undefined {
  if (needle.length === 0 || needle.length > haystack.length) return undefined
  let best: number | undefined
  let bestDist = Infinity
  const last = haystack.length - needle.length
  for (let i = 0; i <= last; i++) {
    let same = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        same = false
        break
      }
    }
    if (!same) continue
    const dist = Math.abs(i - hint)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best
}

/**
 * 改后行数为 0（纯删除、没有上下文）：用删除点两侧仍在的行定位，插回去的位置在前一行之后。
 * 改后文件是空的时，当前文件也必须是空的。
 */
function findInsertion(
  current: readonly string[],
  after: readonly string[],
  newStart: number,
): number | undefined {
  if (newStart > after.length) return undefined
  const prev = newStart > 0 ? after[newStart - 1] : undefined
  const next = after[newStart]
  if (prev === undefined && next === undefined) return current.length === 0 ? 0 : undefined
  if (prev === undefined) return current[0] === next ? 0 : undefined
  const hint = newStart - 1
  let best: number | undefined
  let bestDist = Infinity
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== prev) continue
    if (next !== undefined && current[i + 1] !== next) continue
    const dist = Math.abs(i - hint)
    if (dist < bestDist) {
      best = i + 1
      bestDist = dist
    }
  }
  return best
}

/** 在当前文件中找到这一块的改后内容，并给出要换回去的改前行。 */
export function locateHunk(
  current: readonly string[],
  before: readonly string[],
  after: readonly string[],
  hunk: HunkSpan,
): HunkLocation | undefined {
  const removed = sliceLines(after, hunk.newStart, hunk.newLines)
  const added = sliceLines(before, hunk.oldStart, hunk.oldLines)
  if (removed === undefined || added === undefined) return undefined
  const at =
    removed.length === 0
      ? findInsertion(current, after, hunk.newStart)
      : findSequence(current, removed, Math.max(0, hunk.newStart - 1))
  if (at === undefined) return undefined
  return { at, removed, added }
}

/** 用定位结果替换当前文件中的行。 */
export function applyHunk(current: readonly string[], located: HunkLocation): string[] {
  return [
    ...current.slice(0, located.at),
    ...located.added,
    ...current.slice(located.at + located.removed.length),
  ]
}

/** 去掉两侧相同的上下文后，实际新增与删除的行数。 */
export function lineChangeCounts(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): { readonly added: number; readonly removed: number } {
  let pre = 0
  while (
    pre < beforeLines.length &&
    pre < afterLines.length &&
    beforeLines[pre] === afterLines[pre]
  ) {
    pre++
  }
  let suf = 0
  while (
    suf < beforeLines.length - pre &&
    suf < afterLines.length - pre &&
    beforeLines[beforeLines.length - 1 - suf] === afterLines[afterLines.length - 1 - suf]
  ) {
    suf++
  }
  return {
    removed: beforeLines.length - pre - suf,
    added: afterLines.length - pre - suf,
  }
}

/** 反向记录上的块：当前文件中被替换的范围换成恢复后的行。 */
export function inverseHunk(at: number, removedCount: number, addedCount: number): HunkSpan {
  if (removedCount === 0) {
    return { oldStart: at, oldLines: 0, newStart: at + 1, newLines: addedCount }
  }
  if (addedCount === 0) {
    return { oldStart: at + 1, oldLines: removedCount, newStart: at, newLines: 0 }
  }
  return { oldStart: at + 1, oldLines: removedCount, newStart: at + 1, newLines: addedCount }
}
