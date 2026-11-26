/**
 * 存储契约测试。每个实现（内存、SQLite）都用自己的工厂调用一次，保证行为一致：
 *
 * ```ts
 * describeStorageContract('memory', (now) => createMemoryStorage({ now }))
 * ```
 *
 * 工厂每个用例调用一次，必须返回空的存储，并使用传入的时间来源。
 */
import type {
  AutoFixJobStatus,
  AutoFixTrigger,
  PermissionRule,
  PersistedEvent,
} from '@cairn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StorageError, StorageErrorCode, type ProposeMemoryInput, type Storage } from '../types.js'

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

    describe('background commands', () => {
      it('persists lifecycle and bounded output without exposing mutable records', () => {
        seed()
        const record = {
          commandId: 'cmd1',
          sessionId: 's1',
          runId: 'r1',
          command: 'echo ok',
          cwd: '/work/demo',
          startedAt: 100,
          status: 'running' as const,
        }
        expect(storage.commands.create(record)).toEqual(record)
        expect(storage.commands.get('cmd1')).toEqual(record)
        expect(storage.commands.get('missing')).toBeUndefined()
        expectStorageError(() => storage.commands.create(record), StorageErrorCode.Conflict)
        expect(storage.commands.list()).toEqual([record])
        storage.commands.create({ ...record, commandId: 'cmd0', startedAt: 50 })
        expect(storage.commands.list().map((c) => c.commandId)).toEqual(['cmd1', 'cmd0'])
        const stopped = storage.commands.finish('cmd1', 'stopped', null, 120)
        expect(stopped).toEqual({ ...record, status: 'stopped', exitCode: null, endedAt: 120 })
        const output = {
          command: stopped,
          chunks: [{ stream: 'stdout' as const, text: 'ok' }],
          omittedChars: 0,
        }
        storage.commands.saveOutput('cmd1', output)
        output.chunks[0]!.text = 'changed'
        expect(storage.commands.output('cmd1')?.chunks[0]?.text).toBe('ok')
        expect(storage.commands.output('missing')).toBeUndefined()
        expectStorageError(
          () => storage.commands.finish('missing', 'failed', null, 120),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.commands.saveOutput('missing', output),
          StorageErrorCode.NotFound,
        )
      })

      it('rolls back creation in a failed transaction', () => {
        seed()
        expect(() =>
          storage.transaction(() => {
            storage.commands.create({
              commandId: 'cmd1',
              sessionId: 's1',
              runId: 'r1',
              command: 'echo',
              cwd: '/work/demo',
              startedAt: 100,
              status: 'running',
            })
            throw new Error('rollback')
          }),
        ).toThrow('rollback')
        expect(storage.commands.list()).toEqual([])
        expectStorageError(
          () =>
            storage.commands.create({
              commandId: 'cmd2',
              sessionId: 'missing',
              runId: 'r1',
              command: 'echo',
              cwd: '/work/demo',
              startedAt: 100,
              status: 'running',
            }),
          StorageErrorCode.NotFound,
        )
      })
    })

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
          readAgentsMd: true,
          enableProjectSkills: true,
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

      it('breaks ties on creation time by project id', () => {
        storage.projects.create({ projectId: 'b', name: 'B', path: '/b' })
        storage.projects.create({ projectId: 'a', name: 'A', path: '/a' })
        expect(storage.projects.list().map((p) => p.projectId)).toEqual(['a', 'b'])
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

      it('updates settings and hides a removed project until it is restored', () => {
        storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
        expect(
          storage.projects.update('p1', { name: 'Renamed', readAgentsMd: false }),
        ).toMatchObject({
          name: 'Renamed',
          readAgentsMd: false,
          enableProjectSkills: true,
        })
        expect(
          storage.projects.update('p1', { enableProjectSkills: false }).enableProjectSkills,
        ).toBe(false)
        clock = 300
        const removed = storage.projects.remove('p1')
        expect(removed.removedAt).toBe(300)
        expect(storage.projects.list()).toEqual([])
        expect(storage.projects.get('p1')?.removedAt).toBe(300)
        expect(storage.projects.getByPath('/work/demo')?.name).toBe('Renamed')
        expectStorageError(
          () => storage.projects.update('p1', { name: 'X' }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(() => storage.projects.remove('p1'), StorageErrorCode.NotFound)
        expectStorageError(() => storage.projects.remove('missing'), StorageErrorCode.NotFound)
        const restored = storage.projects.restore('p1')
        expect(restored.removedAt).toBeUndefined()
        expect(restored).toMatchObject({
          name: 'Renamed',
          readAgentsMd: false,
          enableProjectSkills: false,
        })
        expect(storage.projects.list().map((p) => p.projectId)).toEqual(['p1'])
        expect(
          storage.projects.update('p1', { readAgentsMd: true, enableProjectSkills: true }),
        ).toMatchObject({ readAgentsMd: true, enableProjectSkills: true })
        expectStorageError(() => storage.projects.restore('missing'), StorageErrorCode.NotFound)
      })

      it('pins and archives a project, then clears both timestamps', () => {
        storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
        clock = 400
        expect(storage.projects.update('p1', { pinned: true })).toMatchObject({
          pinnedAt: 400,
        })
        clock = 500
        const archived = storage.projects.update('p1', { archived: true })
        expect(archived).toMatchObject({ pinnedAt: 400, archivedAt: 500 })
        const cleared = storage.projects.update('p1', { pinned: false, archived: false })
        expect(cleared.pinnedAt).toBeUndefined()
        expect(cleared.archivedAt).toBeUndefined()
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
          pinned: false,
          kind: 'normal',
          createdAt: 100,
          updatedAt: 100,
        })
        expect(storage.sessions.get('missing')).toBeUndefined()
      })

      it('records the session model', () => {
        seed()
        const model = { providerId: 'deepseek', modelId: 'deepseek-chat' }
        const created = storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '',
          model,
        })
        expect(created.model).toEqual(model)
        expect(storage.sessions.get('s2')?.model).toEqual(model)
        expect(storage.sessions.rename('s2', 'x').model).toEqual(model)
        expect(storage.sessions.list().find((s) => s.sessionId === 's2')?.model).toEqual(model)
        expect(storage.sessions.get('s1')).not.toHaveProperty('model')
      })

      it('changes the session model (M2-04)', () => {
        seed()
        clock = 500
        const next = { providerId: 'p2', modelId: 'm2' }
        expect(storage.sessions.setModel('s1', next)).toMatchObject({ model: next, updatedAt: 500 })
        expect(storage.sessions.get('s1')?.model).toEqual(next)
      })

      it('stores the thinking level of a session on its own', () => {
        seed()
        expect(storage.sessions.get('s1')).not.toHaveProperty('thinkingLevel')
        clock = 500
        expect(storage.sessions.setThinkingLevel('s1', 'low')).toMatchObject({
          thinkingLevel: 'low',
          updatedAt: 500,
        })
        expect(storage.sessions.get('s1')?.thinkingLevel).toBe('low')
        expect(storage.sessions.setThinkingLevel('s1', 'high').thinkingLevel).toBe('high')
        expectStorageError(
          () => storage.sessions.setThinkingLevel('nope', 'low'),
          StorageErrorCode.NotFound,
        )
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

      it('pins sessions without touching updatedAt and lists pinned first', () => {
        seed()
        clock = 200
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '第二个会话',
        })
        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s2', 's1'])

        clock = 300
        const pinned = storage.sessions.setPinned('s1', true)
        expect(pinned).toMatchObject({ sessionId: 's1', pinned: true, updatedAt: 100 })
        expect(storage.sessions.get('s1')?.pinned).toBe(true)
        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s1', 's2'])

        expect(storage.sessions.setPinned('s1', false).pinned).toBe(false)
        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s2', 's1'])
      })

      it('searches message text across sessions, with snippets and case-insensitive terms', () => {
        seed()
        storage.events.append([
          userEvent('s1', 1, '请帮我修复登录问题'),
          {
            v: 1,
            sessionId: 's1',
            runId: 'run-1',
            ts: 1_001,
            seq: 2,
            type: 'message.assistant.completed',
            payload: {
              messageId: 'msg-2',
              content: [{ type: 'text', text: '已经修好登录问题了' }],
              model: { providerId: 'p', modelId: 'm' },
            },
          },
        ])
        clock = 200
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '另一个会话',
        })
        storage.events.append([userEvent('s2', 1, 'Fix Login Bug in the parser')])

        const hits = storage.sessions.searchText('登录')
        expect(hits.map((hit) => hit.sessionId)).toEqual(['s1'])
        expect(hits[0]?.snippet).toContain('登录')
        expect(storage.sessions.searchText('已经 修好').map((hit) => hit.sessionId)).toEqual(['s1'])
        expect(storage.sessions.searchText('LOGIN bug').map((hit) => hit.sessionId)).toEqual(['s2'])
        expect(storage.sessions.searchText('没有这句话')).toEqual([])
        expect(storage.sessions.searchText('   ')).toEqual([])
        expect(storage.sessions.searchText('登录', { limit: 1 })).toHaveLength(1)
      })

      it('excludes archived sessions from search unless asked, and forgets deleted ones', () => {
        seed()
        storage.events.append([userEvent('s1', 1, '需要记住的关键词')])
        expect(storage.sessions.searchText('关键词').map((hit) => hit.sessionId)).toEqual(['s1'])

        clock = 200
        storage.sessions.archive('s1')
        expect(storage.sessions.searchText('关键词')).toEqual([])
        expect(
          storage.sessions
            .searchText('关键词', { includeArchived: true })
            .map((hit) => hit.sessionId),
        ).toEqual(['s1'])

        storage.sessions.remove('s1')
        expect(storage.sessions.searchText('关键词', { includeArchived: true })).toEqual([])
      })

      it('reports missing sessions on update', () => {
        expectStorageError(() => storage.sessions.rename('nope', 't'), StorageErrorCode.NotFound)
        expectStorageError(
          () => storage.sessions.setPinned('nope', true),
          StorageErrorCode.NotFound,
        )
        expectStorageError(() => storage.sessions.archive('nope'), StorageErrorCode.NotFound)
        expectStorageError(() => storage.sessions.unarchive('nope'), StorageErrorCode.NotFound)
        expectStorageError(
          () => storage.sessions.setModel('nope', { providerId: 'p', modelId: 'm' }),
          StorageErrorCode.NotFound,
        )
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

      it('restores an archived session with unarchive', () => {
        seed()
        storage.sessions.archive('s1')
        expect(storage.sessions.list()).toEqual([])

        clock = 500
        const restored = storage.sessions.unarchive('s1')
        expect(restored).toMatchObject({ sessionId: 's1', archived: false, updatedAt: 500 })
        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s1'])
      })

      it('marks trial sessions and excludes them from the default list', () => {
        seed()
        clock = 200
        const trial = storage.sessions.create({
          sessionId: 't1',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '试运行',
          kind: 'trial',
          trialAgentId: 'user.reviewer',
          trialDraftHash: 'draft-1',
        })
        expect(trial).toMatchObject({
          sessionId: 't1',
          kind: 'trial',
          trialAgentId: 'user.reviewer',
          trialDraftHash: 'draft-1',
        })
        expect(storage.sessions.list().map((s) => s.sessionId)).toEqual(['s1'])
        expect(storage.sessions.list({ includeTrial: true }).map((s) => s.sessionId)).toEqual([
          't1',
          's1',
        ])
        expect(storage.sessions.get('t1')).toEqual(trial)
      })

      it('records the team template behind a team trial (M7-09)', () => {
        seed()
        clock = 300
        const trial = storage.sessions.create({
          sessionId: 't2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '团队试运行',
          kind: 'trial',
          trialAgentId: 'builtin.coder',
          trialDraftHash: 'agent-draft',
          trialTeamId: 'team.review',
          trialTeamDraftHash: 'team-draft',
        })
        expect(trial).toMatchObject({
          kind: 'trial',
          trialAgentId: 'builtin.coder',
          trialTeamId: 'team.review',
          trialTeamDraftHash: 'team-draft',
        })
        expect(storage.sessions.get('t2')).toEqual(trial)
        expect(storage.sessions.list({ includeTrial: true }).map((s) => s.sessionId)).toEqual([
          't2',
          's1',
        ])
      })

      it('removes a session with its events and reports missing sessions', () => {
        seed()
        storage.events.append([userEvent('s1', 1)])
        storage.changes.create({
          changeId: 'change-1',
          sessionId: 's1',
          path: 'a.ts',
          kind: 'modify',
          added: 1,
          removed: 0,
          hunks: [],
        })
        storage.permissionRules.add({
          rule: {
            id: 'rule-1',
            scope: 'session',
            effect: 'allow',
            match: { tool: 'read_file' },
            source: 'user',
          },
          sessionId: 's1',
        })
        storage.runSnapshots.add({
          snapshotId: 'snapshot-1',
          sessionId: 's1',
          runId: 'r1',
          tokens: 1,
          data: {},
        })
        storage.changeSets.create({
          changeSetId: 'change-set-1',
          sessionId: 's1',
          runId: 'r1',
          baseCommit: 'base',
          gitDir: '/repo/.git',
          workspacePath: '/work/isolated',
        })
        storage.changeSets.addFile({
          changeSetId: 'change-set-1',
          path: 'a.ts',
          kind: 'modified',
          added: 1,
          removed: 0,
          binary: false,
          large: false,
        })
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '保留',
        })
        storage.changes.create({
          changeId: 'change-2',
          sessionId: 's2',
          path: 'b.ts',
          kind: 'modify',
          added: 1,
          removed: 0,
          hunks: [],
        })
        storage.permissionRules.add({
          rule: {
            id: 'rule-2',
            scope: 'session',
            effect: 'allow',
            match: { tool: 'read_file' },
            source: 'user',
          },
          sessionId: 's2',
        })
        storage.runSnapshots.add({
          snapshotId: 'snapshot-2',
          sessionId: 's2',
          runId: 'r2',
          tokens: 1,
          data: {},
        })
        storage.changeSets.create({
          changeSetId: 'change-set-2',
          sessionId: 's2',
          runId: 'r2',
          baseCommit: 'base',
          gitDir: '/repo/.git',
          workspacePath: '/work/isolated-2',
        })
        storage.changeSets.addFile({
          changeSetId: 'change-set-2',
          path: 'b.ts',
          kind: 'modified',
          added: 1,
          removed: 0,
          binary: false,
          large: false,
        })
        storage.sessions.remove('s1')
        expect(storage.changes.list('s2')).toHaveLength(1)
        expect(storage.permissionRules.get('rule-2')).toBeDefined()
        expect(storage.runSnapshots.list('r2')).toHaveLength(1)
        expect(storage.changeSets.get('change-set-2')).toBeDefined()
        expect(storage.changeSets.listFiles('change-set-2')).toHaveLength(1)
        expect(storage.sessions.get('s1')).toBeUndefined()
        expect(storage.events.maxSeq('s1')).toBe(0)
        expect(storage.events.readAfter('s1', 0)).toEqual([])
        expect(storage.changes.list('s1')).toEqual([])
        expect(storage.permissionRules.get('rule-1')).toBeUndefined()
        expect(storage.runSnapshots.list('r1')).toEqual([])
        expect(storage.changeSets.get('change-set-1')).toBeUndefined()
        expect(storage.changeSets.listFiles('change-set-1')).toEqual([])
        expectStorageError(() => storage.sessions.remove('s1'), StorageErrorCode.NotFound)
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

      it('accepts gaps left by live events (shared seq counter)', () => {
        seed()
        storage.events.append([userEvent('s1', 1), userEvent('s1', 4)])
        storage.events.append([userEvent('s1', 9)])
        expect(storage.events.maxSeq('s1')).toBe(9)
        expect(storage.events.readAfter('s1', 0).map((e) => e.seq)).toEqual([1, 4, 9])
        expect(storage.events.readAfter('s1', 1).map((e) => e.seq)).toEqual([4, 9])
        expect(storage.events.readAfter('s1', 2).map((e) => e.seq)).toEqual([4, 9])
        expect(storage.events.readAfter('s1', 4, 1).map((e) => e.seq)).toEqual([9])
        expect(storage.events.readAfter('s1', 9)).toEqual([])
      })

      it('rejects duplicate or decreasing seq without writing any of the batch', () => {
        seed()
        storage.events.append([userEvent('s1', 1)])
        expectStorageError(
          () => storage.events.append([userEvent('s1', 2), userEvent('s1', 2)]),
          StorageErrorCode.SeqConflict,
        )
        expectStorageError(
          () => storage.events.append([userEvent('s1', 3), userEvent('s1', 0)]),
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

    describe('providers', () => {
      const deepseek = {
        id: 'deepseek',
        kind: 'openai' as const,
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        credentialRef: 'deepseek',
        template: 'deepseek',
        compat: { thinkingFormat: 'deepseek' as const, maxTokensField: 'max_tokens' as const },
        models: [
          {
            id: 'deepseek-chat',
            compat: { supportsStrictMode: true },
            contextWindow: 128_000,
            maxOutputTokens: 8_192,
            supportsTools: true,
            supportsParallelToolCalls: true,
            supportsReasoning: false,
            verifiedAt: 5,
          },
        ],
        catalog: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', contextWindow: 128_000 },
        ],
      }
      const ollama = {
        id: 'ollama',
        kind: 'openai' as const,
        displayName: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        models: [],
      }

      it('starts empty', () => {
        expect(storage.providers.list()).toEqual([])
        expect(storage.providers.get('deepseek')).toBeUndefined()
      })

      it('replaces the whole list, keeping its order', () => {
        storage.providers.replaceAll([ollama, deepseek])
        expect(storage.providers.list()).toEqual([ollama, deepseek])
        expect(storage.providers.get('deepseek')).toEqual(deepseek)
        expect(storage.providers.get('ollama')).not.toHaveProperty('credentialRef')
        expect(storage.providers.get('ollama')).not.toHaveProperty('compat')
        expect(storage.providers.get('ollama')).not.toHaveProperty('template')
        expect(storage.providers.get('ollama')).not.toHaveProperty('catalog')

        storage.providers.replaceAll([deepseek])
        expect(storage.providers.list()).toEqual([deepseek])
        storage.providers.replaceAll([])
        expect(storage.providers.list()).toEqual([])
      })

      it('returns copies', () => {
        storage.providers.replaceAll([deepseek])
        const listed = storage.providers.list()
        listed[0]!.models.pop()
        expect(storage.providers.get('deepseek')?.models).toHaveLength(1)
      })

      it('rejects duplicate ids and keeps the previous list', () => {
        storage.providers.replaceAll([ollama])
        expectStorageError(
          () => storage.providers.replaceAll([deepseek, deepseek]),
          StorageErrorCode.Conflict,
        )
        expect(storage.providers.list()).toEqual([ollama])
      })

      it('rolls back with the surrounding transaction', () => {
        storage.providers.replaceAll([ollama])
        expect(() =>
          storage.transaction(() => {
            storage.providers.replaceAll([deepseek])
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.providers.list()).toEqual([ollama])
      })
    })

    describe('changes', () => {
      const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }
      const change = (changeId: string, extra: object = {}) => ({
        changeId,
        sessionId: 's1',
        path: 'src/a.ts',
        kind: 'modify' as const,
        beforeHash: 'b'.repeat(64),
        afterHash: 'a'.repeat(64),
        added: 2,
        removed: 1,
        hunks: [hunk],
        ...extra,
      })

      it('creates pending records with hunks and lists them in order', () => {
        seed()
        const first = storage.changes.create(
          change('c2', { runId: 'r1', turnId: 't1', toolCallId: 'call1' }),
        )
        expect(first).toEqual({
          ...change('c2', { runId: 'r1', turnId: 't1', toolCallId: 'call1' }),
          status: 'pending',
          hunks: [{ ...hunk, status: 'pending' }],
          createdAt: 100,
        })
        clock = 200
        storage.changes.create({
          changeId: 'c1',
          sessionId: 's1',
          path: 'new.txt',
          kind: 'create',
          afterHash: 'c'.repeat(64),
          added: 0,
          removed: 0,
          hunks: [],
        })
        const { afterHash: _, ...deletion } = change('c3', { kind: 'delete' })
        storage.changes.create(deletion)
        const list = storage.changes.list('s1')
        expect(list.map((c) => c.changeId)).toEqual(['c2', 'c1', 'c3'])
        expect(list[1]).toEqual({
          changeId: 'c1',
          sessionId: 's1',
          path: 'new.txt',
          kind: 'create',
          afterHash: 'c'.repeat(64),
          status: 'pending',
          added: 0,
          removed: 0,
          hunks: [],
          createdAt: 200,
        })
        expect(list[2]).not.toHaveProperty('afterHash')
        expect(storage.changes.get('c2')).toEqual(first)
        expect(storage.changes.get('nope')).toBeUndefined()
        expect(storage.changes.list('other')).toEqual([])
      })

      it('sets the status of a change and its hunks; records reverts', () => {
        seed()
        storage.changes.create(
          change('c1', { hunks: [hunk, { ...hunk, oldStart: 9, newStart: 10 }] }),
        )
        const reverted = storage.changes.setStatus('c1', 'reverted')
        expect(reverted.status).toBe('reverted')
        expect(reverted.hunks.map((h) => h.status)).toEqual(['reverted', 'reverted'])
        expect(storage.changes.get('c1')).toEqual(reverted)
        const inverse = storage.changes.create(change('c2', { revertOf: 'c1' }))
        expect(inverse.revertOf).toBe('c1')
        expectStorageError(
          () => storage.changes.setStatus('nope', 'accepted'),
          StorageErrorCode.NotFound,
        )
      })

      it('reverts hunks one at a time; the change follows only when every hunk is reverted', () => {
        seed()
        storage.changes.create(
          change('c1', { hunks: [hunk, { ...hunk, oldStart: 9, newStart: 10 }] }),
        )
        const one = storage.changes.setHunkStatus('c1', 0, 'reverted')
        expect(one.status).toBe('pending')
        expect(one.hunks.map((h) => h.status)).toEqual(['reverted', 'pending'])
        const both = storage.changes.setHunkStatus('c1', 1, 'reverted')
        expect(both.status).toBe('reverted')
        expect(both.hunks.map((h) => h.status)).toEqual(['reverted', 'reverted'])
        const back = storage.changes.setHunkStatus('c1', 0, 'pending')
        expect(back.status).toBe('pending')
        expect(back.hunks.map((h) => h.status)).toEqual(['pending', 'reverted'])
        expect(storage.changes.get('c1')).toEqual(back)
        expectStorageError(
          () => storage.changes.setHunkStatus('c1', 2, 'reverted'),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.changes.setHunkStatus('nope', 0, 'reverted'),
          StorageErrorCode.NotFound,
        )
      })

      it('rejects unknown sessions, unknown revert targets and duplicate ids', () => {
        expectStorageError(() => storage.changes.create(change('c1')), StorageErrorCode.NotFound)
        seed()
        storage.changes.create(change('c1'))
        expectStorageError(() => storage.changes.create(change('c1')), StorageErrorCode.Conflict)
        expectStorageError(
          () => storage.changes.create(change('c2', { revertOf: 'nope' })),
          StorageErrorCode.NotFound,
        )
        expect(storage.changes.list('s1')).toHaveLength(1)
      })

      it('returns copies and rolls back with transactions', () => {
        seed()
        const record = storage.changes.create(change('c1'))
        ;(record.hunks as unknown as { oldStart: number }[])[0]!.oldStart = 99
        expect(storage.changes.get('c1')!.hunks[0]!.oldStart).toBe(1)
        expect(() =>
          storage.transaction(() => {
            storage.changes.create(change('c2'))
            storage.changes.setStatus('c1', 'reverted')
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.changes.list('s1').map((c) => [c.changeId, c.status])).toEqual([
          ['c1', 'pending'],
        ])
      })
    })

    describe('permissionRules', () => {
      const rule = (
        id: string,
        scope: PermissionRule['scope'],
        extra: Partial<PermissionRule> = {},
      ): PermissionRule => ({
        id,
        scope,
        effect: 'allow',
        match: { tool: 'run_command', command: ['npm test'] },
        source: 'approval',
        ...extra,
      })

      it('adds rules and lists the ones that apply, global first', () => {
        seed()
        storage.projects.create({ projectId: 'p2', name: 'Other', path: '/work/other' })
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p2',
          workspacePath: '/work/other',
          title: 'other',
        })
        const session = storage.permissionRules.add({
          rule: rule('r1', 'session'),
          sessionId: 's1',
        })
        expect(session).toEqual({ rule: rule('r1', 'session'), sessionId: 's1', createdAt: 100 })
        clock = 200
        storage.permissionRules.add({ rule: rule('r2', 'project'), projectId: 'p1' })
        storage.permissionRules.add({
          rule: rule('r3', 'global', {
            effect: 'deny',
            match: { path: ['**/.env'] },
            source: 'user',
          }),
        })
        storage.permissionRules.add({ rule: rule('r4', 'project'), projectId: 'p2' })
        storage.permissionRules.add({ rule: rule('r5', 'session'), sessionId: 's2' })
        storage.permissionRules.add({ rule: rule('r0', 'global', { match: {} }) })

        const ids = (options?: { projectId?: string; sessionId?: string }) =>
          storage.permissionRules.list(options).map((r) => r.rule.id)
        expect(ids()).toEqual(['r3', 'r0'])
        expect(ids({ projectId: 'p1', sessionId: 's1' })).toEqual(['r3', 'r0', 'r2', 'r1'])
        expect(ids({ projectId: 'p2', sessionId: 's2' })).toEqual(['r3', 'r0', 'r4', 'r5'])
        expect(ids({ sessionId: 's1' })).toEqual(['r3', 'r0', 'r1'])
        expect(storage.permissionRules.get('r2')).toEqual({
          rule: rule('r2', 'project'),
          projectId: 'p1',
          createdAt: 200,
        })
        expect(storage.permissionRules.get('r3')).toEqual({
          rule: rule('r3', 'global', {
            effect: 'deny',
            match: { path: ['**/.env'] },
            source: 'user',
          }),
          createdAt: 200,
        })
        expect(storage.permissionRules.get('nope')).toBeUndefined()
      })

      it('rejects inconsistent owners, presets, unknown owners and duplicate ids', () => {
        seed()
        const invalid = [
          { rule: rule('a', 'global'), projectId: 'p1' },
          { rule: rule('a', 'global'), sessionId: 's1' },
          { rule: rule('a', 'project') },
          { rule: rule('a', 'project'), projectId: 'p1', sessionId: 's1' },
          { rule: rule('a', 'session') },
          { rule: rule('a', 'session'), projectId: 'p1' },
          { rule: rule('a', 'global', { source: 'preset' }) },
        ]
        for (const input of invalid) {
          expectStorageError(
            () => storage.permissionRules.add(input),
            StorageErrorCode.InvalidRecord,
          )
        }
        expectStorageError(
          () => storage.permissionRules.add({ rule: rule('a', 'project'), projectId: 'nope' }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.permissionRules.add({ rule: rule('a', 'session'), sessionId: 'nope' }),
          StorageErrorCode.NotFound,
        )
        storage.permissionRules.add({ rule: rule('a', 'global') })
        expectStorageError(
          () => storage.permissionRules.add({ rule: rule('a', 'session'), sessionId: 's1' }),
          StorageErrorCode.Conflict,
        )
        expect(storage.permissionRules.list({ sessionId: 's1' })).toHaveLength(1)
      })

      it('deletes rules, returns copies and rolls back with transactions', () => {
        seed()
        storage.permissionRules.add({ rule: rule('a', 'global') })
        const record = storage.permissionRules.get('a')!
        ;(record.rule.match.command as string[]).push('rm -rf /')
        expect(storage.permissionRules.get('a')!.rule.match.command).toEqual(['npm test'])
        expect(() =>
          storage.transaction(() => {
            storage.permissionRules.delete('a')
            storage.permissionRules.add({ rule: rule('b', 'session'), sessionId: 's1' })
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.permissionRules.list({ sessionId: 's1' }).map((r) => r.rule.id)).toEqual([
          'a',
        ])
        storage.permissionRules.delete('a')
        expect(storage.permissionRules.get('a')).toBeUndefined()
        expectStorageError(() => storage.permissionRules.delete('a'), StorageErrorCode.NotFound)
      })
    })

    describe('memory entries', () => {
      it('keeps scopes isolated and lists session, project, then global entries', () => {
        seed()
        storage.projects.create({ projectId: 'p2', name: 'Other', path: '/work/other' })
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p2',
          workspacePath: '/work/other',
          title: '另一个会话',
        })
        storage.memories.propose({ memoryId: 'g1', scope: 'global', content: '全局' })
        storage.memories.propose({
          memoryId: 'p1m',
          scope: 'project',
          projectId: 'p1',
          content: '项目 1',
        })
        storage.memories.propose({
          memoryId: 'p2m',
          scope: 'project',
          projectId: 'p2',
          content: '项目 2',
        })
        storage.memories.propose({
          memoryId: 's1m',
          scope: 'session',
          sessionId: 's1',
          content: '会话 1',
        })
        storage.memories.propose({
          memoryId: 's2m',
          scope: 'session',
          sessionId: 's2',
          content: '会话 2',
        })

        const ids = (options?: Parameters<Storage['memories']['list']>[0]) =>
          storage.memories.list(options).map((entry) => entry.memoryId)
        // 没有给出项目或会话时只能读到全局记忆。
        expect(ids()).toEqual(['g1'])
        expect(ids({ projectId: 'p1', sessionId: 's1' })).toEqual(['s1m', 'p1m', 'g1'])
        expect(ids({ projectId: 'p2', sessionId: 's2' })).toEqual(['s2m', 'p2m', 'g1'])
        expect(ids({ projectId: 'p2' })).toEqual(['p2m', 'g1'])

        // 其他项目与会话的记忆在查询层就不可达。
        const visible = storage.memories.list({ projectId: 'p1', sessionId: 's1' })
        expect(visible.map((entry) => entry.memoryId)).not.toContain('p2m')
        expect(visible.map((entry) => entry.memoryId)).not.toContain('s2m')

        clock = 200
        storage.memories.confirm('s1m')
        expect(ids({ projectId: 'p1', sessionId: 's1', status: 'active' })).toEqual(['s1m'])
        expect(ids({ projectId: 'p1', sessionId: 's1', status: 'proposed' })).toEqual(['p1m', 'g1'])
      })

      it('lists every scope for the management view, optionally filtered (M7-04)', () => {
        seed()
        storage.projects.create({ projectId: 'p2', name: 'Other', path: '/work/other' })
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p2',
          workspacePath: '/work/other',
          title: '另一个会话',
        })
        storage.memories.propose({ memoryId: 'g1', scope: 'global', content: '全局' })
        storage.memories.propose({
          memoryId: 'p1m',
          scope: 'project',
          projectId: 'p1',
          content: '项目 1',
        })
        storage.memories.propose({
          memoryId: 's2m',
          scope: 'session',
          sessionId: 's2',
          content: '会话 2',
        })
        clock = 200
        storage.memories.confirm('g1')

        const ids = (options?: Parameters<Storage['memories']['listAll']>[0]) =>
          storage.memories.listAll(options).map((entry) => entry.memoryId)
        expect(ids()).toEqual(['s2m', 'p1m', 'g1'])
        expect(ids({ scope: 'project' })).toEqual(['p1m'])
        expect(ids({ status: 'active' })).toEqual(['g1'])
        expect(ids({ scope: 'session', status: 'proposed' })).toEqual(['s2m'])
      })

      it('records source and returns copies instead of stored records', () => {
        seed()
        const entry = storage.memories.propose({
          memoryId: 'm1',
          scope: 'session',
          sessionId: 's1',
          content: '偏好用制表符',
          sourceRunId: 'r1',
          sourceAgentId: 'builtin.default',
        })
        expect(entry).toEqual({
          memoryId: 'm1',
          scope: 'session',
          sessionId: 's1',
          content: '偏好用制表符',
          status: 'proposed',
          sourceRunId: 'r1',
          sourceAgentId: 'builtin.default',
          createdAt: 100,
          updatedAt: 100,
        })
        ;(entry as { content: string }).content = 'tampered'
        expect(storage.memories.get('m1')?.content).toBe('偏好用制表符')
        expect(storage.memories.get('nope')).toBeUndefined()
      })

      it('rejects inconsistent owners, empty content, unknown owners and duplicate ids', () => {
        seed()
        const invalid: ProposeMemoryInput[] = [
          { memoryId: 'a', scope: 'global', content: 'x', projectId: 'p1' },
          { memoryId: 'a', scope: 'global', content: 'x', sessionId: 's1' },
          { memoryId: 'a', scope: 'project', content: 'x' },
          { memoryId: 'a', scope: 'project', content: 'x', projectId: 'p1', sessionId: 's1' },
          { memoryId: 'a', scope: 'session', content: 'x' },
          { memoryId: 'a', scope: 'session', content: 'x', projectId: 'p1' },
          { memoryId: 'a', scope: 'global', content: '   ' },
        ]
        for (const input of invalid) {
          expectStorageError(() => storage.memories.propose(input), StorageErrorCode.InvalidRecord)
        }
        expectStorageError(
          () =>
            storage.memories.propose({
              memoryId: 'a',
              scope: 'project',
              projectId: 'nope',
              content: 'x',
            }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () =>
            storage.memories.propose({
              memoryId: 'a',
              scope: 'session',
              sessionId: 'nope',
              content: 'x',
            }),
          StorageErrorCode.NotFound,
        )
        storage.memories.propose({ memoryId: 'a', scope: 'global', content: 'x' })
        expectStorageError(
          () =>
            storage.memories.propose({
              memoryId: 'a',
              scope: 'session',
              sessionId: 's1',
              content: 'x',
            }),
          StorageErrorCode.Conflict,
        )
        expect(storage.memories.list()).toHaveLength(1)
      })

      it('confirms, edits and hard-deletes entries', () => {
        seed()
        storage.memories.propose({ memoryId: 'm1', scope: 'global', content: 'v1' })
        clock = 200
        expect(storage.memories.confirm('m1')).toMatchObject({ status: 'active', updatedAt: 200 })
        // 重复确认不再改变时间。
        clock = 300
        expect(storage.memories.confirm('m1')).toMatchObject({ status: 'active', updatedAt: 200 })
        expect(storage.memories.update('m1', 'v2')).toMatchObject({
          content: 'v2',
          status: 'active',
          updatedAt: 300,
        })
        expectStorageError(
          () => storage.memories.update('m1', '  '),
          StorageErrorCode.InvalidRecord,
        )
        expectStorageError(() => storage.memories.update('nope', 'x'), StorageErrorCode.NotFound)

        const deleted = storage.memories.delete('m1')
        expect(deleted.content).toBe('v2')
        expect(storage.memories.get('m1')).toBeUndefined()
        expect(storage.memories.list()).toEqual([])
        expectStorageError(() => storage.memories.delete('m1'), StorageErrorCode.NotFound)
        expectStorageError(() => storage.memories.confirm('m1'), StorageErrorCode.NotFound)
      })

      it('orders memories of the same scope by creation time', () => {
        storage.memories.propose({ memoryId: 'first', scope: 'global', content: '先' })
        clock = 200
        storage.memories.propose({ memoryId: 'second', scope: 'global', content: '后' })
        expect(storage.memories.list().map((entry) => entry.memoryId)).toEqual(['first', 'second'])
        expect(storage.memories.listAll().map((entry) => entry.memoryId)).toEqual([
          'first',
          'second',
        ])
      })

      it('rolls back with transactions and drops session memory with its session', () => {
        seed()
        storage.memories.propose({
          memoryId: 's',
          scope: 'session',
          sessionId: 's1',
          content: '会话记忆',
        })
        storage.memories.propose({
          memoryId: 'p',
          scope: 'project',
          projectId: 'p1',
          content: '项目记忆',
        })
        expect(() =>
          storage.transaction(() => {
            storage.memories.confirm('s')
            storage.memories.delete('p')
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.memories.get('s')?.status).toBe('proposed')
        expect(storage.memories.get('p')).toBeDefined()

        storage.sessions.remove('s1')
        expect(storage.memories.get('s')).toBeUndefined()
        // 项目记忆不属于某个会话，会话删除后仍在。
        expect(storage.memories.get('p')).toBeDefined()
      })
    })

    describe('skill prefs', () => {
      it('stores enabled and pinned per scope and source, and delete is idempotent', () => {
        expect(storage.skillPrefs.get('global', 'user', 'demo')).toBeUndefined()
        expect(storage.skillPrefs.list('global')).toEqual([])
        const saved = storage.skillPrefs.set({
          scope: 'global',
          source: 'user',
          name: 'demo',
          enabled: false,
          pinned: true,
        })
        expect(saved).toEqual({
          scope: 'global',
          source: 'user',
          name: 'demo',
          enabled: false,
          pinned: true,
        })
        storage.skillPrefs.set({
          scope: 'p1',
          source: 'project',
          name: 'demo',
          enabled: true,
          pinned: false,
        })
        expect(storage.skillPrefs.list('global')).toEqual([saved])
        expect(storage.skillPrefs.get('global', 'builtin', 'demo')).toBeUndefined()
        const updated = storage.skillPrefs.set({ ...saved, enabled: true })
        expect(storage.skillPrefs.get('global', 'user', 'demo')).toEqual(updated)
        const copy = storage.skillPrefs.get('global', 'user', 'demo')!
        ;(copy as { enabled: boolean }).enabled = false
        expect(storage.skillPrefs.get('global', 'user', 'demo')?.enabled).toBe(true)
        expect(() =>
          storage.transaction(() => {
            storage.skillPrefs.delete('global', 'user', 'demo')
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.skillPrefs.get('global', 'user', 'demo')?.enabled).toBe(true)
        storage.skillPrefs.delete('global', 'user', 'demo')
        storage.skillPrefs.delete('global', 'user', 'demo')
        expect(storage.skillPrefs.get('global', 'user', 'demo')).toBeUndefined()
        expect(storage.skillPrefs.list('p1')).toHaveLength(1)
      })
    })

    describe('mcp servers', () => {
      it('creates, reads and updates stdio and http servers', () => {
        const created = storage.mcpServers.create({
          serverId: 'm1',
          name: 'Local',
          kind: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'TOKEN', credentialRef: 'ref-token' }],
        })
        expect(created).toMatchObject({
          serverId: 'm1',
          name: 'Local',
          kind: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'TOKEN', credentialRef: 'ref-token' }],
          enabled: true,
          createdAt: 100,
          updatedAt: 100,
        })
        clock = 200
        const updated = storage.mcpServers.update('m1', {
          kind: 'http',
          url: 'https://example.com/mcp',
          command: null,
          cwd: null,
          auth: 'bearer',
          credentialRef: 'ref-auth',
          headerName: null,
          env: [],
          enabled: false,
        })
        expect(updated).toMatchObject({
          kind: 'http',
          url: 'https://example.com/mcp',
          auth: 'bearer',
          credentialRef: 'ref-auth',
          enabled: false,
          updatedAt: 200,
        })
        expect(updated.command).toBeUndefined()
        expect(storage.mcpServers.list()).toEqual([updated])
      })

      it('rejects duplicate ids and unknown records', () => {
        storage.mcpServers.create({ serverId: 'm1', name: 'A', kind: 'stdio', command: 'node' })
        expectStorageError(
          () =>
            storage.mcpServers.create({
              serverId: 'm1',
              name: 'B',
              kind: 'stdio',
              command: 'node',
            }),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.mcpServers.update('missing', { name: 'X' }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(() => storage.mcpServers.remove('missing'), StorageErrorCode.NotFound)
      })

      it('stores tool preferences and removes them with the server', () => {
        storage.mcpServers.create({ serverId: 'm1', name: 'A', kind: 'stdio', command: 'node' })
        expect(storage.mcpToolPrefs.get('m1', 'echo')).toBeUndefined()
        const pref = storage.mcpToolPrefs.set({
          serverId: 'm1',
          name: 'echo',
          category: 'read',
          effect: 'allow',
        })
        expect(pref).toEqual({
          serverId: 'm1',
          name: 'echo',
          category: 'read',
          effect: 'allow',
        })
        expect(storage.mcpToolPrefs.list('m1')).toEqual([pref])
        expect(storage.mcpToolPrefs.get('m1', 'echo')).toEqual(pref)
        expect(storage.mcpServers.get('m1')?.serverId).toBe('m1')
        storage.mcpServers.remove('m1')
        expect(storage.mcpToolPrefs.list('m1')).toEqual([])
      })

      it('rejects preferences for unknown servers', () => {
        expectStorageError(
          () =>
            storage.mcpToolPrefs.set({
              serverId: 'missing',
              name: 'echo',
              category: 'read',
              effect: 'allow',
            }),
          StorageErrorCode.NotFound,
        )
      })

      it('handles optional fields and deletes preferences by server', () => {
        const full = storage.mcpServers.create({
          serverId: 'm2',
          name: 'Full',
          kind: 'stdio',
          cwd: '/work',
          url: 'https://example.com/mcp',
          headerName: 'X-Key',
          credentialRef: 'ref',
          enabled: false,
        })
        expect(full).toMatchObject({
          cwd: '/work',
          url: 'https://example.com/mcp',
          headerName: 'X-Key',
          credentialRef: 'ref',
          enabled: false,
        })

        const patched = storage.mcpServers.update('m2', {
          command: 'node',
          args: ['server.mjs'],
          cwd: '/next',
          url: 'https://next.example.com/mcp',
          headerName: 'X-Next',
          credentialRef: 'ref-next',
          enabled: true,
        })
        expect(patched).toMatchObject({
          command: 'node',
          args: ['server.mjs'],
          cwd: '/next',
          url: 'https://next.example.com/mcp',
          headerName: 'X-Next',
          credentialRef: 'ref-next',
          enabled: true,
        })

        const cleared = storage.mcpServers.update('m2', { url: null, credentialRef: null })
        expect(cleared.url).toBeUndefined()
        expect(cleared.credentialRef).toBeUndefined()

        const minimal = storage.mcpServers.create({
          serverId: 'm3',
          name: 'Minimal',
          kind: 'http',
        })
        expect(minimal.command).toBeUndefined()
        expect(minimal.cwd).toBeUndefined()
        expect(minimal.url).toBeUndefined()
        expect(minimal.headerName).toBeUndefined()
        expect(minimal.credentialRef).toBeUndefined()
        expect(minimal.enabled).toBe(true)

        const renamed = storage.mcpServers.update('m3', { name: 'Renamed' })
        expect(renamed.name).toBe('Renamed')
        expect(renamed.command).toBeUndefined()
        expect(renamed.url).toBeUndefined()
        expect(renamed.enabled).toBe(true)

        storage.mcpToolPrefs.set({
          serverId: 'm2',
          name: 'echo',
          category: 'read',
          effect: 'allow',
        })
        storage.mcpToolPrefs.set({
          serverId: 'm3',
          name: 'echo',
          category: 'write',
          effect: 'deny',
        })
        storage.mcpToolPrefs.deleteForServer('m2')
        expect(storage.mcpToolPrefs.list('m2')).toEqual([])
        expect(storage.mcpToolPrefs.list('m3')).toHaveLength(1)

        storage.mcpServers.remove('m2')
        expect(storage.mcpServers.get('m2')).toBeUndefined()
      })
    })

    describe('agents', () => {
      const draft = { id: 'user.reviewer', name: { 'zh-CN': '审查员' }, instructions: 'review' }

      it('creates a draft, publishes versions and keeps them ordered', () => {
        const created = storage.agents.create({ agentId: 'user.reviewer', source: 'user', draft })
        expect(created.archived).toBe(false)
        expect(storage.agents.list()).toHaveLength(1)
        expect(storage.agents.get('user.reviewer')?.draft).toEqual(draft)

        storage.agents.saveDraft('user.reviewer', { ...draft, instructions: 'second' })
        expect(storage.agents.get('user.reviewer')?.draft).toEqual({
          ...draft,
          instructions: 'second',
        })

        storage.agents.addVersion({
          agentId: 'user.reviewer',
          version: 2,
          definition: { ...draft, version: 2 },
        })
        storage.agents.addVersion({
          agentId: 'user.reviewer',
          version: 1,
          definition: { ...draft, version: 1 },
        })
        expect(storage.agents.versions('user.reviewer').map((item) => item.version)).toEqual([1, 2])
        expect(storage.agents.version('user.reviewer', 2)?.definition).toEqual({
          ...draft,
          version: 2,
        })

        const cleared = storage.agents.clearDraft('user.reviewer')
        expect(cleared.draft).toBeUndefined()
        expect(storage.agents.setArchived('user.reviewer', true).archived).toBe(true)
        expect(storage.agents.setArchived('user.reviewer', false).archived).toBe(false)

        const bare = storage.agents.create({ agentId: 'user.bare', source: 'user' })
        expect(bare.draft).toBeUndefined()
        expect(storage.agents.get('user.bare')?.draft).toBeUndefined()
      })

      it('rejects duplicates and missing records', () => {
        storage.agents.create({ agentId: 'user.reviewer', source: 'user', draft })
        expectStorageError(
          () => storage.agents.create({ agentId: 'user.reviewer', source: 'user' }),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.agents.saveDraft('missing', draft),
          StorageErrorCode.NotFound,
        )
        storage.agents.addVersion({ agentId: 'user.reviewer', version: 1, definition: draft })
        expectStorageError(
          () =>
            storage.agents.addVersion({ agentId: 'user.reviewer', version: 1, definition: draft }),
          StorageErrorCode.Conflict,
        )
        expect(storage.agents.version('missing', 1)).toBeUndefined()
        expect(storage.agents.version('user.reviewer', 2)).toBeUndefined()
        expectStorageError(() => storage.agents.clearDraft('missing'), StorageErrorCode.NotFound)
        expectStorageError(
          () => storage.agents.setArchived('missing', true),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.agents.addVersion({ agentId: 'missing', version: 1, definition: draft }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(() => storage.agents.remove('missing'), StorageErrorCode.NotFound)
      })

      it('removes an agent together with its versions', () => {
        storage.agents.create({ agentId: 'user.reviewer', source: 'user', draft })
        storage.agents.addVersion({ agentId: 'user.reviewer', version: 1, definition: draft })
        storage.agents.remove('user.reviewer')
        expect(storage.agents.get('user.reviewer')).toBeUndefined()
        expect(storage.agents.versions('user.reviewer')).toEqual([])
      })
    })

    describe('agent teams', () => {
      const draft = {
        id: 'team.review',
        name: { 'zh-CN': '审查团队' },
        coordinator: 'builtin.coder',
        members: ['builtin.reviewer'],
        pattern: 'delegate',
      }

      it('creates a draft, publishes versions and keeps them ordered', () => {
        const created = storage.teams.create({ teamId: 'team.review', draft })
        expect(created.archived).toBe(false)
        expect(storage.teams.list()).toHaveLength(1)
        expect(storage.teams.get('team.review')?.draft).toEqual(draft)

        storage.teams.saveDraft('team.review', { ...draft, pattern: 'review-loop' })
        expect(storage.teams.get('team.review')?.draft).toEqual({
          ...draft,
          pattern: 'review-loop',
        })

        storage.teams.addVersion({
          teamId: 'team.review',
          version: 2,
          definition: { ...draft, version: 2 },
        })
        storage.teams.addVersion({
          teamId: 'team.review',
          version: 1,
          definition: { ...draft, version: 1 },
        })
        expect(storage.teams.versions('team.review').map((item) => item.version)).toEqual([1, 2])
        expect(storage.teams.version('team.review', 2)?.definition).toEqual({
          ...draft,
          version: 2,
        })

        expect(storage.teams.clearDraft('team.review').draft).toBeUndefined()
        expect(storage.teams.setArchived('team.review', true).archived).toBe(true)
        expect(storage.teams.setArchived('team.review', false).archived).toBe(false)

        const bare = storage.teams.create({ teamId: 'team.bare' })
        expect(bare.draft).toBeUndefined()
        expect(storage.teams.get('team.bare')?.draft).toBeUndefined()
      })

      it('rejects duplicates and missing records', () => {
        storage.teams.create({ teamId: 'team.review', draft })
        expectStorageError(
          () => storage.teams.create({ teamId: 'team.review' }),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.teams.saveDraft('missing', draft),
          StorageErrorCode.NotFound,
        )
        storage.teams.addVersion({ teamId: 'team.review', version: 1, definition: draft })
        expectStorageError(
          () => storage.teams.addVersion({ teamId: 'team.review', version: 1, definition: draft }),
          StorageErrorCode.Conflict,
        )
        expect(storage.teams.version('missing', 1)).toBeUndefined()
        expect(storage.teams.version('team.review', 2)).toBeUndefined()
        expectStorageError(() => storage.teams.clearDraft('missing'), StorageErrorCode.NotFound)
        expectStorageError(
          () => storage.teams.setArchived('missing', true),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.teams.addVersion({ teamId: 'missing', version: 1, definition: draft }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(() => storage.teams.remove('missing'), StorageErrorCode.NotFound)
      })

      it('removes a team together with its versions', () => {
        storage.teams.create({ teamId: 'team.review', draft })
        storage.teams.addVersion({ teamId: 'team.review', version: 1, definition: draft })
        storage.teams.remove('team.review')
        expect(storage.teams.get('team.review')).toBeUndefined()
        expect(storage.teams.versions('team.review')).toEqual([])
      })
    })

    describe('run snapshots', () => {
      const snapshot = (snapshotId: string, runId = 'run-1', extra: object = {}) => ({
        snapshotId,
        sessionId: 's1',
        runId,
        tokens: 12,
        data: {
          runId,
          agent: { id: 'builtin.coder', version: 1 },
          model: { providerId: 'fake', modelId: 'fake-1' },
          tokens: 12,
          systemPrompt: [],
          skills: [],
          tools: [],
          history: { messages: 0, tokens: 0, preview: [] },
        },
        ...extra,
      })

      it('stores snapshots, fills createdAt and returns copies', () => {
        seed()
        const added = storage.runSnapshots.add(
          snapshot('snap-1', 'run-1', { parentRunId: 'parent', turnId: 't1', stepId: 'st1' }),
        )
        expect(added).toMatchObject({
          snapshotId: 'snap-1',
          sessionId: 's1',
          runId: 'run-1',
          parentRunId: 'parent',
          turnId: 't1',
          stepId: 'st1',
          createdAt: 100,
          tokens: 12,
        })
        expect(storage.runSnapshots.list('run-1')).toEqual([added])
        ;(added.data as { runId: string }).runId = 'changed'
        expect((storage.runSnapshots.list('run-1')[0]!.data as { runId: string }).runId).toBe(
          'run-1',
        )
      })

      it('keeps the latest 20 per run and lists them oldest first', () => {
        seed()
        for (let i = 1; i <= 25; i += 1) {
          clock = 100 + i
          storage.runSnapshots.add(snapshot(`snap-${i}`))
        }
        const kept = storage.runSnapshots.list('run-1')
        expect(kept).toHaveLength(20)
        expect(kept.map((item) => item.snapshotId)).toEqual(
          Array.from({ length: 20 }, (_, index) => `snap-${index + 6}`),
        )
        expect(storage.runSnapshots.list('run-1', 3).map((item) => item.snapshotId)).toEqual([
          'snap-6',
          'snap-7',
          'snap-8',
        ])
        expect(storage.runSnapshots.list('run-1', 0)).toEqual([])
        expect(storage.runSnapshots.list('other')).toEqual([])
      })

      it('limits each run independently', () => {
        seed()
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '',
        })
        storage.runSnapshots.add(snapshot('a1', 'a'))
        storage.runSnapshots.add(snapshot('b1', 'b'))
        storage.runSnapshots.add(snapshot('a2', 'a'))
        expect(storage.runSnapshots.list('a').map((item) => item.snapshotId)).toEqual(['a1', 'a2'])
        expect(storage.runSnapshots.list('b').map((item) => item.snapshotId)).toEqual(['b1'])
      })

      it('rejects unknown sessions and duplicate ids', () => {
        seed()
        storage.runSnapshots.add(snapshot('snap-1'))
        expectStorageError(
          () => storage.runSnapshots.add(snapshot('snap-1')),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.runSnapshots.add({ ...snapshot('snap-2'), sessionId: 'missing' }),
          StorageErrorCode.NotFound,
        )
      })

      it('rolls back with transactions', () => {
        seed()
        expect(() =>
          storage.transaction(() => {
            storage.runSnapshots.add(snapshot('snap-1'))
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.runSnapshots.list('run-1')).toEqual([])
      })
    })

    describe('changeSets', () => {
      const changeSet = (changeSetId: string, extra: object = {}) => ({
        changeSetId,
        sessionId: 's1',
        runId: 'run-child',
        parentRunId: 'run-parent',
        baseCommit: 'a'.repeat(40),
        baseCreatedAt: 90,
        gitDir: '/data/checkpoints/p1.git',
        workspacePath: '/data/worktrees/s1/run-child',
        ...extra,
      })

      it('creates and reads change sets', () => {
        seed()
        const created = storage.changeSets.create(changeSet('cs-1'))
        expect(created).toEqual({
          changeSetId: 'cs-1',
          sessionId: 's1',
          runId: 'run-child',
          parentRunId: 'run-parent',
          baseCommit: 'a'.repeat(40),
          baseCreatedAt: 90,
          gitDir: '/data/checkpoints/p1.git',
          workspacePath: '/data/worktrees/s1/run-child',
          status: 'pending',
          createdAt: 100,
        })
        expect(storage.changeSets.get('cs-1')).toEqual(created)
        expect(storage.changeSets.get('missing')).toBeUndefined()
      })

      it('omits the baseline time for old records', () => {
        seed()
        const created = storage.changeSets.create({
          changeSetId: 'cs-old',
          sessionId: 's1',
          runId: 'run-child',
          baseCommit: 'a'.repeat(40),
          gitDir: '/data/checkpoints/p1.git',
          workspacePath: '/data/worktrees/s1/run-child',
        })
        expect(created).not.toHaveProperty('baseCreatedAt')
      })

      it('lists change sets of a session oldest first', () => {
        seed()
        storage.sessions.create({
          sessionId: 's2',
          projectId: 'p1',
          workspacePath: '/work/demo',
          title: '',
        })
        storage.changeSets.create(changeSet('cs-1'))
        clock = 200
        storage.changeSets.create(changeSet('cs-2'))
        expect(storage.changeSets.listBySession('s1').map((item) => item.changeSetId)).toEqual([
          'cs-1',
          'cs-2',
        ])
        expect(storage.changeSets.listBySession('s2')).toEqual([])
      })

      it('updates status, checkpoint and mergedAt', () => {
        seed()
        storage.changeSets.create(changeSet('cs-1'))
        const withCheckpoint = storage.changeSets.setCheckpointCommit('cs-1', 'b'.repeat(40))
        expect(withCheckpoint.checkpointCommit).toBe('b'.repeat(40))
        clock = 300
        const applied = storage.changeSets.setStatus('cs-1', 'applied')
        expect(applied.status).toBe('applied')
        expect(applied.mergedAt).toBe(300)
        expect(applied.checkpointCommit).toBe('b'.repeat(40))
        const rejected = storage.changeSets.setStatus('cs-1', 'rejected')
        expect(rejected.status).toBe('rejected')
        expect(rejected.mergedAt).toBe(300)
      })

      it('rejects unknown sessions, duplicate ids and unknown change sets', () => {
        seed()
        storage.changeSets.create(changeSet('cs-1'))
        expectStorageError(
          () => storage.changeSets.create(changeSet('cs-1')),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.changeSets.create(changeSet('cs-2', { sessionId: 'missing' })),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.changeSets.setStatus('missing', 'applied'),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.changeSets.setCheckpointCommit('missing', 'b'.repeat(40)),
          StorageErrorCode.NotFound,
        )
      })

      it('stores files with their metadata and lists them by path', () => {
        seed()
        storage.changeSets.create(changeSet('cs-1'))
        const file = storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'src/a.ts',
          kind: 'modified',
          added: 3,
          removed: 1,
          patch: '@@ -1 +1 @@',
          binary: false,
          large: false,
          baseHash: 'h1',
          contentHash: 'h2',
        })
        expect(file).toEqual({
          changeSetId: 'cs-1',
          path: 'src/a.ts',
          status: 'pending',
          kind: 'modified',
          added: 3,
          removed: 1,
          patch: '@@ -1 +1 @@',
          binary: false,
          large: false,
          baseHash: 'h1',
          contentHash: 'h2',
        })
        storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'src/b.ts',
          kind: 'added',
          added: 1,
          removed: 0,
          binary: true,
          large: false,
          contentHash: 'h3',
        })
        expect(storage.changeSets.listFiles('cs-1').map((item) => item.path)).toEqual([
          'src/a.ts',
          'src/b.ts',
        ])
        expect(storage.changeSets.listFiles('cs-1')[1]).not.toHaveProperty('baseHash')
        storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'src/large.bin',
          kind: 'added',
          added: 0,
          removed: 0,
          binary: true,
          large: true,
        })
        expect(storage.changeSets.listFiles('cs-1')[2]).toMatchObject({ large: true, binary: true })
      })

      it('rejects duplicate files and unknown change sets', () => {
        seed()
        storage.changeSets.create(changeSet('cs-1'))
        storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'src/a.ts',
          kind: 'added',
          added: 1,
          removed: 0,
          binary: false,
          large: false,
          contentHash: 'h1',
        })
        expectStorageError(
          () =>
            storage.changeSets.addFile({
              changeSetId: 'cs-1',
              path: 'src/a.ts',
              kind: 'added',
              added: 1,
              removed: 0,
              binary: false,
              large: false,
              contentHash: 'h2',
            }),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () =>
            storage.changeSets.addFile({
              changeSetId: 'missing',
              path: 'src/a.ts',
              kind: 'added',
              added: 1,
              removed: 0,
              binary: false,
              large: false,
              contentHash: 'h2',
            }),
          StorageErrorCode.NotFound,
        )
      })

      it('updates the status of one file', () => {
        seed()
        storage.changeSets.create(changeSet('cs-1'))
        storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'src/a.ts',
          kind: 'added',
          added: 1,
          removed: 0,
          binary: false,
          large: false,
          contentHash: 'h1',
        })
        const updated = storage.changeSets.setFileStatus('cs-1', 'src/a.ts', 'accepted')
        expect(updated.status).toBe('accepted')
        expect(storage.changeSets.listFiles('cs-1')[0]!.status).toBe('accepted')
        expectStorageError(
          () => storage.changeSets.setFileStatus('cs-1', 'missing.ts', 'accepted'),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.changeSets.setFileStatus('missing', 'src/a.ts', 'accepted'),
          StorageErrorCode.NotFound,
        )
      })
    })

    describe('auto-fix watches and jobs', () => {
      const watch = (watchId: string, extra: object = {}) => ({
        watchId,
        repo: 'o/r',
        prNumber: 12,
        projectPath: '/work/demo',
        triggers: ['ci', 'conflict'] as AutoFixTrigger[],
        maxAttempts: 3,
        ...extra,
      })
      const job = (jobId: string, extra: object = {}) => ({
        jobId,
        watchId: 'w1',
        trigger: 'ci' as const,
        signature: 'sha:test',
        status: 'queued' as AutoFixJobStatus,
        attempt: 1,
        ...extra,
      })

      it('creates a watch with defaults and applies partial updates', () => {
        const created = storage.autoFix.watches.create(watch('w1'))
        expect(created).toMatchObject({
          watchId: 'w1',
          enabled: true,
          attempts: 0,
          triggers: ['ci', 'conflict'],
          maxAttempts: 3,
          createdAt: 100,
        })
        expect(created.lastCommentId).toBeUndefined()
        expect(storage.autoFix.watches.get('w1')).toEqual(created)
        expect(storage.autoFix.watches.get('missing')).toBeUndefined()
        expect(storage.autoFix.watches.findByPullRequest('o/r', 12)?.watchId).toBe('w1')
        expect(storage.autoFix.watches.findByPullRequest('o/r', 13)).toBeUndefined()

        clock = 200
        const updated = storage.autoFix.watches.update('w1', {
          enabled: false,
          triggers: ['ci'],
          maxAttempts: 5,
          attempts: 2,
          lastSignature: 'sha:test',
          lastCommentId: 42,
          lastEvaluatedAt: 150,
        })
        expect(updated).toMatchObject({
          enabled: false,
          triggers: ['ci'],
          maxAttempts: 5,
          attempts: 2,
          lastSignature: 'sha:test',
          lastCommentId: 42,
          lastEvaluatedAt: 150,
        })

        const cleared = storage.autoFix.watches.update('w1', { lastSignature: null })
        expect(cleared.lastSignature).toBeUndefined()
        expect(cleared.enabled).toBe(false)
        expect(storage.autoFix.watches.update('w1', { enabled: true }).triggers).toEqual(['ci'])
      })

      it('rejects duplicate watches and missing records', () => {
        storage.autoFix.watches.create(watch('w1'))
        expectStorageError(
          () => storage.autoFix.watches.create(watch('w1', { prNumber: 13 })),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.autoFix.watches.create(watch('w2')),
          StorageErrorCode.Conflict,
        )
        expectStorageError(
          () => storage.autoFix.watches.update('missing', { enabled: false }),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.autoFix.watches.remove('missing'),
          StorageErrorCode.NotFound,
        )
      })

      it('stores jobs, filters active ones and lists newest first', () => {
        storage.autoFix.watches.create(watch('w1'))
        storage.autoFix.watches.create(watch('w2', { prNumber: 13 }))
        clock = 300
        const queued = storage.autoFix.jobs.create(job('j1', { sessionId: 's1' }))
        expect(queued).toMatchObject({
          sessionId: 's1',
          status: 'queued',
          createdAt: 300,
          updatedAt: 300,
        })
        expect(storage.autoFix.jobs.get('j1')).toEqual(queued)
        expect(storage.autoFix.jobs.get('missing')).toBeUndefined()
        expect(storage.autoFix.jobs.activeForWatch('w1')?.jobId).toBe('j1')
        expect(storage.autoFix.jobs.activeForWatch('w2')).toBeUndefined()
        expect(storage.autoFix.jobs.getBySession('s1')?.jobId).toBe('j1')
        expect(storage.autoFix.jobs.getBySession('missing')).toBeUndefined()

        clock = 400
        expect(
          storage.autoFix.jobs.update('j1', { status: 'running', detail: 'started' }),
        ).toMatchObject({ status: 'running', detail: 'started', updatedAt: 400 })
        clock = 500
        storage.autoFix.jobs.create(job('j2', { watchId: 'w2' }))
        expect(storage.autoFix.jobs.list().map((item) => item.jobId)).toEqual(['j2', 'j1'])
        expect(storage.autoFix.jobs.list({ watchId: 'w2' }).map((item) => item.jobId)).toEqual([
          'j2',
        ])
        expect(storage.autoFix.jobs.list({ limit: 1 }).map((item) => item.jobId)).toEqual(['j2'])

        expect(storage.autoFix.jobs.update('j1', { status: 'failed', detail: null }).detail).toBe(
          undefined,
        )
        expect(storage.autoFix.jobs.activeForWatch('w1')).toBeUndefined()
        expect(storage.autoFix.jobs.activeForWatch('w2')?.jobId).toBe('j2')
      })

      it('marks queued and running jobs as interrupted', () => {
        storage.autoFix.watches.create(watch('w1'))
        storage.autoFix.jobs.create(job('j1'))
        storage.autoFix.jobs.create(job('j2', { status: 'ready' }))
        expect(storage.autoFix.jobs.interruptActive()).toBe(1)
        expect(storage.autoFix.jobs.get('j1')).toMatchObject({
          status: 'failed',
          detail: 'interrupted',
        })
        expect(storage.autoFix.jobs.get('j2')!.status).toBe('ready')
        expect(storage.autoFix.jobs.interruptActive()).toBe(0)
      })

      it('rejects jobs for unknown watches and duplicate ids', () => {
        storage.autoFix.watches.create(watch('w1'))
        storage.autoFix.jobs.create(job('j1'))
        expectStorageError(() => storage.autoFix.jobs.create(job('j1')), StorageErrorCode.Conflict)
        expectStorageError(
          () => storage.autoFix.jobs.create(job('j2', { watchId: 'missing' })),
          StorageErrorCode.NotFound,
        )
        expectStorageError(
          () => storage.autoFix.jobs.update('missing', { status: 'failed' }),
          StorageErrorCode.NotFound,
        )
      })

      it('removes a watch together with its jobs', () => {
        storage.autoFix.watches.create(watch('w1'))
        storage.autoFix.watches.create(watch('w2', { prNumber: 13 }))
        storage.autoFix.jobs.create(job('j1'))
        storage.autoFix.jobs.create(job('j2', { watchId: 'w2' }))
        storage.autoFix.watches.remove('w1')
        expect(storage.autoFix.watches.list().map((item) => item.watchId)).toEqual(['w2'])
        expect(storage.autoFix.jobs.list().map((item) => item.jobId)).toEqual(['j2'])
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

      it('keeps agent and team versions and change-set files when a transaction fails', () => {
        seed()
        storage.agents.create({ agentId: 'a1', source: 'user' })
        storage.agents.addVersion({
          agentId: 'a1',
          version: 1,
          definition: { id: 'a1', name: { 'zh-CN': 'A' }, instructions: 'x' },
        })
        storage.teams.create({ teamId: 't1' })
        storage.teams.addVersion({
          teamId: 't1',
          version: 1,
          definition: {
            id: 't1',
            name: { 'zh-CN': 'T' },
            coordinator: 'builtin.coder',
            members: [],
            pattern: 'delegate',
          },
        })
        storage.changeSets.create({
          changeSetId: 'cs-1',
          sessionId: 's1',
          runId: 'r1',
          baseCommit: 'base',
          gitDir: '/repo/.git',
          workspacePath: '/work/isolated',
        })
        storage.changeSets.addFile({
          changeSetId: 'cs-1',
          path: 'a.ts',
          kind: 'added',
          added: 1,
          removed: 0,
          binary: false,
          large: false,
        })
        expect(() =>
          storage.transaction(() => {
            throw new Error('boom')
          }),
        ).toThrow('boom')
        expect(storage.agents.versions('a1')).toHaveLength(1)
        expect(storage.teams.versions('t1')).toHaveLength(1)
        expect(storage.changeSets.listFiles('cs-1')).toHaveLength(1)
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
