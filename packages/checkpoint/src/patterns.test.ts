import { describe, expect, it } from 'vitest'
import {
  configValue,
  exactPattern,
  isCheckpointId,
  parseNameStatus,
  parseStatus,
} from './patterns.js'

const nul = (...records: string[]) => Buffer.from(records.join('\0') + '\0')

describe('exactPattern', () => {
  it('anchors the path and escapes gitignore syntax', () => {
    expect(exactPattern('a/b.txt')).toBe('/a/b.txt')
    expect(exactPattern('x/[a]*?!#\\.bin')).toBe('/x/\\[a\\]\\*\\?\\!\\#\\\\.bin')
    expect(exactPattern('trailing ')).toBe('/trailing\\ ')
  })
})

describe('parseStatus', () => {
  it('collects changed files and nested repositories', () => {
    const status = parseStatus(
      nul(
        '? new file.txt',
        '? vendor/lib/',
        '1 .M N... 100644 100644 100644 abc abc src/a b.ts',
        '1 .D N... 100644 100644 000000 abc abc gone.ts',
        '1 A. S... 000000 160000 160000 000 abc vendor/old',
        '# branch.oid (initial)',
        '',
      ),
    )
    expect(status).toEqual({
      changed: ['new file.txt', 'src/a b.ts'],
      nested: ['vendor/lib', 'vendor/old'],
    })
  })
})

describe('parseNameStatus', () => {
  it('maps statuses; type changes count as modified', () => {
    expect(
      parseNameStatus(nul('A', 'n.txt', 'D', 'd.txt', 'M', '中文 名.md', 'T', 'link')),
    ).toEqual([
      { path: 'n.txt', status: 'added' },
      { path: 'd.txt', status: 'deleted' },
      { path: '中文 名.md', status: 'modified' },
      { path: 'link', status: 'modified' },
    ])
    expect(parseNameStatus(Buffer.alloc(0))).toEqual([])
  })
})

describe('isCheckpointId', () => {
  it('accepts full SHA-1 / SHA-256 ids only', () => {
    expect(isCheckpointId('a'.repeat(40))).toBe(true)
    expect(isCheckpointId('0123456789abcdef'.repeat(4))).toBe(true)
    for (const bad of [
      'a'.repeat(39),
      'A'.repeat(40),
      '--output=x',
      'HEAD',
      `${'a'.repeat(40)}^`,
    ]) {
      expect(isCheckpointId(bad), bad).toBe(false)
    }
  })
})

describe('configValue', () => {
  it('quotes and escapes', () => {
    expect(configValue('C:\\data\\"x"')).toBe('"C:\\\\data\\\\\\"x\\""')
  })
})
