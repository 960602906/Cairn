/**
 * `search`（M1-07b）：用 `@vscode/ripgrep` 提供的 ripgrep 在固定的测试工作区上做快照测试。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { ToolError } from '@nexus/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bundledRipgrepPath,
  createSearchTool,
  READ_FILE_MAX_OUTPUT_CHARS,
  RIPGREP_BINARY,
  ripgrepArgs,
  ripgrepVersion,
  SEARCH_MAX_LINE_CHARS,
  type SearchInput,
} from './index.js'
import { createFixture, runTool, toolContext, type Fixture } from './testing/fixture.js'

let fx: Fixture
beforeAll(async () => {
  fx = await createFixture()
})
afterAll(() => fx.dispose())

const tool = createSearchTool({ ripgrepPath: rgPath })
const search = (input: SearchInput) => runTool(tool, input, toolContext(fx.root))
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    const e = error as ToolError
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a ToolError')
}

describe('ripgrep', () => {
  it('可以找到并运行；版本与许可证登记一致（scripts/bundled-binaries.json）', async () => {
    const registry = JSON.parse(
      readFileSync(new URL('../../../scripts/bundled-binaries.json', import.meta.url), 'utf8'),
    ) as { binaries: { name: string; version: string }[] }
    const recorded = registry.binaries.find((b) => b.name === 'ripgrep')!.version
    expect(await ripgrepVersion(rgPath)).toMatch(new RegExp(`^ripgrep ${recorded} `))
    await expect(ripgrepVersion(`${fx.root}/missing-rg`)).rejects.toThrow()
  })

  it('打包后的位置：app.asar 中的文件改到 app.asar.unpacked', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    const bin = ['', 'app', 'resources', 'app.asar', 'out', 'bin'].join(sep)
    expect(bundledRipgrepPath(bin)).toBe(
      ['', 'app', 'resources', 'app.asar.unpacked', 'out', 'bin', RIPGREP_BINARY].join(sep),
    )
    const dev = ['', 'repo', 'apps', 'desktop', 'out', 'bin'].join(sep)
    expect(bundledRipgrepPath(dev)).toBe(`${dev}${sep}${RIPGREP_BINARY}`)
  })

  it('参数：固定的选项，用户输入只作为参数值', () => {
    expect(ripgrepArgs({ pattern: '-e' }, '.')).toEqual([
      '--json',
      '--no-config',
      '--no-require-git',
      '--no-ignore-parent',
      '--no-ignore-global',
      '--hidden',
      '--glob=!.git',
      '--sort=path',
      '--crlf',
      '--max-filesize=10485760',
      '--case-sensitive',
      '--regexp',
      '-e',
    ])
    expect(
      ripgrepArgs(
        { pattern: 'a', ignoreCase: true, literal: true, context: 2, glob: '*.ts' },
        '-src',
      ).slice(10),
    ).toEqual([
      '--ignore-case',
      '--fixed-strings',
      '--context=2',
      '--glob=*.ts',
      '--regexp',
      'a',
      '--',
      '-src',
    ])
  })
})

describe('search', () => {
  it('按文件分组，按路径排序；跳过 .gitignore 忽略的文件、.git 与二进制文件', async () => {
    expect(await search({ pattern: 'hi' })).toMatchInlineSnapshot(`
      "Search: "hi" in . | 3 matching lines in 3 files
      src/index.ts
        3: console.log('hi')
      src/utf16be.txt
        1: hi
      src/utf16le.txt
        1: hi"
    `)
    expect(await search({ pattern: 'ignored' })).toBe('Search: "ignored" in . | no matches')
    expect(await search({ pattern: 'refs' })).toBe('Search: "refs" in . | no matches')
    expect(await search({ pattern: 'PNG' })).toBe('Search: "PNG" in . | no matches')
    // `!keep.log` 取消忽略；子目录的 .gitignore 隐藏 secret.txt
    expect(await search({ pattern: 'kept|secret' })).toMatchInlineSnapshot(`
      "Search: "kept|secret" in . | 2 matching lines in 2 files
      keep.log
        1: kept
      src/nested/.gitignore
        1: secret.txt"
    `)
  })

  it('编码与换行：BOM、非 UTF-8、CRLF 行尾的 $', async () => {
    expect(await search({ pattern: '世界|caf' })).toMatchInlineSnapshot(`
      "Search: "世界|caf" in . | 2 matching lines in 2 files
      src/bom.txt
        2: 世界
      src/latin1.txt
        1: caf�"
    `)
    expect(await search({ pattern: '^b$' })).toMatchInlineSnapshot(`
      "Search: "^b$" in . | 2 matching lines in 2 files
      src/crlf.ts
        2: b
      src/mixed.txt
        2: b"
    `)
  })

  it('path、glob、ignoreCase、literal', async () => {
    expect(await search({ pattern: 'e', path: 'src/nested' })).toMatchInlineSnapshot(`
      "Search: "e" in src/nested | 3 matching lines in 3 files
      src/nested/.gitignore
        1: secret.txt
      src/nested/deeper/leaf.txt
        1: leaf
      src/nested/visible.txt
        1: visible"
    `)
    expect(await search({ pattern: 'e', path: './src/nested/../nested/visible.txt' })).toBe(
      'Search: "e" in src/nested/visible.txt | 1 matching line in 1 file\nsrc/nested/visible.txt\n  1: visible',
    )
    expect(await search({ pattern: 'e', path: 'src', glob: 'l*.txt' })).toMatchInlineSnapshot(`
      "Search: "e" in src (glob "l*.txt") | 1 matching line in 1 file
      src/nested/deeper/leaf.txt
        1: leaf"
    `)
    // glob 明确选中的文件即使被 .gitignore 忽略也会搜索；被忽略的目录仍然跳过
    expect(await search({ pattern: 'ignored', glob: '*.log' })).toContain('app.log\n  1: ignored')
    expect(await search({ pattern: 'ignored', glob: '*.js' })).toBe(
      'Search: "ignored" in . (glob "*.js") | no matches',
    )
    expect(await search({ pattern: 'DEMO', ignoreCase: true })).toContain('README.md\n  1: # Demo')
    expect(await search({ pattern: 'DEMO' })).toContain('no matches')
    expect(await search({ pattern: "log('", literal: true })).toContain('src/index.ts\n  3:')
  })

  it('上下文与数量上限：不显示未列出的匹配的上下文', async () => {
    expect(await search({ pattern: '^5$|^7$|^20$', path: 'big.txt', context: 1, limit: 2 }))
      .toMatchInlineSnapshot(`
        "Search: "^5$|^7$|^20$" in big.txt | 2 matching lines in 1 file
        big.txt
          4- 4
          5: 5
          6- 6
          7: 7
          8- 8
        [Stopped at 2 matching lines (limit). Narrow the search with path, glob or a more specific pattern.]"
      `)
    expect(await search({ pattern: '^1[01]$', path: 'big.txt', context: 2 }))
      .toMatchInlineSnapshot(`
      "Search: "^1[01]$" in big.txt | 2 matching lines in 1 file
      big.txt
        8- 8
        9- 9
        10: 10
        11: 11
        12- 12
        13- 13"
    `)
    expect(await search({ pattern: '^(3|9)$', path: 'big.txt', context: 1 })).toContain(
      '  4- 4\n  --\n  8- 8',
    )
  })

  it('输出预算与长行截断', async () => {
    const wide = await search({ pattern: 'x', path: 'wide.txt', limit: 1000 })
    expect(wide.length).toBeLessThan(READ_FILE_MAX_OUTPUT_CHARS + 500)
    expect(wide).toMatch(/\[Stopped at \d+ matching lines \(output size limit\)/)
    const long = await search({ pattern: 'y', path: 'long.txt' })
    expect(long).toContain(`  1: ${'y'.repeat(SEARCH_MAX_LINE_CHARS)}… [2000 more characters]`)
  })

  it('normalize 给出真实的相对路径作为权限目标', async () => {
    const ctx = toolContext(fx.root)
    expect(await tool.normalize!({ pattern: 'a' }, ctx)).toEqual({
      input: { pattern: 'a', path: '.' },
      targets: { paths: ['.'] },
    })
    expect(await tool.normalize!({ pattern: 'a', path: 'src/../src/' }, ctx)).toMatchObject({
      targets: { paths: ['src'] },
    })
  })

  it('错误：无效的正则或 glob、路径不存在或越界、找不到 ripgrep', async () => {
    expect(await failure(search({ pattern: '(' }))).toMatchObject({
      code: 'tool.search.invalid_pattern',
      message: expect.stringContaining('regex parse error'),
    })
    expect(await failure(search({ pattern: 'a', glob: '[' }))).toMatchObject({
      code: 'tool.search.invalid_pattern',
      message: expect.stringContaining('error parsing glob'),
    })
    expect(await failure(search({ pattern: 'a', path: 'nope' }))).toEqual({
      code: 'tool.search.not_found',
      message: 'Path not found: nope',
    })
    expect(await failure(search({ pattern: 'a', path: '../outside' }))).toMatchObject({
      code: 'path.outside_workspace',
    })
    const missing = createSearchTool({ ripgrepPath: `${fx.root}/missing-rg` })
    expect(await failure(runTool(missing, { pattern: 'a' }, toolContext(fx.root)))).toMatchObject({
      code: 'tool.search.unavailable',
    })
  })

  // 读取没有写入方的命名管道时 ripgrep 一直等待，用来稳定地触发超时与取消（Windows 没有 mkfifo）
  it.runIf(process.platform !== 'win32')('超时返回已找到的结果；取消时结束 ripgrep', async () => {
    execFileSync('mkfifo', [path.join(fx.root, 'pipe')])
    const slow = createSearchTool({ ripgrepPath: rgPath, timeoutMs: 200 })
    expect(await runTool(slow, { pattern: 'a', path: 'pipe' }, toolContext(fx.root))).toBe(
      'Search: "a" in pipe | no matches\n[The search timed out before it finished.]',
    )
    const controller = new AbortController()
    const pending = runTool(
      tool,
      { pattern: 'a', path: 'pipe' },
      toolContext(fx.root, controller.signal),
    )
    setTimeout(() => controller.abort(), 50)
    await expect(pending).resolves.toContain('no matches')
  })
})
