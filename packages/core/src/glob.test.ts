import { describe, expect, it } from 'vitest'
import { globToRegExp, matchGlob } from './glob.js'

describe('matchGlob', () => {
  it.each([
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'src', false],
    ['src/**', 'lib/a.ts', false],
    ['**/.env*', '.env', true],
    ['**/.env*', 'a/b/.env.local', true],
    ['**/.env*', 'a/env', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/xb', false],
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['*.{ts,tsx}', 'a.tsx', true],
    ['*.{ts,tsx}', 'a.js', false],
    ['{a', '{a', true],
    ['[ab].txt', 'a.txt', true],
    ['[ab].txt', 'c.txt', false],
    ['[*].txt', '*.txt', true],
    ['[*].txt', 'x.txt', false],
    ['[d].txt', 'd.txt', true],
    ['[d].txt', '1.txt', false],
    ['[]].txt', '].txt', true],
    ['[-^].txt', '^.txt', true],
    ['[-^].txt', '-.txt', true],
    ['[-^].txt', 'a.txt', false],
    ['a[b', 'a[b', true],
    ['./src/a.ts', 'src/a.ts', true],
    ['src\\a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src\\a.ts', true],
    ['a.b', 'axb', false],
    ['(x)+$', '(x)+$', true],
  ])('%s ~ %s → %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected)
  })

  it('不区分大小写', () => {
    expect(matchGlob('**/.ENV', 'a/.env')).toBe(false)
    expect(matchGlob('**/.ENV', 'a/.env', { caseInsensitive: true })).toBe(true)
    expect(globToRegExp('x').flags).toBe('')
  })
})
