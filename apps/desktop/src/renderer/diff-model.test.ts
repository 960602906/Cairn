import type * as Diff from 'diff'
import { describe, expect, it, vi } from 'vitest'
import {
  diffRows,
  fileDiff,
  formatHunkHeader,
  functionName,
  ratioBlocks,
  segment,
  splitLines,
  toSplitRows,
  wordRanges,
  type DiffRow,
} from './diff-model.js'

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)

describe('splitLines', () => {
  it('CRLF、LF、CR；末尾换行不产生空行', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\r\nb\nc\rd\n')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })
})

describe('diffRows', () => {
  it('行号、类型与词级范围', () => {
    const rows = diffRows(['a', 'const x = 1', 'b'], ['a', 'const x = 2', 'new', 'b'])
    expect(rows.map((r) => [r.type, r.oldNo, r.newNo, r.text])).toEqual([
      ['context', 1, 1, 'a'],
      ['del', 2, undefined, 'const x = 1'],
      ['add', undefined, 2, 'const x = 2'],
      ['add', undefined, 3, 'new'],
      ['context', 3, 4, 'b'],
    ])
    expect(rows[1]!.words).toEqual([[10, 11]])
    expect(rows[2]!.words).toEqual([[10, 11]])
    expect(rows[3]!.words).toBeUndefined()
  })

  it('新建与删除整个文件', () => {
    expect(diffRows([], ['x', 'y']).map((r) => r.type)).toEqual(['add', 'add'])
    expect(diffRows(['x'], []).map((r) => [r.type, r.oldNo])).toEqual([['del', 1]])
  })

  it('超时时退回整段删除再整段新增', async () => {
    vi.resetModules()
    vi.doMock('diff', async (importOriginal) => ({
      ...(await importOriginal<typeof Diff>()),
      diffArrays: () => undefined,
    }))
    const { diffRows: rowsWithTimeout } = await import('./diff-model.js')
    expect(rowsWithTimeout(['a', 'b', 'z'], ['a', 'c', 'z']).map((r) => r.type)).toEqual([
      'context',
      'del',
      'add',
      'context',
    ])
    vi.doUnmock('diff')
  })

  it('1 万行文件改几处：很快完成', () => {
    const before = lines(10_000)
    const after = [...before]
    after[10] = 'changed'
    after.splice(5000, 0, 'inserted')
    after.pop()
    const start = performance.now()
    const diff = fileDiff(before.join('\n'), after.join('\n'))
    expect(performance.now() - start).toBeLessThan(500)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(2)
    expect(diff.segments.filter((s) => s.kind === 'hunk')).toHaveLength(3)
  })
})

describe('wordRanges', () => {
  it('改动太多或行太长时不标词', () => {
    expect(wordRanges('abc def', 'xyz uvw')).toBeUndefined()
    expect(wordRanges('a'.repeat(600), 'b'.repeat(600))).toBeUndefined()
    expect(wordRanges('', '')).toEqual({ old: [], new: [] })
  })

  it('只隔着空白的改动合成一段', () => {
    expect(wordRanges('for (v of xs) total += v', 'for (v of xs) {')).toEqual({
      old: [[14, 24]],
      new: [[14, 15]],
    })
  })
})

describe('segment', () => {
  const rowsOf = (before: string[], after: string[]) => diffRows(before, after)

  it('改动之间超过 2×3 行时分成两个 hunk，之间与首尾折叠', () => {
    const before = lines(30)
    const after = [...before]
    after[4] = 'five'
    after[24] = 'twenty-five'
    const segments = segment(rowsOf(before, after), before)
    expect(segments.map((s) => [s.kind, s.rows.length])).toEqual([
      ['gap', 1],
      ['hunk', 8],
      ['gap', 13],
      ['hunk', 8],
      ['gap', 2],
    ])
    const hunk = segments[1]!
    expect(hunk.kind === 'hunk' && formatHunkHeader(hunk.header)).toBe('@@ -2,7 +2,7 @@')
  })

  it('改动挨得近时合并为一个 hunk；没有改动时整段折叠；空文件没有内容', () => {
    const before = lines(10)
    const after = [...before]
    after[2] = 'x'
    after[7] = 'y'
    expect(segment(rowsOf(before, after), before).map((s) => s.kind)).toEqual(['hunk'])
    expect(segment(rowsOf(before, before), before).map((s) => s.kind)).toEqual(['gap'])
    expect(segment([], [])).toEqual([])
  })

  it('纯插入与纯删除的 hunk 起始行是前一行', () => {
    const before = ['a', 'b']
    const insert = segment(rowsOf(before, ['a', 'b', 'c']), before, 0)
    expect(insert[1]!.kind === 'hunk' && insert[1]!.header).toMatchObject({
      oldStart: 2,
      oldLines: 0,
      newStart: 3,
      newLines: 1,
    })
    const remove = segment(rowsOf(before, ['b']), before, 0)
    expect(remove[0]!.kind === 'hunk' && remove[0]!.header).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
    })
  })

  it('hunk 标题带所在函数名', () => {
    const before = ['export function sum(values) {', '  let total = 0', '  return total', '}']
    const after = [...before]
    after[2] = '  return total + 1'
    const hunk = segment(rowsOf(before, after), before, 0).find((s) => s.kind === 'hunk')
    expect(hunk?.kind === 'hunk' && hunk.header.fn).toBe('export function sum(values) {')
  })
})

describe('functionName', () => {
  it('跳过缩进的行；超长截断；之前没有时为 undefined', () => {
    expect(functionName(['  x', 'def f():', '  y', '  z'], 4)).toBe('def f():')
    expect(functionName(['  x', '  y'], 2)).toBeUndefined()
    expect(functionName([`f${'x'.repeat(100)}`], 2)).toHaveLength(81)
    expect(functionName(['a'], 1)).toBeUndefined()
  })
})

describe('toSplitRows', () => {
  it('未改动两侧都有，删除与新增并排，多出来的一侧留空', () => {
    const rows: DiffRow[] = [
      { type: 'context', oldNo: 1, newNo: 1, text: 'a' },
      { type: 'del', oldNo: 2, text: 'b' },
      { type: 'del', oldNo: 3, text: 'c' },
      { type: 'add', newNo: 2, text: 'B' },
      { type: 'add', newNo: 3, text: 'new' },
      { type: 'add', newNo: 4, text: 'new2' },
    ]
    expect(toSplitRows(rows).map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'new'],
      [undefined, 'new2'],
    ])
  })
})

describe('ratioBlocks', () => {
  it.each([
    [0, 0, { add: 0, del: 0, empty: 5 }],
    [10, 0, { add: 5, del: 0, empty: 0 }],
    [0, 3, { add: 0, del: 5, empty: 0 }],
    [3, 2, { add: 3, del: 2, empty: 0 }],
    [1, 100, { add: 1, del: 4, empty: 0 }],
    [100, 1, { add: 4, del: 1, empty: 0 }],
  ])('%i 增 %i 删', (added, removed, expected) => {
    expect(ratioBlocks(added, removed)).toEqual(expected)
  })
})
