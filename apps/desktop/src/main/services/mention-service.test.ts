import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { createMemoryStorage } from '@cairn/storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMentionService,
  MAX_INDEXED_FILES,
  MENTION_CONTEXT_HEADER,
  MENTION_DIR_LIMIT,
  MENTION_FILE_LIMIT,
  MENTION_TOTAL_LIMIT,
  normalizeMentionPath,
  ripgrepFileLister,
  searchEntries,
} from './mention-service.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-mentions-'))
  dirs.push(dir)
  return dir
}

function write(root: string, relative: string, content: string | Buffer) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function setup(listFiles: (root: string) => Promise<string[]> = async () => []) {
  const root = tempDir()
  const storage = createMemoryStorage()
  storage.projects.create({ projectId: 'p1', name: 'Demo', path: root })
  storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: root, title: '' })
  let now = 1_000
  const list = vi.fn(listFiles)
  const service = createMentionService({ storage, listFiles: list, now: () => now })
  return { root, service, list, tick: (ms: number) => (now += ms) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('searchEntries', () => {
  const files = ['README.md', 'src/app.ts', 'src/components/Composer.tsx', 'docs/adr/0037.md']

  it('lists the top level for an empty query, folders first', () => {
    expect(searchEntries(files, '', 10)).toEqual({
      entries: [
        { path: 'docs', kind: 'dir' },
        { path: 'src', kind: 'dir' },
        { path: 'README.md', kind: 'file' },
      ],
      truncated: false,
    })
  })

  it('lists the children of a folder when the query ends with a slash', () => {
    expect(searchEntries(files, 'SRC/', 10).entries).toEqual([
      { path: 'src/components', kind: 'dir' },
      { path: 'src/app.ts', kind: 'file' },
    ])
    expect(searchEntries(files, 'src\\', 10).entries.map((e) => e.path)).toEqual([
      'src/components',
      'src/app.ts',
    ])
  })

  it('ranks name matches before path and fuzzy matches', () => {
    const result = searchEntries([...files, 'src/composer-tokens.ts', 'lib/c-o-m-p.ts'], 'comp', 10)
    expect(result.entries.map((e) => e.path)).toEqual([
      'src/components',
      'src/composer-tokens.ts',
      'src/components/Composer.tsx',
      'lib/c-o-m-p.ts',
    ])
    expect(searchEntries(files, 'readme.md', 10).entries[0]).toEqual({
      path: 'README.md',
      kind: 'file',
    })
    expect(searchEntries(files, 'adr/00', 10).entries.map((e) => e.path)).toEqual([
      'docs/adr/0037.md',
    ])
    expect(searchEntries(files, 'zzz', 10).entries).toEqual([])
  })

  it('truncates to the limit', () => {
    expect(searchEntries(files, 's', 2)).toMatchObject({ truncated: true })
    expect(searchEntries(files, 's', 2).entries).toHaveLength(2)
  })
})

describe('normalizeMentionPath', () => {
  it('accepts relative paths and rejects anything that could leave the root', () => {
    expect(normalizeMentionPath(' src\\a.ts ')).toBe('src/a.ts')
    expect(normalizeMentionPath('src/')).toBe('src')
    expect(normalizeMentionPath('')).toBeUndefined()
    expect(normalizeMentionPath('/')).toBeUndefined()
    expect(normalizeMentionPath('/etc/passwd')).toBeUndefined()
    expect(normalizeMentionPath('C:/Windows')).toBeUndefined()
    expect(normalizeMentionPath('../x')).toBeUndefined()
    expect(normalizeMentionPath('a/./b')).toBeUndefined()
    expect(normalizeMentionPath('a//b')).toBeUndefined()
  })
})

describe('ripgrepFileLister', () => {
  it('lists files with ripgrep, respecting .gitignore and skipping .git', async () => {
    const root = tempDir()
    // ripgrep 只在 git 仓库里读 .gitignore
    mkdirSync(path.join(root, '.git'))
    write(root, '.gitignore', 'dist/\n')
    write(root, 'src/a.ts', 'a')
    write(root, 'dist/out.js', 'x')
    write(root, '.git/config', '')
    const files = await ripgrepFileLister(rgPath)(root)
    expect(files.sort()).toEqual(['src/a.ts'])
  })

  it('returns nothing for an empty folder and rejects when ripgrep cannot run', async () => {
    expect(await ripgrepFileLister(rgPath)(tempDir())).toEqual([])
    await expect(
      ripgrepFileLister(path.join(tempDir(), 'missing-rg'))(tempDir()),
    ).rejects.toBeInstanceOf(Error)
  })
})

describe('mention service', () => {
  it('searches a session workspace or a project, caching the file list briefly', async () => {
    const ctx = setup(async () => ['src/a.ts', 'b.md'])
    expect(await ctx.service.search({ sessionId: 's1', query: 'a.ts' })).toEqual({
      entries: [{ path: 'src/a.ts', kind: 'file' }],
      truncated: false,
    })
    await ctx.service.search({ projectId: 'p1', query: '' })
    expect(ctx.list).toHaveBeenCalledTimes(1)
    ctx.tick(10_001)
    await ctx.service.search({ sessionId: 's1', query: '', limit: 1 })
    expect(ctx.list).toHaveBeenCalledTimes(2)
  })

  it('indexes at most MAX_INDEXED_FILES files', async () => {
    const many = Array.from({ length: MAX_INDEXED_FILES + 10 }, (_, i) => `f${i}.txt`)
    const ctx = setup(async () => many)
    const result = await ctx.service.search({ sessionId: 's1', query: 'f', limit: 100 })
    expect(result.truncated).toBe(true)
    expect(
      await ctx.service.search({ sessionId: 's1', query: `f${MAX_INDEXED_FILES + 5}.txt` }),
    ).toMatchObject({ entries: [] })
  })

  it('returns no candidates when listing fails, and retries next time', async () => {
    let fail = true
    const ctx = setup(async () => {
      if (fail) throw new Error('boom')
      return ['a.ts']
    })
    expect(await ctx.service.search({ sessionId: 's1', query: '' })).toEqual({
      entries: [],
      truncated: false,
    })
    fail = false
    expect((await ctx.service.search({ sessionId: 's1', query: '' })).entries).toHaveLength(1)
  })

  it('reports unknown sessions and projects', async () => {
    const ctx = setup()
    await expect(ctx.service.search({ sessionId: 'nope', query: '' })).rejects.toMatchObject({
      code: 'fs.session_not_found',
    })
    await expect(ctx.service.search({ projectId: 'nope', query: '' })).rejects.toMatchObject({
      code: 'fs.project_not_found',
    })
    await expect(ctx.service.search({ query: '' })).rejects.toMatchObject({
      code: 'fs.project_not_found',
    })
    await expect(ctx.service.expand({ sessionId: 'nope', mentions: [] })).rejects.toMatchObject({
      code: 'fs.session_not_found',
    })
  })

  it('expands files, line ranges and folders into model context', async () => {
    const ctx = setup()
    write(ctx.root, 'src/a.ts', 'one\ntwo\nthree\n')
    write(ctx.root, 'src/b.ts', 'b')
    write(ctx.root, 'src/sub/c.ts', 'c')
    write(ctx.root, 'my docs/x &amp y.md', 'q')
    const result = await ctx.service.expand({
      sessionId: 's1',
      mentions: [
        { path: 'src/a.ts' },
        { path: 'src/a.ts', lines: { start: 2, end: 9 } },
        { path: 'src/' },
        { path: 'my docs/x &amp y.md' },
      ],
    })
    expect(result.mentions).toEqual([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/a.ts', lines: { start: 2, end: 9 }, kind: 'file' },
      { path: 'src', kind: 'dir' },
      { path: 'my docs/x &amp y.md', kind: 'file' },
    ])
    expect(result.context).toBe(
      [
        MENTION_CONTEXT_HEADER,
        '',
        '<file path="src/a.ts">\none\ntwo\nthree\n</file>',
        '',
        '<file path="src/a.ts" lines="2-3">\ntwo\nthree\n</file>',
        '',
        '<directory path="src/">\nsub/\na.ts\nb.ts\n</directory>',
        '',
        '<file path="my docs/x &amp;amp y.md">\nq\n</file>',
      ].join('\n'),
    )
  })

  it('skips duplicates and anything missing, outside the workspace or not a file', async () => {
    const ctx = setup()
    write(ctx.root, 'a.ts', 'a')
    const outside = tempDir()
    write(outside, 'secret.txt', 'secret')
    symlinkSync(
      outside,
      path.join(ctx.root, 'link'),
      process.platform === 'win32' ? 'junction' : undefined,
    )
    const result = await ctx.service.expand({
      sessionId: 's1',
      mentions: [
        { path: 'a.ts' },
        { path: 'a.ts/' },
        { path: 'missing.ts' },
        { path: '../secret.txt' },
        { path: 'link/secret.txt' },
        { path: '/etc/passwd' },
      ],
    })
    expect(result.mentions).toEqual([{ path: 'a.ts', kind: 'file' }])
    expect(result.context).not.toContain('secret')
  })

  it('returns no context when nothing could be expanded', async () => {
    const ctx = setup()
    expect(await ctx.service.expand({ sessionId: 's1', mentions: [{ path: 'nope' }] })).toEqual({
      mentions: [],
      context: undefined,
    })
  })

  it('returns nothing when the workspace folder is gone', async () => {
    const ctx = setup()
    rmSync(ctx.root, { recursive: true, force: true })
    expect(await ctx.service.expand({ sessionId: 's1', mentions: [{ path: 'a.ts' }] })).toEqual({
      mentions: [],
      context: undefined,
    })
  })

  it('omits binary and oversized files, and stops adding content past the budget', async () => {
    const ctx = setup()
    write(ctx.root, 'bin.dat', Buffer.from([0, 1, 2, 0, 3]))
    write(ctx.root, 'big.txt', 'x'.repeat(MENTION_FILE_LIMIT + 1))
    write(ctx.root, 'huge.txt', 'y'.repeat(2 * 1024 * 1024 + 1))
    const chunk = 'z'.repeat(MENTION_FILE_LIMIT - 10)
    const fill = Math.ceil(MENTION_TOTAL_LIMIT / chunk.length)
    for (let i = 0; i < fill; i += 1) write(ctx.root, `part${i}.txt`, chunk)
    const result = await ctx.service.expand({
      sessionId: 's1',
      mentions: [
        { path: 'bin.dat' },
        { path: 'big.txt' },
        { path: 'huge.txt' },
        ...Array.from({ length: fill }, (_, i) => ({ path: `part${i}.txt` })),
      ],
    })
    expect(result.mentions).toHaveLength(3 + fill)
    expect(result.context).toContain('<file path="bin.dat" omitted="binary"/>')
    expect(result.context).toContain('<file path="big.txt" total_lines="1" omitted="too large">')
    expect(result.context).toContain('<file path="huge.txt" omitted="too large">')
    expect(result.context).toContain(`<file path="part${fill - 1}.txt" total_lines="1" omitted`)
    expect(result.context).toContain(`<file path="part0.txt">\n${chunk}\n</file>`)
  })

  it('lists at most MENTION_DIR_LIMIT entries of a folder and hides .git', async () => {
    const ctx = setup()
    mkdirSync(path.join(ctx.root, '.git'))
    for (let i = 0; i < MENTION_DIR_LIMIT + 3; i += 1) write(ctx.root, `d/f${i}.txt`, '')
    const result = await ctx.service.expand({ sessionId: 's1', mentions: [{ path: 'd' }] })
    expect(result.context).toContain('… 3 more entries')
    const root = await ctx.service.expand({ sessionId: 's1', mentions: [{ path: 'd/..' }] })
    expect(root.mentions).toEqual([])
  })

  it('ignores a file that cannot be read', async () => {
    const ctx = setup()
    write(ctx.root, 'a.ts', 'a')
    const fsp = await import('node:fs/promises')
    const spy = vi.spyOn(fsp.default, 'readFile').mockRejectedValueOnce(new Error('EACCES'))
    const result = await ctx.service.expand({ sessionId: 's1', mentions: [{ path: 'a.ts' }] })
    spy.mockRestore()
    expect(result).toEqual({ mentions: [], context: undefined })
  })
})
