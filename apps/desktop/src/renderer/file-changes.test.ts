import { describe, expect, it } from 'vitest'
import type { FileChangeSummary } from '@cairn/protocol'
import { fileEntries, totals, turnEntries } from './file-changes.js'

let n = 0
const change = (over: Partial<FileChangeSummary>): FileChangeSummary => ({
  changeId: `c${++n}`,
  path: 'a.ts',
  kind: 'modify',
  status: 'pending',
  hunks: [],
  added: 1,
  removed: 1,
  createdAt: n,
  ...over,
})

describe('fileEntries', () => {
  it('同一文件的多次改动合成一项，按第一次改动的顺序', () => {
    const changes = [
      change({ changeId: 'a1', path: 'a.ts', kind: 'create', added: 3, removed: 0, turnId: 't1' }),
      change({ changeId: 'b1', path: 'b.ts', turnId: 't1' }),
      change({ changeId: 'a2', path: 'a.ts', added: 2, removed: 1, turnId: 't2' }),
    ]
    expect(fileEntries(changes)).toEqual([
      { path: 'a.ts', kind: 'create', changeIds: ['a1', 'a2'], added: 5, removed: 1 },
      { path: 'b.ts', kind: 'modify', changeIds: ['b1'], added: 1, removed: 1 },
    ])
    expect(turnEntries(changes, 't2')).toEqual([
      { path: 'a.ts', kind: 'modify', changeIds: ['a2'], added: 2, removed: 1 },
    ])
    expect(totals(fileEntries(changes))).toEqual({ files: 2, added: 6, removed: 2 })
  })

  it('已撤销的改动与反向记录不算；新建后又删除的文件不显示；删除的文件', () => {
    const changes = [
      change({ changeId: 'x', status: 'reverted' }),
      change({ changeId: 'y', revertOf: 'x' }),
      change({ path: 'tmp.ts', kind: 'create' }),
      change({ path: 'tmp.ts', kind: 'delete' }),
      change({ changeId: 'old', path: 'old.ts', kind: 'delete', added: 0, removed: 4 }),
    ]
    expect(fileEntries(changes)).toEqual([
      { path: 'old.ts', kind: 'delete', changeIds: ['old'], added: 0, removed: 4 },
    ])
    expect(totals([])).toEqual({ files: 0, added: 0, removed: 0 })
  })
})
