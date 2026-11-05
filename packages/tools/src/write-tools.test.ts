/**
 * `write_file`、`edit_file`（M1-08a）：在临时测试工作区上验证编码与换行的保持、各种失败原因、预览与重新校验。
 */
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createToolRegistry, estimateTokens, ToolError, type ToolFileChange } from '@nexus/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createEditFileTool,
  createWriteFileTool,
  diffHunks,
  encodeText,
  registerWriteTools,
  unifiedDiff,
  withLineEnding,
  WRITE_FILE_MAX_BYTES,
  type EditFileInput,
  type WriteFileInput,
} from './index.js'
import { createFixture, runTool, toolContext, type Fixture } from './testing/fixture.js'

let fx: Fixture
beforeEach(async () => {
  fx = await createFixture()
})
afterEach(() => fx.dispose())

const write = (input: WriteFileInput) => runTool(createWriteFileTool(), input, toolContext(fx.root))
const edit = (input: EditFileInput) => runTool(createEditFileTool(), input, toolContext(fx.root))
const bytes = (rel: string) => readFileSync(path.join(fx.root, ...rel.split('/')))
const text = (rel: string) => bytes(rel).toString('utf8')
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

describe('注册', () => {
  it('两个工具都是 write 类（不并行），参数 schema 可以编译并校验', () => {
    const registry = createToolRegistry()
    registerWriteTools(registry)
    expect(registry.specs()).toEqual([
      expect.objectContaining({ name: 'write_file' }),
      expect.objectContaining({ name: 'edit_file' }),
    ])
    expect(registry.specs().some((s) => s.parallel)).toBe(false)
    expect(registry.validate('write_file', { path: 'a', content: '' })).toMatchObject({ ok: true })
    expect(registry.validate('edit_file', { path: 'a', oldText: '', newText: 'x' })).toMatchObject({
      ok: false,
    })
  })

  it('normalize 给出真实的相对路径作为权限目标；越界拒绝', async () => {
    const ctx = toolContext(fx.root)
    expect(
      await createWriteFileTool().normalize!({ path: './src/../new.txt', content: 'x' }, ctx),
    ).toEqual({ input: { path: 'new.txt', content: 'x' }, targets: { paths: ['new.txt'] } })
    expect(await failure(write({ path: '../outside/secret.txt', content: 'x' }))).toMatchObject({
      code: 'path.outside_workspace',
    })
  })
})

describe('encodeText 与 withLineEnding', () => {
  it('按编码写出 BOM', () => {
    expect([...encodeText('a', 'UTF-8')]).toEqual([0x61])
    expect([...encodeText('a', 'UTF-8 with BOM')]).toEqual([0xef, 0xbb, 0xbf, 0x61])
    expect([...encodeText('a', 'UTF-16 LE')]).toEqual([0xff, 0xfe, 0x61, 0x00])
    expect([...encodeText('a', 'UTF-16 BE')]).toEqual([0xfe, 0xff, 0x00, 0x61])
  })

  it('统一换行风格', () => {
    expect(withLineEnding('a\r\nb\rc\n', 'LF')).toBe('a\nb\nc\n')
    expect(withLineEnding('a\nb\r\n', 'CRLF')).toBe('a\r\nb\r\n')
    expect(withLineEnding('a\nb', 'CR')).toBe('a\rb')
  })
})

describe('unifiedDiff', () => {
  it('超时后改用简化的 diff：首尾相同的行作为上下文', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n'
    const after = 'a\nb\nc\nd\nX\nY\nf\ng\nh\n'
    expect(unifiedDiff('a/f', 'b/f', before, after, 0)).toBe(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -2,7 +2,8 @@',
        ' b',
        ' c',
        ' d',
        '-e',
        '+X',
        '+Y',
        ' f',
        ' g',
        ' h',
      ].join('\n'),
    )
    expect(unifiedDiff('/dev/null', 'b/n', '', 'x\n', 0)).toBe(
      ['--- /dev/null', '+++ b/n', '@@ -0,0 +1,1 @@', '+x'].join('\n'),
    )
    expect(unifiedDiff('a/n', 'b/n', 'x\n', '', 0)).toBe(
      ['--- a/n', '+++ b/n', '@@ -1,1 +0,0 @@', '-x'].join('\n'),
    )
  })
})

describe('write_file', () => {
  it('新建文件（含上级目录），内容原样写入', async () => {
    expect(await write({ path: 'new/dir/file.ts', content: 'a\nb\n' })).toBe(
      'Created new/dir/file.ts (2 lines).',
    )
    expect(text('new/dir/file.ts')).toBe('a\nb\n')
    expect(await write({ path: 'one.txt', content: 'x' })).toBe('Created one.txt (1 line).')
  })

  it('覆盖时保持换行风格与编码', async () => {
    expect(await write({ path: 'src/crlf.ts', content: 'x\ny\nz\n' })).toBe(
      'Overwrote src/crlf.ts (3 lines, previously 2 lines). Kept CRLF line endings.',
    )
    expect(text('src/crlf.ts')).toBe('x\r\ny\r\nz\r\n')

    expect(await write({ path: 'src/bom.txt', content: '新\n' })).toBe(
      'Overwrote src/bom.txt (1 line, previously 2 lines). Kept UTF-8 with BOM.',
    )
    expect(bytes('src/bom.txt')).toEqual(encodeText('新\n', 'UTF-8 with BOM'))

    await write({ path: 'src/utf16be.txt', content: 'ok\n' })
    expect(bytes('src/utf16be.txt')).toEqual(encodeText('ok\n', 'UTF-16 BE'))

    // LF 文件收到 CRLF 内容时改为 LF；混合换行的文件原样写入
    await write({ path: 'README.md', content: '# A\r\n' })
    expect(text('README.md')).toBe('# A\n')
    await write({ path: 'src/mixed.txt', content: 'p\r\nq\n' })
    expect(text('src/mixed.txt')).toBe('p\r\nq\n')
  })

  it('非 UTF-8 与二进制文件整体覆盖为 UTF-8', async () => {
    await write({ path: 'src/latin1.txt', content: 'café\n' })
    expect(text('src/latin1.txt')).toBe('café\n')
    await write({ path: 'src/image.png', content: 'text' })
    expect(text('src/image.png')).toBe('text')
  })

  it('错误：目录、过大', async () => {
    expect(await failure(write({ path: 'src', content: 'x' }))).toEqual({
      code: 'tool.write_file.is_directory',
      message: 'src is a directory.',
    })
    const huge = 'x'.repeat(WRITE_FILE_MAX_BYTES + 1)
    expect(await failure(write({ path: 'huge.txt', content: huge }))).toMatchObject({
      code: 'tool.write_file.too_large',
    })
  })

  it('审批预览：diff 与摘要', async () => {
    const tool = createWriteFileTool()
    const ctx = toolContext(fx.root)
    expect(
      await tool.describeForApproval!(
        { path: 'src/index.ts', content: 'export const a = 2\n' },
        ctx,
      ),
    ).toMatchInlineSnapshot(`
      {
        "diff": "--- a/src/index.ts
      +++ b/src/index.ts
      @@ -1,3 +1,1 @@
      -export const a = 1
      -
      -console.log('hi')
      +export const a = 2",
        "summary": "Overwrite src/index.ts (+1 -3)",
      }
    `)
    expect(await tool.describeForApproval!({ path: 'n.txt', content: 'a\n' }, ctx))
      .toMatchInlineSnapshot(`
      {
        "diff": "--- /dev/null
      +++ b/n.txt
      @@ -0,0 +1,1 @@
      +a",
        "summary": "Create n.txt (+1 -0)",
      }
    `)
  })

  it('审批期间文件被修改或被创建：不写入，要求重新读取', async () => {
    const tool = createWriteFileTool()
    const ctx = toolContext(fx.root)
    await tool.describeForApproval!({ path: 'README.md', content: 'mine\n' }, ctx)
    await fs.writeFile(path.join(fx.root, 'README.md'), '# Changed by the user\n')
    expect(await failure(runTool(tool, { path: 'README.md', content: 'mine\n' }, ctx))).toEqual({
      code: 'tool.write_file.changed_since_preview',
      message:
        'README.md was changed after the change was shown for approval, so it was not written. Read the file again and redo the change.',
    })
    expect(text('README.md')).toBe('# Changed by the user\n')

    await tool.describeForApproval!({ path: 'later.txt', content: 'mine\n' }, ctx)
    await fs.writeFile(path.join(fx.root, 'later.txt'), 'theirs\n')
    expect(await failure(runTool(tool, { path: 'later.txt', content: 'x' }, ctx))).toMatchObject({
      code: 'tool.write_file.changed_since_preview',
    })

    // 没有变化时正常写入；指纹只用一次
    await tool.describeForApproval!({ path: 'README.md', content: 'ok\n' }, ctx)
    expect(await runTool(tool, { path: 'README.md', content: 'ok\n' }, ctx)).toMatch(/^Overwrote/)
    await fs.writeFile(path.join(fx.root, 'README.md'), 'again\n')
    expect(await runTool(tool, { path: 'README.md', content: 'ok\n' }, ctx)).toMatch(/^Overwrote/)
  })

  it('取消时不写入', async () => {
    const controller = new AbortController()
    controller.abort()
    await runTool(
      createWriteFileTool(),
      { path: 'cancelled.txt', content: 'x' },
      toolContext(fx.root, controller.signal),
    )
    await expect(fs.stat(path.join(fx.root, 'cancelled.txt'))).rejects.toThrow()
  })
})

describe('edit_file', () => {
  it('唯一匹配时替换，返回位置与 diff', async () => {
    // 空的上下文行在 diff 中是一个空格
    expect(
      await edit({ path: 'src/index.ts', oldText: "console.log('hi')", newText: 'run()' }),
    ).toBe(
      [
        'Edited src/index.ts: replaced 1 occurrence at line 3.',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,3 +1,3 @@',
        ' export const a = 1',
        ' ',
        "-console.log('hi')",
        '+run()',
      ].join('\n'),
    )
    expect(text('src/index.ts')).toBe('export const a = 1\n\nrun()\n')
  })

  it('保持 CRLF、BOM 与 UTF-16；oldText 用 LF 也能匹配 CRLF 文件', async () => {
    expect(await edit({ path: 'src/crlf.ts', oldText: 'a\nb', newText: 'a\nx\ny' })).toMatch(
      /^Edited src\/crlf.ts: replaced 1 occurrence at line 1. Kept CRLF line endings./,
    )
    expect(text('src/crlf.ts')).toBe('a\r\nx\r\ny\r\n')
    await edit({ path: 'src/crlf.ts', oldText: 'x\r\ny', newText: 'z' })
    expect(text('src/crlf.ts')).toBe('a\r\nz\r\n')

    expect(await edit({ path: 'src/bom.txt', oldText: '世界', newText: 'world' })).toContain(
      'Kept UTF-8 with BOM.',
    )
    expect(bytes('src/bom.txt')).toEqual(encodeText('你好\nworld\n', 'UTF-8 with BOM'))

    expect(await edit({ path: 'src/utf16le.txt', oldText: 'there', newText: 'you' })).toContain(
      'Kept UTF-16 LE.',
    )
    expect(bytes('src/utf16le.txt')).toEqual(encodeText('hi\nyou\n', 'UTF-16 LE'))
  })

  it('混合换行的文件按原文匹配，其他行不变', async () => {
    await edit({ path: 'src/mixed.txt', oldText: 'b\r\nc', newText: 'B\r\nC' })
    expect(text('src/mixed.txt')).toBe('a\nB\r\nC')
    expect(
      await failure(edit({ path: 'src/mixed.txt', oldText: 'a\nB\nC', newText: 'x' })),
    ).toMatchObject({
      code: 'tool.edit_file.no_match',
      message: expect.stringContaining('mixed line endings'),
    })
  })

  it('replaceAll 替换全部；替换文本中的 $ 原样写入', async () => {
    await fs.writeFile(path.join(fx.root, 'rep.txt'), 'foo\nbar\nfoo\n')
    expect(
      await edit({ path: 'rep.txt', oldText: 'foo', newText: "$& $1 $'", replaceAll: true }),
    ).toMatch(/^Edited rep.txt: replaced 2 occurrences\./)
    expect(text('rep.txt')).toBe("$& $1 $'\nbar\n$& $1 $'\n")
  })

  it('失败原因：找不到、缩进不同、不唯一、没有变化', async () => {
    expect(await failure(edit({ path: 'src/index.ts', oldText: 'nope', newText: 'x' }))).toEqual({
      code: 'tool.edit_file.no_match',
      message:
        'oldText was not found in src/index.ts. Read the file again and copy the exact text, including indentation.',
    })
    expect(
      await failure(edit({ path: 'src/index.ts', oldText: "  console.log('hi')  ", newText: 'x' })),
    ).toEqual({
      code: 'tool.edit_file.no_match',
      message:
        'oldText was not found in src/index.ts. A similar text with different indentation or trailing whitespace starts at line 3. Read the file again and copy the exact text.',
    })
    await fs.writeFile(
      path.join(fx.root, 'dup.txt'),
      Array.from({ length: 12 }, () => 'same').join('\n'),
    )
    expect(await failure(edit({ path: 'dup.txt', oldText: 'same', newText: 'x' }))).toEqual({
      code: 'tool.edit_file.ambiguous',
      message:
        'oldText occurs 12 times in dup.txt (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …). Include more surrounding lines to make it unique, or set replaceAll to replace every occurrence.',
    })
    await fs.writeFile(path.join(fx.root, 'two.txt'), 'x\ny\nx\n')
    expect(await failure(edit({ path: 'two.txt', oldText: 'x', newText: 'z' }))).toMatchObject({
      message: expect.stringContaining('occurs 2 times in two.txt (lines 1, 3)'),
    })
    expect(await failure(edit({ path: 'two.txt', oldText: 'x', newText: 'x' }))).toEqual({
      code: 'tool.edit_file.no_change',
      message: 'oldText and newText are the same.',
    })
  })

  it('失败原因：文件不存在、目录、二进制、非 UTF-8、过大', async () => {
    expect(await failure(edit({ path: 'missing.ts', oldText: 'a', newText: 'b' }))).toEqual({
      code: 'tool.edit_file.not_found',
      message: 'File not found: missing.ts. Use write_file to create a new file.',
    })
    expect(await failure(edit({ path: 'src', oldText: 'a', newText: 'b' }))).toMatchObject({
      code: 'tool.edit_file.is_directory',
    })
    expect(
      await failure(edit({ path: 'src/image.png', oldText: 'a', newText: 'b' })),
    ).toMatchObject({ code: 'tool.edit_file.binary' })
    expect(
      await failure(edit({ path: 'src/latin1.txt', oldText: 'c', newText: 'b' })),
    ).toMatchObject({ code: 'tool.edit_file.unsupported_encoding' })
    const big = path.join(fx.root, 'big.bin')
    await fs.writeFile(big, '')
    await fs.truncate(big, WRITE_FILE_MAX_BYTES + 1)
    expect(await failure(edit({ path: 'big.bin', oldText: 'a', newText: 'b' }))).toMatchObject({
      code: 'tool.edit_file.too_large',
    })
  })

  it('预览失败时直接返回原因；审批期间文件被修改时不写入', async () => {
    const tool = createEditFileTool()
    const ctx = toolContext(fx.root)
    await expect(
      tool.describeForApproval!({ path: 'src/index.ts', oldText: 'nope', newText: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'tool.edit_file.no_match' })

    const input = { path: 'src/index.ts', oldText: 'a = 1', newText: 'a = 2' }
    expect(await tool.describeForApproval!(input, ctx)).toMatchObject({
      summary: 'Edit src/index.ts (+1 -1)',
    })
    // 用户在审批期间改了别处，原文片段仍在：依然拒绝
    await fs.appendFile(path.join(fx.root, 'src/index.ts'), '// user\n')
    expect(await failure(runTool(tool, input, ctx))).toMatchObject({
      code: 'tool.edit_file.changed_since_preview',
    })
    expect(text('src/index.ts')).toContain('a = 1')

    // 文件在审批期间被删除
    await tool.describeForApproval!(input, ctx)
    await fs.rm(path.join(fx.root, 'src/index.ts'))
    expect(await failure(runTool(tool, input, ctx))).toMatchObject({
      code: 'tool.edit_file.changed_since_preview',
    })
  })

  it('diff 按上下文给出的 token 上限截断（M1-13a）', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'q'.repeat(20)}`).join('\n')
    await fs.writeFile(path.join(fx.root, 'budget.ts'), `${long}\n`)
    const result = await runTool(
      createEditFileTool(),
      { path: 'budget.ts', oldText: 'q', newText: 'Q', replaceAll: true },
      { ...toolContext(fx.root), maxOutputTokens: 400 },
    )
    expect(result).toContain('[Diff truncated. Use read_file to check the result.]')
    expect(estimateTokens(result)).toBeLessThanOrEqual(400)
  })

  it('很长的 diff 截断', async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'z'.repeat(20)}`).join('\n')
    await fs.writeFile(path.join(fx.root, 'long.ts'), `${long}\n`)
    const result = await edit({ path: 'long.ts', oldText: 'z', newText: 'Z', replaceAll: true })
    expect(result).toMatch(/\[Diff truncated\. Use read_file to check the result\.\]$/)
  })
})

describe('改动记录（M1-08b）', () => {
  const recording = () => {
    const changes: ToolFileChange[] = []
    const ctx = toolContext(fx.root, undefined, async (change) => {
      changes.push(change)
    })
    return { changes, ctx }
  }

  it('新建与覆盖：记录原始字节、块与行数', async () => {
    const { changes, ctx } = recording()
    await runTool(createWriteFileTool(), { path: 'new/a.txt', content: 'x\ny\n' }, ctx)
    await fs.writeFile(path.join(fx.root, 'crlf.txt'), 'a\r\nb\r\n')
    await runTool(createWriteFileTool(), { path: 'crlf.txt', content: 'a\nc\n' }, ctx)
    expect(changes).toEqual([
      {
        path: 'new/a.txt',
        kind: 'create',
        after: Buffer.from('x\ny\n'),
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
        added: 2,
        removed: 0,
      },
      {
        path: 'crlf.txt',
        kind: 'modify',
        before: Buffer.from('a\r\nb\r\n'),
        after: Buffer.from('a\r\nc\r\n'),
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }],
        added: 1,
        removed: 1,
      },
    ])
  })

  it('edit_file 记录改动；取消时既不写入也不记录', async () => {
    const { changes, ctx } = recording()
    await runTool(
      createEditFileTool(),
      { path: 'src/index.ts', oldText: "console.log('hi')", newText: 'run()' },
      ctx,
    )
    expect(changes).toMatchObject([{ path: 'src/index.ts', kind: 'modify', added: 1, removed: 1 }])
    const controller = new AbortController()
    controller.abort()
    const cancelled = toolContext(fx.root, controller.signal, async (c) => {
      changes.push(c)
    })
    expect(
      await runTool(createWriteFileTool(), { path: 'c.txt', content: 'x' }, cancelled),
    ).toContain('not written (cancelled)')
    expect(
      await runTool(
        createEditFileTool(),
        { path: 'src/index.ts', oldText: 'run()', newText: 'x' },
        cancelled,
      ),
    ).toContain('not written (cancelled)')
    expect(changes).toHaveLength(1)
  })

  it('记录失败时文件已写入，结果中说明', async () => {
    const ctx = toolContext(fx.root, undefined, () => Promise.reject(new Error('disk full')))
    expect(await runTool(createWriteFileTool(), { path: 'f.txt', content: 'x' }, ctx)).toContain(
      'could not be recorded',
    )
    expect(text('f.txt')).toBe('x')
    expect(
      await runTool(createEditFileTool(), { path: 'f.txt', oldText: 'x', newText: 'y' }, ctx),
    ).toMatch(/could not be recorded/)
    expect(text('f.txt')).toBe('y')
  })

  it('diffHunks：省略行数时为 1', () => {
    expect(diffHunks('--- a\n+++ b\n@@ -3 +3,2 @@\n-x\n+y\n+z\n@@ -10,0 +12 @@\n+w')).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 },
      { oldStart: 10, oldLines: 0, newStart: 12, newLines: 1 },
    ])
  })
})
