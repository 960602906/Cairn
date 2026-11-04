import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { afterEach, describe, expect, it } from 'vitest'
import { checkBundledSearch } from './smoke-search.js'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('checkBundledSearch', () => {
  it('searches a temporary workspace and returns the ripgrep version', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-smoke-search-'))
    expect(await checkBundledSearch(rgPath, join(dir, 'ws'))).toMatch(/^ripgrep \d+/)
  })

  it('fails when ripgrep is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-smoke-search-'))
    await expect(checkBundledSearch(join(dir, 'rg'), join(dir, 'ws'))).rejects.toThrow()
  })
})
