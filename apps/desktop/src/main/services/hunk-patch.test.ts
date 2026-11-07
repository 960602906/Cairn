import { describe, expect, it } from 'vitest'
import { applyHunk, inverseHunk, lineChangeCounts, locateHunk } from './hunk-patch.js'

const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
const after = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l']
/** 改 c→C，上下文 1 行：@@ -2,3 +2,3 @@ */
const first = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3 }
/** 改 k→K：@@ -10,3 +10,3 @@ */
const second = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3 }

describe('locateHunk', () => {
  it('原位命中，并在整体偏移后命中离原行号最近的一处', () => {
    const hit = locateHunk(after, before, after, first)
    expect(hit).toEqual({ at: 1, removed: ['b', 'C', 'd'], added: ['b', 'c', 'd'] })
    expect(applyHunk(after, hit!)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'K',
      'l',
    ])

    const shifted = ['X', 'Y', ...after]
    const moved = locateHunk(shifted, before, after, second)
    expect(moved?.at).toBe(11)
    expect(applyHunk(shifted, moved!)).toEqual([
      'X',
      'Y',
      'a',
      'b',
      'C',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
    ])
  })

  it('相同内容出现多次时取离原行号最近的', () => {
    const current = ['b', 'C', 'd', 'b', 'C', 'd']
    const old = ['b', 'c', 'd', 'b', 'c', 'd']
    const early = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }
    const later = { oldStart: 4, oldLines: 3, newStart: 4, newLines: 3 }
    expect(locateHunk(current, old, current, early)?.at).toBe(0)
    expect(locateHunk(current, old, current, later)?.at).toBe(3)
  })

  it('改后内容对不上、范围超出文件时返回 undefined', () => {
    const tampered = after.map((line) => (line === 'C' ? 'nope' : line))
    expect(locateHunk(tampered, before, after, first)).toBeUndefined()
    expect(
      locateHunk(after, before, after, { oldStart: 1, oldLines: 1, newStart: 20, newLines: 1 }),
    ).toBeUndefined()
    expect(
      locateHunk(after, before, after, { oldStart: 0, oldLines: 2, newStart: 1, newLines: 1 }),
    ).toBeUndefined()
  })

  it('纯删除按两侧的行定位，空文件只能对上同样是空的当前文件', () => {
    const old = ['a', 'gone', 'b']
    const next = ['a', 'b']
    const hunk = { oldStart: 2, oldLines: 1, newStart: 1, newLines: 0 }
    const hit = locateHunk(['a', 'b'], old, next, hunk)
    expect(hit).toEqual({ at: 1, removed: [], added: ['gone'] })
    expect(applyHunk(['a', 'b'], hit!)).toEqual(['a', 'gone', 'b'])
    expect(locateHunk(['a', 'x', 'b'], old, next, hunk)).toBeUndefined()
    const wiped = { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }
    expect(locateHunk([], ['a', 'b'], [], wiped)?.at).toBe(0)
    expect(locateHunk(['other'], ['a', 'b'], [], wiped)).toBeUndefined()
  })
})

describe('inverseHunk 与行数', () => {
  it('去掉上下文后只算真正增删的行，反向块的行号落在定位处', () => {
    expect(lineChangeCounts(['b', 'c', 'd'], ['b', 'C', 'd'])).toEqual({ added: 1, removed: 1 })
    expect(inverseHunk(1, 3, 3)).toEqual({ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3 })
    expect(inverseHunk(0, 0, 2)).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })
    expect(inverseHunk(4, 2, 0)).toEqual({ oldStart: 5, oldLines: 2, newStart: 4, newLines: 0 })
  })
})
