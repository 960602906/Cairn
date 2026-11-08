import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointError, openShadowRepo, type ShadowRepo } from '@cairn/checkpoint'
import { createMemoryStorage } from '@cairn/storage'
import { diffHunks, unifiedDiff } from '@cairn/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlobStore } from './blob-store.js'
import { createChangeService } from './change-service.js'
import { checkpointLocation } from './checkpoint-location.js'
import {
  createCheckpointService,
  type CheckpointServiceOptions,
  type OpenCheckpointRepo,
} from './checkpoint-service.js'
import { createSessionEventService } from './event-service.js'

let dir: string
let workspace: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-checkpoints-')))
  workspace = join(dir, 'work')
  mkdirSync(workspace)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const read = (rel: string) => readFileSync(join(workspace, rel), 'utf8')
const put = (rel: string, text: string) => writeFileSync(join(workspace, rel), text)

function setup(over: Partial<CheckpointServiceOptions> = {}) {
  const storage = createMemoryStorage({ now: () => 7 })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: workspace })
  storage.projects.create({ projectId: 'p2', name: 'other', path: join(dir, 'other') })
  for (const [sessionId, projectId] of [
    ['s1', 'p1'],
    ['s2', 'p1'],
    ['s3', 'p2'],
  ] as const) {
    storage.sessions.create({ sessionId, projectId, workspacePath: workspace, title: '' })
  }
  const events = createSessionEventService({ storage })
  const busy = new Set<string>()
  const root = join(dir, 'checkpoints')
  const service = createCheckpointService({
    storage,
    events,
    location: (sessionId) => checkpointLocation(root, storage, sessionId),
    open: openShadowRepo,
    isBusy: (sessionId) => busy.has(sessionId),
    now: () => 9,
    ...over,
  })
  /** 模拟宿主：在会话的引用上创建检查点并发出 `checkpoint.created`。 */
  const hostCheckpoint = async (sessionId: string, turnId?: string) => {
    const location = checkpointLocation(root, storage, sessionId)!
    const repo = await openShadowRepo({
      gitDir: location.gitDir,
      workTree: workspace,
      ref: location.ref,
    })
    const { commit } = await repo.checkpoint('turn start')
    events.publish([
      {
        v: 1,
        sessionId,
        runId: 'r1',
        ...(turnId ? { turnId } : {}),
        ts: 5,
        type: 'checkpoint.created',
        payload: { checkpointId: commit, reason: 'turn_start' },
      },
    ])
    return commit
  }
  return { storage, events, service, busy, hostCheckpoint }
}

describe('checkpoint service', () => {
  it('creates a before-merge checkpoint that restores the previous workspace', async () => {
    const { service, events } = setup()
    put('a.txt', 'before merge')

    const created = await service.create({ sessionId: 's1' })
    expect(created.checkpointId).toMatch(/^[0-9a-f]{40}$/)
    expect(service.list({ sessionId: 's1' }).checkpoints).toMatchObject([
      {
        checkpointId: created.checkpointId,
        reason: 'before_merge',
        runId: 's1',
        createdAt: 9,
      },
    ])
    expect(events.readAfter('s1', 0).at(-1)).toMatchObject({
      type: 'checkpoint.created',
      payload: { checkpointId: created.checkpointId, reason: 'before_merge' },
    })

    put('a.txt', 'after merge')
    await service.restore({ sessionId: 's1', checkpointId: created.checkpointId })
    expect(read('a.txt')).toBe('before merge')
  })

  it('refuses to create a merge checkpoint when a sibling session is busy', async () => {
    const { service, busy, events } = setup()
    busy.add('s2')
    await expect(service.create({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'run.busy',
    })
    expect(events.readAfter('s1', 0)).toEqual([])
  })

  it('refuses to create a merge checkpoint without a session or location', async () => {
    const { service } = setup({ location: () => undefined })
    await expect(service.create({ sessionId: 'missing' })).rejects.toMatchObject({
      code: 'checkpoint.not_found',
    })
    await expect(service.create({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'checkpoint.not_found',
    })
  })

  it('releases the project lock after a failed merge checkpoint', async () => {
    const checkpoint = vi
      .fn()
      .mockRejectedValueOnce(new CheckpointError('checkpoint.failed', 'git failed'))
      .mockResolvedValue({
        commit: 'c'.repeat(40),
        created: true,
        skippedLarge: [],
        nestedRepos: [],
        warnings: '',
      })
    const open: OpenCheckpointRepo = async () => ({
      preview: vi.fn(),
      restore: vi.fn(),
      checkpoint,
    })
    const { service, events } = setup({ open })

    await expect(service.create({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'checkpoint.failed',
    })
    expect(events.readAfter('s1', 0)).toEqual([])
    const created = await service.create({ sessionId: 's1' })
    expect(created.checkpointId).toBe('c'.repeat(40))
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it('lists the checkpoints of a session from its events', async () => {
    const { service, hostCheckpoint } = setup()
    expect(service.list({ sessionId: 's1' })).toEqual({ checkpoints: [] })
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1', 't1')
    await hostCheckpoint('s2')
    expect(service.list({ sessionId: 's1' }).checkpoints).toEqual([
      {
        checkpointId: first,
        reason: 'turn_start',
        seq: 1,
        runId: 'r1',
        turnId: 't1',
        createdAt: 5,
      },
    ])
    expect(() => service.list({ sessionId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'checkpoint.not_found' }),
    )
  })

  it('has no checkpoints when the session has no checkpoint location', () => {
    const { service, events } = setup({ location: () => undefined })
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 5,
        type: 'checkpoint.created',
        payload: { checkpointId: 'a'.repeat(40), reason: 'turn_start' },
      },
    ])
    expect(service.list({ sessionId: 's1' })).toEqual({ checkpoints: [] })
  })

  it('previews without changing the workspace, then restores and can undo', async () => {
    const { service, events, hostCheckpoint } = setup()
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1', 't1')
    put('a.txt', 'two')
    put('b.txt', 'new')

    const preview = await service.preview({ sessionId: 's1', checkpointId: first })
    expect(preview.files).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'deleted' },
    ])
    expect(read('a.txt')).toBe('two')
    expect(service.list({ sessionId: 's1' }).checkpoints).toHaveLength(1)

    const restored = await service.restore({ sessionId: 's1', checkpointId: first })
    expect(restored.files).toEqual(preview.files)
    expect(read('a.txt')).toBe('one')
    const tail = events.readAfter('s1', 1)
    expect(tail.map((e) => [e.type, e.payload])).toEqual([
      ['checkpoint.created', { checkpointId: restored.before, reason: 'before_restore' }],
      ['checkpoint.restored', { checkpointId: first, truncateConversation: false }],
    ])
    expect(tail[0]).toMatchObject({ runId: 's1', ts: 9 })
    expect(tail[0]!.turnId).toBeUndefined()

    // 恢复到恢复前的检查点即撤销这次恢复
    await service.restore({ sessionId: 's1', checkpointId: restored.before })
    expect(read('a.txt')).toBe('two')
    expect(read('b.txt')).toBe('new')

    // 宿主之后在同一个引用上继续创建检查点
    put('a.txt', 'three')
    await expect(hostCheckpoint('s1')).resolves.toMatch(/^[0-9a-f]{40}$/)
  })

  it('syncs change statuses with the restored checkpoint, also when undoing a restore', async () => {
    const { service, storage, events, hostCheckpoint } = setup()
    const change = (changeId: string, extra: { revertOf?: string } = {}) => {
      storage.changes.create({
        changeId,
        sessionId: 's1',
        path: 'a.txt',
        kind: 'modify',
        added: 1,
        removed: 1,
        hunks: [],
        ...extra,
      })
      events.publish([
        {
          v: 1,
          sessionId: 's1',
          runId: 'r1',
          ts: 6,
          type: 'file.changed',
          payload: { changeId, path: 'a.txt', kind: 'modify' },
        },
      ])
    }
    put('a.txt', 'one')
    change('before')
    const first = await hostCheckpoint('s1', 't1')
    put('a.txt', 'two')
    change('after')
    change('undone')
    storage.changes.setStatus('undone', 'reverted')
    change('inverse', { revertOf: 'undone' })
    const { before } = await service.restore({ sessionId: 's1', checkpointId: first })
    const status = () =>
      Object.fromEntries(storage.changes.list('s1').map((c) => [c.changeId, c.status]))
    expect(status()).toEqual({
      before: 'pending',
      after: 'reverted',
      undone: 'reverted',
      inverse: 'pending',
    })

    // 撤销这次恢复：恢复前有效的改动重新有效，恢复前已经撤销的仍是撤销
    await service.restore({ sessionId: 's1', checkpointId: before })
    expect(read('a.txt')).toBe('two')
    expect(status()).toEqual({
      before: 'pending',
      after: 'pending',
      undone: 'reverted',
      inverse: 'pending',
    })

    // 再恢复到第一个检查点
    await service.restore({ sessionId: 's1', checkpointId: first })
    expect(status()).toMatchObject({ before: 'pending', after: 'reverted' })
  })

  it('keeps a hunk revert across checkpoint restore and puts it back when that restore is undone', async () => {
    const { service, storage, events, hostCheckpoint } = setup()
    let n = 0
    const changes = createChangeService({
      storage,
      blobs: createBlobStore(join(dir, 'blobs')),
      events,
      isBusy: () => false,
      createId: () => `ch${++n}`,
      now: () => 9,
    })
    const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n') + '\n'
    const modified = original.replace('\nc\n', '\nC\n').replace('\nk\n', '\nK\n')
    const hunks = diffHunks(unifiedDiff('a/a.txt', 'b/a.txt', original, modified))
    put('a.txt', original)
    const first = await hostCheckpoint('s1')
    put('a.txt', modified)
    const { changeId } = await changes.record('s1', 'r1', {
      path: 'a.txt',
      kind: 'modify',
      before: Buffer.from(original).toString('base64'),
      after: Buffer.from(modified).toString('base64'),
      hunks,
      added: 2,
      removed: 2,
    })
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 6,
        type: 'file.changed',
        payload: { changeId, path: 'a.txt', kind: 'modify' },
      },
    ])
    await changes.revertHunk({ sessionId: 's1', changeId, hunkIndex: 0 })
    const partial = read('a.txt')
    expect(partial).toBe(original.replace('\nk\n', '\nK\n'))
    const later = await hostCheckpoint('s1')
    put('a.txt', 'tampered\n')

    const hunksOf = () => storage.changes.get(changeId)!.hunks.map((h) => h.status)
    await service.restore({ sessionId: 's1', checkpointId: later })
    expect(read('a.txt')).toBe(partial)
    expect(storage.changes.get(changeId)!.status).toBe('pending')
    expect(hunksOf()).toEqual(['reverted', 'pending'])

    await service.restore({ sessionId: 's1', checkpointId: first })
    expect(read('a.txt')).toBe(original)
    expect(storage.changes.get(changeId)!.status).toBe('reverted')

    await service.restore({ sessionId: 's1', checkpointId: later })
    expect(read('a.txt')).toBe(partial)
    expect(storage.changes.get(changeId)!.status).toBe('pending')
    expect(hunksOf()).toEqual(['reverted', 'pending'])
  })

  it('only restores checkpoints of the same session', async () => {
    const { service, hostCheckpoint } = setup()
    put('a.txt', 'one')
    const other = await hostCheckpoint('s2')
    await expect(service.restore({ sessionId: 's1', checkpointId: other })).rejects.toMatchObject({
      code: 'checkpoint.not_found',
      params: { sessionId: 's1', checkpointId: other },
    })
    await expect(
      service.preview({ sessionId: 'missing', checkpointId: other }),
    ).rejects.toMatchObject({ code: 'checkpoint.not_found' })
  })

  it('refuses while a session of the same project is running', async () => {
    const { service, busy, hostCheckpoint } = setup()
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1')
    busy.add('s2')
    await expect(service.restore({ sessionId: 's1', checkpointId: first })).rejects.toMatchObject({
      code: 'run.busy',
    })
    busy.clear()
    busy.add('s3')
    await expect(service.preview({ sessionId: 's1', checkpointId: first })).resolves.toBeDefined()
  })

  it('locks the project while restoring', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const plan = { before: 'b'.repeat(40), changes: [] }
    const open: OpenCheckpointRepo = async () => ({
      preview: async () => plan,
      restore: async () => {
        await gate
        return plan
      },
      checkpoint: async () => ({
        commit: 'c'.repeat(40),
        created: true,
        skippedLarge: [],
        nestedRepos: [],
        warnings: '',
      }),
    })
    const { service, hostCheckpoint } = setup({ open })
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1')
    const restoring = service.restore({ sessionId: 's1', checkpointId: first })
    await vi.waitFor(() => expect(service.isRestoring('s2')).toBe(true))
    expect(service.isRestoring('s3')).toBe(false)
    expect(service.isRestoring('missing')).toBe(false)
    await expect(service.preview({ sessionId: 's1', checkpointId: first })).rejects.toMatchObject({
      code: 'run.busy',
    })
    release()
    await expect(restoring).resolves.toEqual({ before: plan.before, files: [] })
    expect(service.isRestoring('s1')).toBe(false)
  })

  it('passes checkpoint errors on with their code', async () => {
    const failing =
      (error: unknown): OpenCheckpointRepo =>
      async () => {
        throw error
      }
    const { service, hostCheckpoint } = setup({
      open: failing(
        new CheckpointError('checkpoint.git_unavailable', 'no git', { reason: 'not_found' }),
      ),
    })
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1')
    await expect(service.restore({ sessionId: 's1', checkpointId: first })).rejects.toMatchObject({
      code: 'checkpoint.git_unavailable',
      params: { reason: 'not_found' },
    })
    expect(service.isRestoring('s1')).toBe(false)

    const plain = new Error('disk')
    const other = setup({ open: failing(plain) })
    const second = await other.hostCheckpoint('s1')
    await expect(other.service.preview({ sessionId: 's1', checkpointId: second })).rejects.toBe(
      plain,
    )
  })

  it('does not publish events when the restore fails', async () => {
    const repo: Pick<ShadowRepo, 'preview' | 'restore' | 'checkpoint'> = {
      preview: vi.fn(),
      restore: vi.fn(async () => {
        throw new CheckpointError('checkpoint.failed', 'git failed', { exitCode: '128' })
      }),
      checkpoint: vi.fn(),
    }
    const { service, events, hostCheckpoint } = setup({ open: async () => repo })
    put('a.txt', 'one')
    const first = await hostCheckpoint('s1')
    await expect(service.restore({ sessionId: 's1', checkpointId: first })).rejects.toMatchObject({
      code: 'checkpoint.failed',
    })
    expect(events.readAfter('s1', 1)).toEqual([])
  })

  it('ignores unknown change and restore references while syncing', async () => {
    const { service, storage, events, hostCheckpoint } = setup()
    storage.changes.create({
      changeId: 'tracked',
      sessionId: 's1',
      path: 'a.txt',
      kind: 'modify',
      added: 1,
      removed: 1,
      hunks: [],
    })
    const older = 'a'.repeat(40)
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 1,
        type: 'checkpoint.created',
        payload: { checkpointId: older, reason: 'turn_start' },
      },
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 2,
        type: 'file.changed',
        payload: { changeId: 'tracked', path: 'a.txt', kind: 'modify' },
      },
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 3,
        type: 'checkpoint.restored',
        payload: { checkpointId: older, truncateConversation: false },
      },
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 4,
        type: 'file.changed',
        payload: { changeId: 'unknown', path: 'ghost.txt', kind: 'modify' },
      },
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 5,
        type: 'checkpoint.restored',
        payload: { checkpointId: 'b'.repeat(40), truncateConversation: false },
      },
    ])
    put('a.txt', 'one')
    const current = await hostCheckpoint('s1')
    await service.restore({ sessionId: 's1', checkpointId: current })
    expect(storage.changes.get('tracked')?.status).toBe('reverted')
  })
})
