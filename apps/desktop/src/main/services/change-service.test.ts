import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChangeInput, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlobStore } from './blob-store.js'
import { createChangeService, type ChangeServiceOptions } from './change-service.js'

let dir: string
let workspace: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-changes-')))
  workspace = join(dir, 'work')
  mkdirSync(workspace)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const b64 = (text: string) => Buffer.from(text).toString('base64')
const read = (rel: string) => readFileSync(join(workspace, rel), 'utf8')
const put = (rel: string, text: string) => {
  mkdirSync(join(workspace, rel, '..'), { recursive: true })
  writeFileSync(join(workspace, rel), text)
}

function setup(over: Partial<ChangeServiceOptions> = {}) {
  const storage = createMemoryStorage({ now: () => 7 })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: workspace })
  storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: workspace, title: '' })
  const published: UnsequencedEvent[] = []
  let id = 0
  const busy = { value: false }
  const service = createChangeService({
    storage,
    blobs: createBlobStore(join(dir, 'blobs')),
    events: {
      publish: (events) => {
        published.push(...events)
        return []
      },
    },
    isBusy: () => busy.value,
    createId: () => `ch${++id}`,
    now: () => 9,
    ...over,
  })
  return { storage, service, published, busy }
}

/** 模拟写类工具：写入文件，再记录改动。 */
async function apply(
  service: ReturnType<typeof setup>['service'],
  rel: string,
  next: string | undefined,
  extra: Partial<FileChangeInput> = {},
) {
  const file = join(workspace, rel)
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (next === undefined) rmSync(file)
  else put(rel, next)
  const kind = before === undefined ? 'create' : next === undefined ? 'delete' : 'modify'
  return (
    await service.record('s1', 'run1', {
      path: rel,
      kind,
      ...(before === undefined ? {} : { before: b64(before) }),
      ...(next === undefined ? {} : { after: b64(next) }),
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
      added: 2,
      removed: 1,
      ...extra,
    } as FileChangeInput)
  ).changeId
}

describe('ChangeService：记录与列出', () => {
  it('写入 blob 与记录，按顺序列出（不含内容与哈希）', async () => {
    const { service, storage } = setup()
    put('a.txt', 'one\n')
    const id = await apply(service, 'a.txt', 'two\n', { turnId: 't1', toolCallId: 'call1' })
    expect(id).toBe('ch1')
    expect(storage.changes.get('ch1')).toMatchObject({
      sessionId: 's1',
      runId: 'run1',
      beforeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      afterHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    await apply(service, 'b/new.txt', 'x')
    expect(service.list({ sessionId: 's1' })).toEqual({
      changes: [
        {
          changeId: 'ch1',
          path: 'a.txt',
          kind: 'modify',
          status: 'pending',
          turnId: 't1',
          toolCallId: 'call1',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
          added: 2,
          removed: 1,
          createdAt: 7,
        },
        expect.objectContaining({ changeId: 'ch2', path: 'b/new.txt', kind: 'create' }),
      ],
    })
  })

  it('会话不存在时报 changes.not_found', async () => {
    const { service } = setup()
    expect(() => service.list({ sessionId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'changes.not_found' }),
    )
    await expect(
      service.record('nope', 'r', {
        path: 'a',
        kind: 'create',
        after: '',
        hunks: [],
        added: 0,
        removed: 0,
      }),
    ).rejects.toMatchObject({ code: 'changes.not_found' })
  })
})

describe('ChangeService：整文件撤销', () => {
  it('撤销后内容与改动前一致（字节一致，含 CRLF 与 BOM）；写反向记录并发出 file.changed', async () => {
    const { service, storage, published } = setup()
    const original = '﻿a\r\nb\r\n'
    put('a.txt', original)
    const id = await apply(service, 'a.txt', '﻿a\r\nc\r\n')
    const result = await service.revert({ sessionId: 's1', changeIds: [id] })
    expect(read('a.txt')).toBe(original)
    expect(result.changes).toEqual([
      {
        changeId: 'ch2',
        path: 'a.txt',
        kind: 'modify',
        status: 'pending',
        revertOf: 'ch1',
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1 }],
        added: 1,
        removed: 2,
        createdAt: 7,
      },
    ])
    expect(storage.changes.get('ch1')!.status).toBe('reverted')
    expect(storage.changes.get('ch2')).toMatchObject({
      beforeHash: storage.changes.get('ch1')!.afterHash,
      afterHash: storage.changes.get('ch1')!.beforeHash,
    })
    expect(published).toEqual([
      {
        v: 1,
        sessionId: 's1',
        runId: 's1',
        ts: 9,
        type: 'file.changed',
        payload: { changeId: 'ch2', path: 'a.txt', kind: 'modify', revertOf: 'ch1' },
      },
    ])
    await expect(service.revert({ sessionId: 's1', changeIds: [id] })).rejects.toMatchObject({
      code: 'changes.already_reverted',
      params: { changeId: 'ch1', path: 'a.txt' },
    })
    // 撤销的撤销（重做）
    await service.revert({ sessionId: 's1', changeIds: ['ch2'] })
    expect(read('a.txt')).toBe('﻿a\r\nc\r\n')
  })

  it('撤销新建删除文件，撤销删除恢复文件', async () => {
    const { service } = setup()
    const created = await apply(service, 'dir/new.txt', 'new')
    put('gone.txt', 'keep me')
    const deleted = await apply(service, 'gone.txt', undefined)
    const { changes } = await service.revert({ sessionId: 's1', changeIds: [created, deleted] })
    expect(existsSync(join(workspace, 'dir/new.txt'))).toBe(false)
    expect(read('gone.txt')).toBe('keep me')
    // 从最新的改动开始撤销
    expect(changes.map((c) => [c.revertOf, c.kind])).toEqual([
      [deleted, 'create'],
      [created, 'delete'],
    ])
  })

  it('同一文件的多次改动一起撤销时恢复到最早的内容；只撤销较早的改动时拒绝', async () => {
    const { service } = setup()
    put('a.txt', 'v1')
    const first = await apply(service, 'a.txt', 'v2')
    const second = await apply(service, 'a.txt', 'v3')
    await expect(service.revert({ sessionId: 's1', changeIds: [first] })).rejects.toMatchObject({
      code: 'changes.conflict',
      params: { path: 'a.txt' },
    })
    expect(read('a.txt')).toBe('v3')
    await service.revert({ sessionId: 's1', changeIds: [first, second, first] })
    expect(read('a.txt')).toBe('v1')
  })

  it('文件在改动之后被修改时整体拒绝，不写任何文件', async () => {
    const { service, storage, published } = setup()
    put('a.txt', 'a1')
    put('b.txt', 'b1')
    const a = await apply(service, 'a.txt', 'a2')
    const b = await apply(service, 'b.txt', 'b2')
    put('b.txt', 'edited by user')
    await expect(service.revert({ sessionId: 's1', changeIds: [a, b] })).rejects.toMatchObject({
      code: 'changes.conflict',
      params: { path: 'b.txt' },
    })
    expect(read('a.txt')).toBe('a2')
    expect(storage.changes.list('s1').every((c) => c.status === 'pending')).toBe(true)
    expect(published).toEqual([])
    // 新建的文件之后又被删除、路径变成目录
    const created = await apply(service, 'c.txt', 'c')
    rmSync(join(workspace, 'c.txt'))
    await expect(service.revert({ sessionId: 's1', changeIds: [created] })).rejects.toMatchObject({
      code: 'changes.conflict',
    })
    mkdirSync(join(workspace, 'c.txt'))
    await expect(service.revert({ sessionId: 's1', changeIds: [created] })).rejects.toMatchObject({
      code: 'changes.conflict',
    })
  })

  it('改动不存在、属于其他会话、路径越界、blob 缺失', async () => {
    const { service, storage } = setup()
    storage.sessions.create({
      sessionId: 's2',
      projectId: 'p1',
      workspacePath: workspace,
      title: '',
    })
    await expect(service.revert({ sessionId: 's1', changeIds: ['nope'] })).rejects.toMatchObject({
      code: 'changes.not_found',
      params: { changeId: 'nope' },
    })
    await expect(service.revert({ sessionId: 'nope', changeIds: ['x'] })).rejects.toMatchObject({
      code: 'changes.not_found',
    })
    const id = await apply(service, 'a.txt', 'x')
    await expect(service.revert({ sessionId: 's2', changeIds: [id] })).rejects.toMatchObject({
      code: 'changes.not_found',
    })
    storage.changes.create({
      changeId: 'outside',
      sessionId: 's1',
      path: '../escape.txt',
      kind: 'create',
      afterHash: 'f'.repeat(64),
      added: 0,
      removed: 0,
      hunks: [],
    })
    await expect(service.revert({ sessionId: 's1', changeIds: ['outside'] })).rejects.toMatchObject(
      { code: 'path.outside_workspace', params: { path: '../escape.txt' } },
    )
    put('m.txt', 'm1')
    const modified = await apply(service, 'm.txt', 'm2')
    rmSync(join(dir, 'blobs'), { recursive: true })
    await expect(service.revert({ sessionId: 's1', changeIds: [modified] })).rejects.toMatchObject({
      code: 'changes.blob_missing',
      params: { path: 'm.txt' },
    })
    expect(read('m.txt')).toBe('m2')
  })

  it('会话正在运行或正在撤销时拒绝', async () => {
    const { service, busy } = setup()
    put('a.txt', 'a1')
    const id = await apply(service, 'a.txt', 'a2')
    busy.value = true
    await expect(service.revert({ sessionId: 's1', changeIds: [id] })).rejects.toMatchObject({
      code: 'run.busy',
    })
    busy.value = false
    const pending = service.revert({ sessionId: 's1', changeIds: [id] })
    expect(service.isReverting('s1')).toBe(true)
    await expect(service.revert({ sessionId: 's1', changeIds: [id] })).rejects.toMatchObject({
      code: 'run.busy',
    })
    await pending
    expect(service.isReverting('s1')).toBe(false)
  })

  it('读写文件失败时报 changes.failed', async () => {
    const { service } = setup()
    put('a.txt', 'a1')
    const id = await apply(service, 'a.txt', 'a2')
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(eacces)
    await expect(service.revert({ sessionId: 's1', changeIds: [id] })).rejects.toMatchObject({
      code: 'changes.failed',
      params: { path: 'a.txt', cause: 'EACCES' },
    })
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(eacces)
    await expect(service.revert({ sessionId: 's1', changeIds: [id] })).rejects.toMatchObject({
      code: 'changes.failed',
    })
    await service.revert({ sessionId: 's1', changeIds: [id] })
    expect(read('a.txt')).toBe('a1')
  })
})
