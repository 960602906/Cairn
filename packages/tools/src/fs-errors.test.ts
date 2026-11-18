/**
 * 文件系统异常的兜底路径：真实文件系统很难稳定制造“没有 errno 的错误”，
 * 这里按路径标记让 stat/readdir/readFile/writeFile 抛出普通 Error，验证各工具的错误文案。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let readCounts = new Map<string, number>()

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  const fail = (name: 'stat' | 'readdir' | 'readFile' | 'writeFile', target: string) => {
    if (target.includes('__plain__')) return new Error('plain failure')
    if (name === 'writeFile' && target.includes('__write-fail__')) return new Error('plain failure')
    return undefined
  }
  const wrap = (name: 'stat' | 'readdir' | 'readFile' | 'writeFile') => {
    const original = base[name] as (...args: unknown[]) => Promise<unknown>
    return async (...args: unknown[]) => {
      const target = String(args[0])
      const error = fail(name, target)
      if (error) throw error
      if (name === 'readFile' && target.includes('__second-read__')) {
        const count = (readCounts.get(target) ?? 0) + 1
        readCounts.set(target, count)
        if (count === 2) throw new Error('plain read failure')
      }
      return original(...args)
    }
  }
  return {
    ...actual,
    default: {
      ...base,
      stat: wrap('stat'),
      readdir: wrap('readdir'),
      readFile: wrap('readFile'),
      writeFile: wrap('writeFile'),
    },
  }
})

import { createSearchTool, createWriteFileTool, listDirTool, type WriteFileInput } from './index.js'
import { runTool, toolContext } from './testing/fixture.js'

let root: string
beforeEach(() => {
  readCounts = new Map()
  root = mkdtempSync(path.join(os.tmpdir(), 'cairn-tools-fs-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('list_dir：没有 errno 的文件系统错误', () => {
  it('目标无法 stat 时报告 unknown error', async () => {
    mkdirSync(path.join(root, '__plain__'))
    await expect(
      listDirTool.execute({ path: '__plain__' }, toolContext(root)),
    ).rejects.toMatchObject({
      code: 'tool.list_dir.unreadable',
      message: 'Cannot read __plain__ (unknown error).',
    })
  })

  it('子目录无法读取时在列表里标注 unreadable', async () => {
    mkdirSync(path.join(root, '__plain__'))
    writeFileSync(path.join(root, 'a.txt'), 'a')
    const result = await listDirTool.execute({}, toolContext(root))
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    expect(text).toContain('__plain__/ [unreadable: error]')
  })
})

describe('search：目标无法 stat 时报告 unknown error', () => {
  it('非 ENOENT 的失败按 failed 处理', async () => {
    mkdirSync(path.join(root, '__plain__'))
    const tool = createSearchTool({ ripgrepPath: 'rg' })
    await expect(
      tool.execute({ pattern: 'x', path: '__plain__' }, toolContext(root)),
    ).rejects.toMatchObject({
      code: 'tool.search.failed',
      message: 'Cannot read __plain__ (unknown error).',
    })
  })
})

describe('write_file：读写失败的兜底文案', () => {
  it('读取已有文件失败（非 ENOENT）时报错', async () => {
    writeFileSync(path.join(root, '__plain__.txt'), 'old')
    await expect(
      runTool(
        createWriteFileTool(),
        { path: '__plain__.txt', content: 'new' } satisfies WriteFileInput,
        toolContext(root),
      ),
    ).rejects.toMatchObject({
      code: 'tool.write_file.failed',
      message: 'Cannot read __plain__.txt (unknown error).',
    })
  })

  it('审批后重新校验读取失败时报 changed/failed', async () => {
    const file = path.join(root, '__second-read__.txt')
    writeFileSync(file, 'old\n')
    const tool = createWriteFileTool()
    const ctx = toolContext(root)
    await tool.describeForApproval!({ path: '__second-read__.txt', content: 'new\n' }, ctx)
    await expect(
      runTool(tool, { path: '__second-read__.txt', content: 'new\n' }, ctx),
    ).rejects.toMatchObject({
      code: 'tool.write_file.failed',
      message: 'Cannot read __second-read__.txt (unknown error).',
    })
  })

  it('写入失败时报错', async () => {
    const tool = createWriteFileTool()
    await expect(
      runTool(tool, { path: '__write-fail__.txt', content: 'x' }, toolContext(root)),
    ).rejects.toMatchObject({
      code: 'tool.write_file.failed',
      message: 'Cannot write __write-fail__.txt (unknown error).',
    })
  })
})
