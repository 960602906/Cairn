import { describe, expect, it } from 'vitest'
import {
  FILE_CHANGE_MAX_BYTES,
  FILE_CONTENT_MAX_CHARS,
  FileChangeInput,
  FileChangeSummary,
  FileContent,
} from './index.js'

const base = { path: 'src/a.ts', hunks: [], added: 0, removed: 0 }

describe('FileChangeInput', () => {
  it('create 只有 after，delete 只有 before，modify 两者都有', () => {
    expect(FileChangeInput.safeParse({ ...base, kind: 'create', after: 'YQ==' }).success).toBe(true)
    expect(FileChangeInput.safeParse({ ...base, kind: 'delete', before: 'YQ==' }).success).toBe(
      true,
    )
    expect(
      FileChangeInput.safeParse({ ...base, kind: 'modify', before: '', after: 'YQ==' }).success,
    ).toBe(true)
    expect(
      FileChangeInput.safeParse({ ...base, kind: 'create', before: '', after: '' }).success,
    ).toBe(false)
    expect(
      FileChangeInput.safeParse({ ...base, kind: 'delete', before: '', after: '' }).success,
    ).toBe(false)
    expect(FileChangeInput.safeParse({ ...base, kind: 'modify', after: '' }).success).toBe(false)
    expect(FileChangeInput.safeParse({ ...base, kind: 'modify', before: '' }).success).toBe(false)
  })

  it('内容必须是 base64，且不超过上限', () => {
    expect(FileChangeInput.safeParse({ ...base, kind: 'create', after: '不是' }).success).toBe(
      false,
    )
    const tooLong = 'A'.repeat(Math.ceil(FILE_CHANGE_MAX_BYTES / 3) * 4 + 4)
    expect(FileChangeInput.safeParse({ ...base, kind: 'create', after: tooLong }).success).toBe(
      false,
    )
  })

  it('块的行号不能为负', () => {
    const hunk = { oldStart: -1, oldLines: 0, newStart: 1, newLines: 1 }
    expect(
      FileChangeInput.safeParse({ ...base, kind: 'create', after: '', hunks: [hunk] }).success,
    ).toBe(false)
  })
})

it('FileChangeSummary', () => {
  const summary = {
    changeId: 'ch1',
    path: 'a.txt',
    kind: 'modify',
    status: 'reverted',
    revertOf: 'ch0',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    added: 1,
    removed: 1,
    createdAt: 1,
  }
  expect(FileChangeSummary.parse(summary)).toEqual(summary)
  expect(FileChangeSummary.safeParse({ ...summary, status: 'done' }).success).toBe(false)
})

it('FileContent', () => {
  expect(FileContent.parse({ kind: 'text', text: 'a\n' })).toEqual({ kind: 'text', text: 'a\n' })
  expect(FileContent.parse({ kind: 'binary', size: 10 })).toEqual({ kind: 'binary', size: 10 })
  expect(FileContent.safeParse({ kind: 'too_large', size: -1 }).success).toBe(false)
  expect(
    FileContent.safeParse({ kind: 'text', text: 'a'.repeat(FILE_CONTENT_MAX_CHARS + 1) }).success,
  ).toBe(false)
})
