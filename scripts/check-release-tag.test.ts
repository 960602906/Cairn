import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkReleaseTag, main, resolveReleaseChannel } from './check-release-tag.mjs'

const dirs: string[] = []

function workspace(version = '0.1.1'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cairn-tag-'))
  dirs.push(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cairn', version }))
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('release channel resolution', () => {
  it('uses prerelease suffixes and major version defaults', () => {
    expect(resolveReleaseChannel('0.1.1', undefined)).toBe('beta')
    expect(resolveReleaseChannel('1.0.0', undefined)).toBe('stable')
    expect(resolveReleaseChannel('1.0.1-beta.1', undefined)).toBe('beta')
    expect(resolveReleaseChannel('1.0.1', 'beta')).toBe('beta')
    expect(resolveReleaseChannel('1.0.1-beta.1', 'stable')).toBe('stable')
  })
})

describe('tag validation', () => {
  it('accepts a matching tag and derives the channel', () => {
    expect(checkReleaseTag({ tag: 'v0.1.1', version: '0.1.1' })).toEqual({
      version: '0.1.1',
      channel: 'beta',
      prerelease: false,
    })
    expect(checkReleaseTag({ tag: 'v1.0.0', version: '1.0.0' })).toEqual({
      version: '1.0.0',
      channel: 'stable',
      prerelease: false,
    })
    expect(checkReleaseTag({ tag: 'v1.0.0-beta.2', version: '1.0.0-beta.2' })).toEqual({
      version: '1.0.0-beta.2',
      channel: 'beta',
      prerelease: true,
    })
  })

  it('rejects malformed, mismatched and stable prerelease tags', () => {
    expect(() => checkReleaseTag({ tag: '0.1.1', version: '0.1.1' })).toThrow(/vX\.Y\.Z/)
    expect(() => checkReleaseTag({ tag: 'v0.1.2', version: '0.1.1' })).toThrow(/does not match/)
    expect(() =>
      checkReleaseTag({
        tag: 'v1.0.0-beta.1',
        version: '1.0.0-beta.1',
        requestedChannel: 'stable',
      }),
    ).toThrow(/must not use a prerelease/)
  })
})

describe('CLI', () => {
  it('reads the tag from the environment and prints the channel', () => {
    const root = workspace()
    const log = vi.fn()
    expect(main({ root, env: { GITHUB_REF_NAME: 'v0.1.1' }, log })).toBe(0)
    expect(log).toHaveBeenCalledWith('release: tag v0.1.1 -> 0.1.1 (beta)')
  })

  it('accepts explicit arguments and validates the channel', () => {
    const root = workspace('1.0.0')
    expect(main({ root, argv: ['--tag', 'v1.0.0', '--channel', 'stable'] })).toBe(0)
    expect(main({ root, argv: ['--tag', 'v1.0.0', '--channel', 'nightly'] })).toBe(1)
  })

  it('writes version and channel for GitHub Actions', () => {
    const root = workspace('1.2.0')
    const output = path.join(root, 'github-output')
    expect(
      main({
        root,
        argv: ['--tag', 'v1.2.0', '--github-output', output],
        log: vi.fn(),
      }),
    ).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('version=1.2.0\nchannel=stable\n')
  })

  it('reports missing tags and mismatches', () => {
    const error = vi.fn()
    expect(main({ root: workspace(), env: {}, error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage:'))
    expect(main({ root: workspace(), argv: ['--tag', 'v9.9.9'], error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not match'))
  })
})
