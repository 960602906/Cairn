/**
 * 存储契约测试。每个实现（内存、SQLite）都用自己的工厂调用一次，保证行为一致：
 *
 * ```ts
 * describeStorageContract('memory', (now) => createMemoryStorage({ now }))
 * ```
 *
 * 工厂每个用例调用一次，必须返回空的存储，并使用传入的时间来源。
 */
import type { PermissionRule, PersistedEvent } from '@cairn/protocol'
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
        expectStorageError(() => storage.projects.restore('missing'), StorageErrorCode.NotFound)
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
