import { describe, expect, it } from 'vitest'
import { changeSetDiffContent, changeSetFileKind, parseUnifiedPatch } from './change-set-patch.js'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  '',
].join('\n')

describe('parseUnifiedPatch', () => {
  it('rebuilds both sides of a unified diff', () => {
    expect(parseUnifiedPatch(PATCH)).toEqual({
      before: 'const a = 1\nconst b = 2\nconst c = 4\n',
      after: 'const a = 1\nconst b = 3\nconst c = 4\n',
    })
  })

  it('keeps multiple hunks in order and ignores the file headers', () => {
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      '@@ -5,2 +5,3 @@',
      ' five',
      ' six',
      '+seven',
    ].join('\n')
    expect(parseUnifiedPatch(patch)).toEqual({
      before: 'one\nfive\nsix\n',
      after: 'ONE\nfive\nsix\nseven\n',
    })
  })

  it('honours missing trailing newlines', () => {
    const patch = [
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n')
    expect(parseUnifiedPatch(patch)).toEqual({ before: 'old', after: 'new' })
  })

  it('handles additions only, deletions only, CRLF input and unknown markers', () => {
    expect(parseUnifiedPatch('@@ -0,0 +1,2 @@\r\n+x\r\n+y\r\n')).toEqual({
      before: '',
      after: 'x\ny\n',
    })
    expect(parseUnifiedPatch('@@ -1,2 +0,0 @@\n-a\n-b\n')).toEqual({
      before: 'a\nb\n',
      after: '',
    })
    expect(parseUnifiedPatch('@@ -1 +1 @@\n=a\n')).toBeUndefined()
  })

  it('returns undefined when the patch has no hunk', () => {
    expect(parseUnifiedPatch('')).toBeUndefined()
    expect(parseUnifiedPatch('--- a/a\n+++ b/a\n')).toBeUndefined()
  })
})

describe('changeSetFileKind', () => {
  it('maps change set kinds onto diff card kinds', () => {
    expect(changeSetFileKind('added')).toBe('create')
    expect(changeSetFileKind('removed')).toBe('delete')
    expect(changeSetFileKind('modified')).toBe('modify')
  })
})

describe('changeSetDiffContent', () => {
  const base = { kind: 'modified' as const, added: 1, removed: 1 }

  it('marks binary and large files instead of showing a diff', () => {
    expect(changeSetDiffContent({ ...base, binary: true, large: false })).toEqual({
      state: 'binary',
    })
    expect(changeSetDiffContent({ ...base, binary: false, large: true })).toEqual({
      state: 'too_large',
    })
    // 二进制优先：即使同时标记为大文件也只显示二进制说明
    expect(changeSetDiffContent({ ...base, binary: true, large: true })).toEqual({
      state: 'binary',
    })
  })

  it('parses text patches', () => {
    expect(changeSetDiffContent({ ...base, binary: false, large: false, patch: PATCH })).toEqual({
      state: 'ready',
      before: 'const a = 1\nconst b = 2\nconst c = 4\n',
      after: 'const a = 1\nconst b = 3\nconst c = 4\n',
    })
  })

  it('treats empty added or removed files as empty content', () => {
    expect(
      changeSetDiffContent({ kind: 'added', added: 0, removed: 0, binary: false, large: false }),
    ).toEqual({ state: 'ready', before: '', after: '' })
    expect(
      changeSetDiffContent({ kind: 'removed', added: 0, removed: 0, binary: false, large: false }),
    ).toEqual({ state: 'ready', before: '', after: '' })
  })

  it('reports an error when a text patch is missing or unreadable', () => {
    expect(changeSetDiffContent({ ...base, binary: false, large: false })).toEqual({
      state: 'error',
    })
    expect(
      changeSetDiffContent({
        ...base,
        binary: false,
        large: false,
        patch: '--- a\n+++ b\n',
      }),
    ).toEqual({ state: 'error' })
  })
})
