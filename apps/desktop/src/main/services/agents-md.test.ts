import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS_MD_MAX_BYTES, AGENTS_MD_TRUNCATION_NOTE } from '@cairn/core'
import { loadProjectAgentsMd, readAgentsMd, type LoadedAgentsMd } from './agents-md.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-agents-'))
  dirs.push(dir)
  return dir
}

const canCreateFileSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-symlink-'))
  try {
    writeFileSync(join(dir, 'target'), 'x')
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('readAgentsMd', () => {
  it('reads AGENTS.md case-insensitively and prefers the exact name', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'agents.md'), '小写\n')
    writeFileSync(join(dir, 'AGENTS.md'), '标准\n第二行\n')
    const loaded = readAgentsMd(dir)
    expect(loaded).toMatchObject({
      truncated: false,
      lines: 2,
      bytes: Buffer.byteLength('标准\n第二行\n'),
    })
    expect(loaded?.text).toBe('标准\n第二行')
    expect(loaded?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns undefined when the file or directory is missing, or the file is blank', () => {
    expect(readAgentsMd(join(tmpdir(), 'cairn-missing-agents'))).toBeUndefined()
    const dir = tempDir()
    expect(readAgentsMd(dir)).toBeUndefined()
    writeFileSync(join(dir, 'agents.md'), '   \n')
    expect(readAgentsMd(dir)).toBeUndefined()
  })

  it('truncates a file larger than 32 KB and hashes only the included bytes', () => {
    const dir = tempDir()
    const body = `${'a'.repeat(AGENTS_MD_MAX_BYTES)}尾部`
    writeFileSync(join(dir, 'Agents.md'), body)
    const loaded = readAgentsMd(dir)
    expect(loaded?.truncated).toBe(true)
    expect(loaded?.bytes).toBe(Buffer.byteLength(body))
    expect(loaded?.text.endsWith(AGENTS_MD_TRUNCATION_NOTE)).toBe(true)
    expect(loaded?.text).not.toContain('尾部')
    expect(loaded?.lines).toBe(1)
  })

  it.runIf(canCreateFileSymlink)('follows a symlink to the file', () => {
    const dir = tempDir()
    const target = join(dir, 'real.md')
    writeFileSync(target, '来自链接')
    symlinkSync(target, join(dir, 'AGENTS.md'))
    expect(readAgentsMd(dir)?.text).toBe('来自链接')
  })

  it('ignores directories, rejects a directory named AGENTS.md and treats ENOTDIR as missing', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'agents.md'), '内容\n')
    expect(readAgentsMd(dir)?.text).toBe('内容')

    const blocked = tempDir()
    mkdirSync(join(blocked, 'AGENTS.md'))
    expect(readAgentsMd(blocked)).toBeUndefined()

    const file = join(tempDir(), 'plain.txt')
    writeFileSync(file, 'x')
    expect(readAgentsMd(join(file, 'nested'))).toBeUndefined()
  })
})

describe('loadProjectAgentsMd', () => {
  it('does not read when the project switch is off', () => {
    const read = vi.fn((_root: string): LoadedAgentsMd | undefined => {
      throw new Error('should not read')
    })
    expect(loadProjectAgentsMd({ path: '/work', readAgentsMd: false }, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
    read.mockReturnValue(undefined)
    expect(loadProjectAgentsMd({ path: '/work', readAgentsMd: true }, read)).toBeUndefined()
    expect(read).toHaveBeenCalledWith('/work')
  })
})
