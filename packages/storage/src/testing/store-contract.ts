/**
 * 存储契约测试。每个实现（内存、SQLite）都用自己的工厂调用一次，保证行为一致：
 *
 * ```ts
 * describeStorageContract('memory', (now) => createMemoryStorage({ now }))
 * ```
 *
 * 工厂每个用例调用一次，必须返回空的存储，并使用传入的时间来源。
 */
import type { PersistedEvent } from '@nexus/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StorageError, StorageErrorCode, type Storage } from '../types.js'

export type StorageFactory = (now: () => number) => Storage

/** 构造一条可落库的 `message.user` 事件。 */
export function userEvent(sessionId: string, seq: number, text = `m${seq}`): PersistedEvent {
  return {
    v: 1,
    sessionId,
    runId: 'run-1',
    ts: 1_000 + seq,
    seq,
    type: 'message.user',
    payload: { messageId: `msg-${seq}`, content: [{ type: 'text', text }] },
  }
}

function expectStorageError(fn: () => unknown, code: StorageErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(StorageError)
  expect((caught as StorageError).code).toBe(code)
}

export function describeStorageContract(name: string, factory: StorageFactory): void {
  describe(`storage contract: ${name}`, () => {
    let clock = 0
    let storage: Storage

    beforeEach(() => {
      clock = 100
      storage = factory(() => clock)
    })

    afterEach(() => {
      storage.close()
    })

    const seed = (): void => {
      storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
      storage.sessions.create({
        sessionId: 's1',
        projectId: 'p1',
        workspacePath: '/work/demo',
        title: '第一个会话',
      })
    }

    describe('projects', () => {
      it('creates and reads projects', () => {
        const created = storage.projects.create({
          projectId: 'p1',
          name: 'Demo',
          path: '/work/demo',
        })
        expect(created).toEqual({
          projectId: 'p1',
          name: 'Demo',
          path: '/work/demo',
          createdAt: 100,
        })
        expect(storage.projects.get('p1')).toEqual(created)
        expect(storage.projects.getByPath('/work/demo')).toEqual(created)
        expect(storage.projects.get('missing')).toBeUndefined()
        expect(storage.projects.getByPath('/missing')).toBeUndefined()
      })

      it('lists projects newest first', () => {
        storage.projects.create({ projectId: 'a', name: 'A', path: '/a' })
        clock = 200
        storage.projects.create({ projectId: 'b', name: 'B', path: '/b' })
        expect(storage.projects.list().map((p) => p.projectId)).toEqual(['b', 'a'])
      })

      it('rejects duplicate ids and paths', () => {
        storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
        expectStorageError(
          () => storage.projects.create({ projectId: 'p1', name: 'X', path: '/other' }),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.projects.create({ projectId: 'p2', name: 'X', path: '/work/demo' }),
          StorageErrorCode.Conflict,
        )
        expect(storage.projects.list()).toHaveLength(1)
      })
    })

    describe('sessions', () => {
      it('creates a session with the project path', () => {
        seed()
        expect(storage.sessions.get('s1')).toEqual({
          sessionId: 's1',
          projectId: 'p1',
          projectPath: '/work/demo',
          workspacePath: '/work/demo',
          title: '第一个会话',
          archived: false,
          createdAt: 100,
          updatedAt: 100,
        })
        expect(storage.sessions.get('missing')).toBeUndefined()
      })

      it('rejects unknown projects and duplicate ids', () => {
        seed()
        expectStorageError(
          () =>
            storage.sessions.create({
              sessionId: 's2',
              projectId: 'nope',
              workspacePath: '/x',
              title: '',
            }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () =>
            storage.sessions.create({
              sessionId: 's1',
              projectId: 'p1',
              workspacePath: '/x',
              title: '',
            }),
          StorageErrorCode.Conflict,
        )
      })

      it('renames, archives and touches, updating updatedAt', () => {
        seed()
        clock = 200
        expect(storage.sessions.rename('s1', '新标题')).toMatchObject({
          title: '新标题',
          updatedAt: 200,
        })
        clock = 300
        expect(storage.sessions.touch('s1')).toMatchObject({ title: '新标题', updatedAt: 300 })
        clock = 400
        expect(storage.sessions.archive('s1')).toMatchObject({ archived: true, updatedAt: 400 })
        expect(storage.sessions.get('s1')).toMatchObject({
          title: '新标题',
          archived: true,
          createdAt: 100,
        })
      })

      it('reports missing sessions on update', () => {
        expectStorageError(() => storage.sessions.rename('nope', 't'), StorageErrorCode.NotFound)
        expectStorageError(() => storage.sessions.archive('nope'), StorageErrorCode.NotFound)
        expectStorageError(() => storage.sessions.touch('nope'), StorageErrorCode.NotFound)
      })

      it('lists by updatedAt, filtering archived sessions and by project', () => {
        seed()
        storage.projects.create({ projectId: 'p2', name: 'Other', path: '/work/other' })
        clock = 200
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '',
        })
        clock = 300
        storage.sessions.create({
          sessionId: 's3',
          projectId: 'p2',
          workspacePath: '/work/other',
          title: '',
        })
        clock = 400
        storage.sessions.touch('s1')
        storage.sessions.archive('s2')

        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s1', 's3'])
        expect(storage.sessions.list({ includeArchived: true }).map((s) => s.sessionId)).toEqual([
          's1',
          's2',
          's3',
        ])
        expect(
          storage.sessions.list({ projectId: 'p1', includeArchived: true }).map((s) => s.sessionId),
        ).toEqual(['s1', 's2'])
      })
    })

    describe('events', () => {
      it('appends and reads events in seq order', () => {
        seed()
        expect(storage.events.maxSeq('s1')).toBe(0)
        storage.events.append([userEvent('s1', 1), userEvent('s1', 2)])
        storage.events.append([userEvent('s1', 3, '你好')])
        expect(storage.events.maxSeq('s1')).toBe(3)
        expect(storage.events.readAfter('s1', 0)).toEqual([
          userEvent('s1', 1),
          userEvent('s1', 2),
          userEvent('s1', 3, '你好'),
        ])
        expect(storage.events.readAfter('s1', 1).map((e) => e.seq)).toEqual([2, 3])
        expect(storage.events.readAfter('s1', 3)).toEqual([])
        expect(storage.events.readAfter('s1', 0, 2).map((e) => e.seq)).toEqual([1, 2])
        expect(storage.events.readAfter('s1', 1, 0)).toEqual([])
      })

      it('keeps sessions independent', () => {
        seed()
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '',
        })
        storage.events.append([userEvent('s1', 1), userEvent('s2', 1), userEvent('s1', 2)])
        expect(storage.events.maxSeq('s1')).toBe(2)
        expect(storage.events.maxSeq('s2')).toBe(1)
        expect(storage.events.readAfter('s2', 0).map((e) => e.sessionId)).toEqual(['s2'])
        expect(storage.events.maxSeq('unknown')).toBe(0)
        expect(storage.events.readAfter('unknown', 0)).toEqual([])
      })

      it('accepts an empty batch', () => {
        seed()
        storage.events.append([])
        expect(storage.events.maxSeq('s1')).toBe(0)
      })

      it('rejects gaps and duplicates without writing any of the batch', () => {
        seed()
        storage.events.append([userEvent('s1', 1)])
        expectStorageError(
          () => storage.events.append([userEvent('s1', 2), userEvent('s1', 4)]),
          StorageErrorCode.SeqConflict,
        )
        expectStorageError(
          () => storage.events.append([userEvent('s1', 1)]),
          StorageErrorCode.SeqConflict,
        )
        expect(storage.events.maxSeq('s1')).toBe(1)
      })

      it('rejects live events and unknown sessions', () => {
        seed()
        const delta = {
          ...userEvent('s1', 1),
          type: 'message.assistant.delta',
          payload: { messageId: 'a', text: 'x' },
        } as unknown as PersistedEvent
        expectStorageError(() => storage.events.append([delta]), StorageErrorCode.InvalidEvent)
        expectStorageError(
          () => storage.events.append([userEvent('nope', 1)]),
          StorageErrorCode.InvalidEvent,
        )
        expect(storage.events.maxSeq('s1')).toBe(0)
      })

      it('returns copies that callers cannot mutate', () => {
        seed()
        const event = userEvent('s1', 1)
        storage.events.append([event])
        ;(event.payload as { messageId: string }).messageId = 'changed'
        const [read] = storage.events.readAfter('s1', 0)
        expect(read?.payload).toMatchObject({ messageId: 'msg-1' })
        ;(read?.payload as { messageId: string }).messageId = 'changed'
        expect(storage.events.readAfter('s1', 0)[0]?.payload).toMatchObject({ messageId: 'msg-1' })
      })
    })

    describe('transaction', () => {
      it('commits all writes and returns the result', () => {
        const result = storage.transaction(() => {
          seed()
          storage.events.append([userEvent('s1', 1)])
          return 'done'
        })
        expect(result).toBe('done')
        expect(storage.events.maxSeq('s1')).toBe(1)
      })

      it('rolls back every store when fn throws', () => {
        storage.projects.create({ projectId: 'p0', name: 'Kept', path: '/kept' })
        const failure = new Error('boom')
        expect(() =>
          storage.transaction(() => {
            seed()
            storage.events.append([userEvent('s1', 1)])
            throw failure
          }),
        ).toThrow(failure)
        expect(storage.projects.list().map((p) => p.projectId)).toEqual(['p0'])
        expect(storage.sessions.get('s1')).toBeUndefined()
        expect(storage.events.maxSeq('s1')).toBe(0)
      })

      it('rolls back only the inner part of a nested transaction', () => {
        seed()
        storage.transaction(() => {
          storage.events.append([userEvent('s1', 1)])
          expect(() =>
            storage.transaction(() => {
              storage.events.append([userEvent('s1', 2)])
              throw new Error('inner')
            }),
          ).toThrow('inner')
          storage.sessions.rename('s1', 'after')
        })
        expect(storage.events.maxSeq('s1')).toBe(1)
        expect(storage.sessions.get('s1')?.title).toBe('after')
      })
    })
  })
}
