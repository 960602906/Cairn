/**
 * ripgrep 流式输出的边界：用假的子进程精确控制 stdout/stderr、退出码与错误事件，
 * 覆盖真实 ripgrep 难以稳定制造的分支（无效 JSON、超时、部分错误、警告等）。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type * as NodeChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'
import { createSearchTool } from './index.js'
import { toolContext } from './testing/fixture.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn()
}

const spawnMock = vi.mocked(spawn)

let root: string
let child: FakeChild

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cairn-search-stream-'))
  child = new FakeChild()
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => child as never)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const start = async (options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
  const tool = createSearchTool({ ripgrepPath: 'rg', ...options })
  const text = tool
    .execute({ pattern: 'x' }, toolContext(root, options.signal))
    .then((output) =>
      output.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    )
  // 等 ripgrep 真正启动、事件监听器就位后再喂输出
  await vi.waitFor(
    () => {
      if (spawnMock.mock.calls.length === 0) throw new Error('ripgrep was not started')
    },
    { interval: 1 },
  )
  return { tool, text }
}

const emitLine = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const match = (overrides: Record<string, unknown> = {}) =>
  emitLine({
    type: 'match',
    data: { path: { text: 'a.txt' }, lines: { text: 'hi\n' }, line_number: 1, ...overrides },
  })

describe('search 输出解析', () => {
  it('忽略无效 JSON；支持 base64 行与缺失行号；长 stderr 只保留首行作为警告', async () => {
    const { text } = await start()
    child.stdout.write('not json\n\n')
    emitLine({
      type: 'match',
      data: {
        path: { bytes: Buffer.from('a.txt').toString('base64') },
        lines: { bytes: Buffer.from('hi\n').toString('base64') },
      },
    })
    emitLine({ type: 'context', data: {} })
    child.stderr.write('x'.repeat(5000))
    child.stderr.write('more')
    child.emit('close', 2)
    const output = await text
    expect(output).toContain('a.txt')
    expect(output).toContain('  0: hi')
    expect(output).toContain('[Some files could not be searched:')
  })

  it('退出码 2 且没有匹配时按错误处理', async () => {
    const { text } = await start()
    child.stderr.write('fatal: broken index\n')
    child.emit('close', 2)
    await expect(text).rejects.toMatchObject({
      code: 'tool.search.failed',
      message: 'Search failed: fatal: broken index',
    })
  })

  it('退出码 2 且没有输出时带上退出码', async () => {
    const { text } = await start()
    child.emit('close', 2)
    await expect(text).rejects.toMatchObject({
      code: 'tool.search.failed',
      message: 'Search failed: ripgrep exited with code 2',
    })
  })

  it('启动失败且错误没有 errno 时使用 message', async () => {
    const { text } = await start()
    child.emit('error', new Error('plain spawn failure'))
    await expect(text).rejects.toThrow('plain spawn failure')
  })
})

describe('search 超时与取消', () => {
  it('超时且没有结果时返回超时说明', async () => {
    const { text } = await start({ timeoutMs: 0 })
    await wait(20)
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', 1)
    expect(await text).toBe(
      'Search: "x" in . | no matches\n[The search timed out before it finished.]',
    )
  })

  it('超时时只有上下文行也能正常结束', async () => {
    const { text } = await start({ timeoutMs: 0 })
    emitLine({
      type: 'context',
      data: { path: { text: 'a.txt' }, lines: { text: 'ctx\n' }, line_number: 1 },
    })
    await wait(20)
    child.emit('close', 1)
    expect(await text).toContain('no matches')
  })

  it('超时且已有匹配时说明结果不完整', async () => {
    const { text } = await start({ timeoutMs: 500 })
    match()
    await wait(700)
    child.emit('close', 1)
    expect(await text).toContain('[The search timed out; results are incomplete.]')
  })

  it('超时后仍报告 stderr 警告', async () => {
    const { text } = await start({ timeoutMs: 0 })
    child.stderr.write('warning: cannot read a.txt\n')
    await wait(20)
    child.emit('close', 2)
    const output = await text
    expect(output).toContain('[The search timed out before it finished.]')
    expect(output).toContain('[Some files could not be searched: warning: cannot read a.txt]')
  })

  it('取消时结束子进程', async () => {
    const controller = new AbortController()
    const { text } = await start({ signal: controller.signal })
    controller.abort()
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', 1)
    expect(await text).toContain('no matches')
  })
})
