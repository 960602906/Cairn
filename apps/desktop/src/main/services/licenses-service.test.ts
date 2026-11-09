import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LICENSE_NOTICES_MAX_CHARS, readLicenseNotices } from './licenses-service.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-licenses-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readLicenseNotices', () => {
  it('returns the bundled notices text', () => {
    const file = path.join(tempDir(), 'THIRD_PARTY_NOTICES.txt')
    writeFileSync(file, 'Cairn\n\nMIT — package\n')
    expect(readLicenseNotices(file)).toEqual({
      available: true,
      text: 'Cairn\n\nMIT — package\n',
      truncated: false,
    })
  })

  it('reports a missing file without throwing', () => {
    expect(readLicenseNotices(path.join(tempDir(), 'missing.txt'))).toEqual({
      available: false,
      text: '',
      truncated: false,
    })
  })

  it('reports an unreadable path without throwing', () => {
    expect(readLicenseNotices(tempDir())).toEqual({
      available: false,
      text: '',
      truncated: false,
    })
  })

  it('truncates oversized notices at the limit', () => {
    const file = path.join(tempDir(), 'THIRD_PARTY_NOTICES.txt')
    writeFileSync(file, 'abcdef')
    expect(readLicenseNotices(file, 4)).toEqual({
      available: true,
      text: 'abcd',
      truncated: true,
    })
  })

  it('does not split a surrogate pair at the truncation point', () => {
    const file = path.join(tempDir(), 'THIRD_PARTY_NOTICES.txt')
    writeFileSync(file, 'ab😀cd')
    expect(readLicenseNotices(file, 3)).toEqual({
      available: true,
      text: 'ab',
      truncated: true,
    })
  })

  it('handles a zero or negative limit', () => {
    const file = path.join(tempDir(), 'THIRD_PARTY_NOTICES.txt')
    writeFileSync(file, 'abc')
    for (const limit of [0, -5]) {
      expect(readLicenseNotices(file, limit)).toEqual({
        available: true,
        text: '',
        truncated: true,
      })
    }
  })

  it('uses a 2 MB default limit', () => {
    expect(LICENSE_NOTICES_MAX_CHARS).toBe(2_000_000)
  })
})
