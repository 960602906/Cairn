import fs from 'node:fs/promises'
import path from 'node:path'
import { createToolRegistry, estimateTokens, ToolError } from '@nexus/core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  listDirTool,
  readFileTool,
  READ_FILE_MAX_BYTES,
  registerReadTools,
  type ListDirInput,
  type ReadFileInput,
} from './index.js'
import { createFixture, runTool, toolContext, type Fixture } from './testing/fixture.js'

let fx: Fixture
beforeAll(async () => {
  fx = await createFixture()
})
afterAll(() => fx.dispose())
afterEach(() => {
  vi.restoreAllMocks()
})

const read = (input: ReadFileInput) => runTool(readFileTool, input, toolContext(fx.root))
const list = (input: ListDirInput = {}) => runTool(listDirTool, input, toolContext(fx.root))
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    const e = error as ToolError
    return { code: e.code, message: e.message, params: e.params }
  }
  throw new Error('expected a ToolError')
}

describe('注册与参数校验', () => {
  it('三个工具都是 read 类，参数 schema 可以编译并校验', () => {
    const registry = createToolRegistry()
    registerReadTools(registry, { ripgrepPath: 'rg' })
    expect(registry.specs()).toMatchObject([
      { name: 'read_file', parallel: true },
      { name: 'list_dir', parallel: true },
      { name: 'search', parallel: true },
    ])
    expect(registry.validate('read_file', { path: 'a', offset: 1, limit: 10 })).toMatchObject({
      ok: true,
    })
    expect(registry.validate('read_file', { path: 'a', offset: 0 })).toMatchObject({ ok: false })
    expect(registry.validate('read_file', { path: 'a', limit: 2001 })).toMatchObject({ ok: false })
    expect(registry.validate('read_file', { path: 'a', extra: 1 })).toMatchObject({ ok: false })
    expect(registry.validate('list_dir', {})).toMatchObject({ ok: true })
    expect(registry.validate('list_dir', { depth: 11 })).toMatchObject({ ok: false })
    expect(registry.validate('search', { pattern: 'a', context: 2, limit: 5 })).toMatchObject({
      ok: true,
    })
    expect(registry.validate('search', { pattern: '' })).toMatchObject({ ok: false })
    expect(registry.validate('search', { pattern: 'a', context: 11 })).toMatchObject({ ok: false })
  })

  it('normalize 给出真实的相对路径作为权限目标', async () => {
    const ctx = toolContext(fx.root)
    expect(await readFileTool.normalize!({ path: './src/../README.md' }, ctx)).toEqual({
      input: { path: 'README.md' },
      targets: { paths: ['README.md'] },
    })
    expect(await listDirTool.normalize!({}, ctx)).toEqual({
      input: { path: '.' },
      targets: { paths: ['.'] },
    })
  })
})

describe('read_file', () => {
  it('带行号的完整内容', async () => {
    expect(await read({ path: 'src/index.ts' })).toMatchInlineSnapshot(`
      "File: src/index.ts | lines 1-3 of 3 | UTF-8 | LF
      1	export const a = 1
      2
      3	console.log('hi')"
    `)
  })

  it('按行范围读取，并提示如何继续', async () => {
    expect(await read({ path: 'big.txt', offset: 10, limit: 3 })).toMatchInlineSnapshot(`
      "File: big.txt | lines 10-12 of 3000 | UTF-8 | LF
      10	10
      11	11
      12	12
      [Showing lines 10-12 of 3000. Call read_file with offset=13 to continue.]"
    `)
  })

  it('大文件默认分段：每段最多 2000 行', async () => {
    const text = await read({ path: 'big.txt' })
    const lines = text.split('\n')
    expect(lines[0]).toBe('File: big.txt | lines 1-2000 of 3000 | UTF-8 | LF')
    expect(lines.at(-2)).toBe('2000\t2000')
    expect(lines.at(-1)).toBe(
      '[Showing lines 1-2000 of 3000. Call read_file with offset=2001 to continue.]',
    )
    expect(await read({ path: 'big.txt', offset: 2001 })).toContain('lines 2001-3000 of 3000')
  })

  it('超过字符预算时提前分段', async () => {
    const text = await read({ path: 'wide.txt' })
    expect(text.length).toBeLessThan(26_000)
    expect(text).toMatch(
      /\[Showing lines 1-\d+ of 1000\. Call read_file with offset=\d+ to continue\.\]$/,
    )
  })

  it('按上下文给出的 token 上限分段（M1-13a），中文按每字 1 token', async () => {
    const ctx = { ...toolContext(fx.root), maxOutputTokens: 600 }
    const wide = await runTool(readFileTool, { path: 'wide.txt' }, ctx)
    expect(estimateTokens(wide)).toBeLessThanOrEqual(600)
    expect(wide).toMatch(/Call read_file with offset=\d+ to continue\.\]$/)

    await fs.writeFile(
      path.join(fx.root, 'cjk.txt'),
      Array(200).fill('中文内容'.repeat(10)).join('\n'),
    )
    const cjk = await runTool(readFileTool, { path: 'cjk.txt' }, ctx)
    expect(estimateTokens(cjk)).toBeLessThanOrEqual(600)
    const shown = Number(/lines 1-(\d+) of 200/.exec(cjk)![1])
    expect(shown).toBeGreaterThan(5)
    expect(shown).toBeLessThan(20)
    await fs.rm(path.join(fx.root, 'cjk.txt'))
  })

  it('换行风格、BOM 与 UTF-16', async () => {
    expect(await read({ path: 'src/crlf.ts' })).toMatchInlineSnapshot(`
      "File: src/crlf.ts | lines 1-2 of 2 | UTF-8 | CRLF
      1	a
      2	b"
    `)
    expect(await read({ path: 'src/mixed.txt' })).toContain('| UTF-8 | mixed\n')
    expect(await read({ path: 'src/bom.txt' })).toMatchInlineSnapshot(`
      "File: src/bom.txt | lines 1-2 of 2 | UTF-8 with BOM | LF
      1	你好
      2	世界"
    `)
    expect(await read({ path: 'src/utf16le.txt' })).toMatchInlineSnapshot(`
      "File: src/utf16le.txt | lines 1-2 of 2 | UTF-16 LE | LF
      1	hi
      2	there"
    `)
    expect(await read({ path: 'src/utf16be.txt' })).toContain('UTF-16 BE | LF\n1\thi')
  })

  it('非 UTF-8 文件：替换非法字节并提示', async () => {
    expect(await read({ path: 'src/latin1.txt' })).toMatchInlineSnapshot(`
      "File: src/latin1.txt | lines 1-1 of 1 | UTF-8 | LF
      1	caf�
      [The file is not valid UTF-8. Invalid bytes are shown as U+FFFD.]"
    `)
  })

  it('二进制文件、空文件与超长行', async () => {
    expect(await read({ path: 'src/image.png' })).toBe(
      'File: src/image.png | binary file, 10 bytes, not shown.',
    )
    expect(await read({ path: 'src/empty.txt' })).toBe('File: src/empty.txt | empty | UTF-8')
    const long = await read({ path: 'long.txt' })
    expect(long).toContain(
      `1\t${'y'.repeat(2000)}… [line truncated, 500 more characters]\n2\tshort`,
    )
  })

  it('错误：目录、不存在、越界、超出文件末尾、文件过大', async () => {
    expect(await failure(read({ path: 'src' }))).toMatchObject({
      code: 'tool.read_file.is_directory',
      message: 'src is a directory. Use list_dir to see its contents.',
    })
    expect(await failure(read({ path: 'missing.txt' }))).toMatchObject({
      code: 'tool.read_file.not_found',
      params: { path: 'missing.txt' },
    })
    expect(await failure(read({ path: '../outside/secret.txt' }))).toMatchObject({
      code: 'path.outside_workspace',
      params: { path: '../outside/secret.txt' },
    })
    expect(await failure(read({ path: 'src/crlf.ts', offset: 3 }))).toMatchObject({
      code: 'tool.read_file.offset_out_of_range',
      params: { offset: 3, lines: 2 },
    })
    const huge = path.join(fx.root, 'huge.bin')
    await fs.writeFile(huge, '')
    await fs.truncate(huge, READ_FILE_MAX_BYTES + 1)
    expect(await failure(read({ path: 'huge.bin' }))).toMatchObject({
      code: 'tool.read_file.too_large',
    })
    await fs.rm(huge)
  })

  it('其他读取错误', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    )
    expect(await failure(read({ path: 'README.md' }))).toMatchObject({
      code: 'tool.read_file.unreadable',
      message: 'Cannot read README.md (EACCES).',
    })
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('weird'))
    expect(await failure(read({ path: 'README.md' }))).toMatchObject({
      message: 'Cannot read README.md (unknown error).',
    })
  })
})

describe('list_dir', () => {
  it('工作区根目录：遵守 .gitignore，跳过 .git，默认展开两层', async () => {
    expect(await list()).toMatchInlineSnapshot(`
      "Directory: . | depth 2
      .gitignore
      big.txt
      empty-dir/
      keep.log
      long.txt
      README.md
      src/
        bom.txt
        crlf.ts
        empty.txt
        image.png
        index.ts
        latin1.txt
        mixed.txt
        nested/
        utf16be.txt
        utf16le.txt
      wide.txt
      [2 entries hidden by .gitignore]"
    `)
  })

  it('子目录中的 .gitignore 与更深的层级', async () => {
    expect(await list({ path: 'src/nested', depth: 3 })).toMatchInlineSnapshot(`
      "Directory: src/nested | depth 3
      .gitignore
      deeper/
        leaf.txt
      visible.txt
      [1 entry hidden by .gitignore]"
    `)
  })

  it('列出子目录时也应用上级目录的 .gitignore', async () => {
    await fs.mkdir(path.join(fx.root, 'src/logs'))
    await fs.writeFile(path.join(fx.root, 'src/logs/x.log'), '')
    await fs.writeFile(path.join(fx.root, 'src/logs/keep.log'), '')
    try {
      expect(await list({ path: 'src/logs' })).toBe(
        'Directory: src/logs | depth 2\nkeep.log\n[1 entry hidden by .gitignore]',
      )
    } finally {
      await fs.rm(path.join(fx.root, 'src/logs'), { recursive: true })
    }
  })

  it('条目数达到上限时停止并提示', async () => {
    const text = await list({ limit: 3 })
    expect(text.split('\n')).toEqual([
      'Directory: . | depth 2',
      '.gitignore',
      'big.txt',
      'empty-dir/',
      '[Listing stopped at 3 entries. List a subdirectory or reduce depth to see more.]',
      '[2 entries hidden by .gitignore]',
    ])
  })

  it('超过 token 上限时停止并提示（至少列出一项）', async () => {
    const text = await runTool(listDirTool, {}, { ...toolContext(fx.root), maxOutputTokens: 3 })
    expect(text.split('\n')).toEqual([
      'Directory: . | depth 2',
      '.gitignore',
      '[Listing stopped at 1 entries. List a subdirectory or reduce depth to see more.]',
      '[1 entry hidden by .gitignore]',
    ])
  })

  it('空目录；符号链接以 @ 标出且不展开', async () => {
    expect(await list({ path: 'empty-dir' })).toBe(
      'Directory: empty-dir | depth 2\n(empty directory)',
    )
    const link = path.join(fx.root, 'empty-dir', 'link')
    await fs.symlink(fx.outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(await list({ path: 'empty-dir' })).toBe('Directory: empty-dir | depth 2\nlink@')
    } finally {
      await fs.rm(link, { recursive: true, force: true })
    }
  })

  it('错误：不是目录、不存在、越界、无法读取', async () => {
    expect(await failure(list({ path: 'README.md' }))).toMatchObject({
      code: 'tool.list_dir.not_directory',
    })
    expect(await failure(list({ path: 'nope' }))).toMatchObject({
      code: 'tool.list_dir.not_found',
      message: 'Directory not found: nope',
    })
    expect(await failure(list({ path: '..' }))).toMatchObject({ code: 'path.outside_workspace' })
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    )
    expect(await failure(list({ path: 'src' }))).toMatchObject({
      code: 'tool.list_dir.unreadable',
      message: 'Cannot read src (EACCES).',
    })
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('weird'))
    expect(await failure(list({ path: 'src' }))).toMatchObject({
      code: 'tool.list_dir.unreadable',
      message: 'Cannot read src (unknown error).',
    })
  })

  it('子目录无法读取时标注并继续', async () => {
    const real = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, options: never) =>
      dir.endsWith(`${path.sep}nested`)
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : real(dir, options)) as typeof fs.readdir)
    const text = await list({ path: 'src', depth: 3 })
    expect(text).toContain('\nnested/ [unreadable: EACCES]\nutf16be.txt')
  })

  it('取消后不再继续列出', async () => {
    const controller = new AbortController()
    controller.abort()
    const text = await runTool(listDirTool, {}, toolContext(fx.root, controller.signal))
    expect(text).toBe('Directory: . | depth 2\n(empty directory)')
  })
})

describe('路径错误的说明', () => {
  it('未知的错误码使用通用说明', async () => {
    const ctx = {
      ...toolContext(fx.root),
      resolvePath: async () => ({ ok: false as const, code: 'path.other' }),
    }
    expect(await failure(runTool(readFileTool, { path: 'x' }, ctx))).toEqual({
      code: 'path.other',
      message: 'The path is invalid. (path: x)',
      params: { path: 'x' },
    })
  })
})
