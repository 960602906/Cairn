import { describe, expect, it } from 'vitest'
import { RUN_SNAPSHOT_MAX_CHARS } from '@cairn/core'
import type { EventEnvelope, PermissionRule, RunSnapshotInput } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSessionEventService } from './event-service.js'
import {
  InspectServiceErrorCode,
  createInspectService,
  redactWorkspacePath,
} from './inspect-service.js'

const agent = { id: 'builtin.coder', version: 1 }
const model = { providerId: 'fake', modelId: 'fake-1' }
const home = 'C:\\Users\\lan'
const projectPath = 'C:\\Users\\lan\\work\\demo'

const rule = (id: string, scope: PermissionRule['scope'], extra: object = {}): PermissionRule => ({
  id,
  scope,
  effect: 'allow',
  match: {},
  source: 'user',
  ...extra,
})

function snapshot(runId = 'r1'): RunSnapshotInput {
  return {
    runId,
    agent,
    model,
    tokens: 12,
    systemPrompt: [{ title: 'Base', text: 'You are Cairn.', tokens: 4 }],
    skills: [],
    tools: [],
    history: {
      messages: 1,
      tokens: 2,
      preview: [{ role: 'user', text: 'hello', tokens: 2, ts: 1 }],
    },
  }
}

function event(
  type: string,
  payload: unknown,
  extra: { runId?: string; turnId?: string; stepId?: string } = {},
): EventEnvelope {
  return {
    v: 1,
    sessionId: 's1',
    runId: extra.runId ?? 'r1',
    seq: 1,
    ts: 10,
    type,
    payload,
    ...extra,
  } as EventEnvelope
}

function setup() {
  const storage = createMemoryStorage({ now: () => 100 })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: projectPath })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: `${projectPath}\\src`,
    title: '',
  })
  const events = createSessionEventService({ storage })
  events.publish([
    event('run.created', {
      agent,
      model,
      mode: 'interactive',
      limits: { maxStepsPerTurn: 10 },
    }),
  ])
  let id = 0
  const inspect = createInspectService({
    storage,
    events,
    homeDir: home,
    now: () => 777,
    createId: () => `snap-${++id}`,
  })
  return { storage, events, inspect }
}

describe('redactWorkspacePath', () => {
  it('returns relative paths inside the project and redacts outside paths', () => {
    expect(redactWorkspacePath(`${projectPath}\\src\\a.ts`, projectPath, home)).toBe('src/a.ts')
    expect(redactWorkspacePath(projectPath, projectPath, home)).toBe('.')
    expect(redactWorkspacePath('C:\\Users\\lan\\other\\a.ts', projectPath, home)).toBe(
      '~\\other\\a.ts',
    )
    expect(redactWorkspacePath('/opt/work/a.ts', '/work', '/home/lan')).toBe('/opt/work/a.ts')
  })
})

describe('createInspectService', () => {
  it('redacts and truncates a recorded snapshot before storing it', () => {
    const { inspect, storage } = setup()
    const input = snapshot()
    input.systemPrompt = [
      {
        title: 'Base',
        text: `# Base\n${'x'.repeat(40_000)} ${home}\\secret sk-abcdefghijklmnop`,
        tokens: 1,
      },
    ]
    const recorded = inspect.record('s1', input)
    expect(recorded).toMatchObject({
      snapshotId: 'snap-1',
      sessionId: 's1',
      runId: 'r1',
      createdAt: 100,
    })
    expect(JSON.stringify(recorded)).not.toContain(home)
    expect(JSON.stringify(recorded)).not.toContain('sk-abcdefghijklmnop')
    expect(JSON.stringify(recorded).length).toBeLessThanOrEqual(RUN_SNAPSHOT_MAX_CHARS)
    expect(storage.runSnapshots.list('r1')).toHaveLength(1)
  })

  it('keeps optional turn and step references and supports default dependencies', () => {
    const { storage, events } = setup()
    const inspect = createInspectService({ storage, events })
    const recorded = inspect.record('s1', {
      ...snapshot(),
      parentRunId: 'parent',
      turnId: 't1',
      stepId: 'st1',
    })
    expect(recorded).toMatchObject({
      parentRunId: 'parent',
      turnId: 't1',
      stepId: 'st1',
    })
    expect(storage.runSnapshots.list('r1')[0]).toMatchObject({
      parentRunId: 'parent',
      turnId: 't1',
      stepId: 'st1',
    })
  })

  it('projects the tree, returns recent snapshots and session settings', () => {
    const { inspect, storage, events } = setup()
    events.publish([
      event('turn.started', {}, { turnId: 't1' }),
      event('turn.completed', { durationMs: 3 }, { turnId: 't1' }),
    ])
    storage.permissionRules.add({ rule: rule('global', 'global') })
    storage.permissionRules.add({ rule: rule('project', 'project'), projectId: 'p1' })
    storage.permissionRules.add({ rule: rule('session', 'session'), sessionId: 's1' })
    inspect.record('s1', snapshot())

    const result = inspect.inspect({ sessionId: 's1' })
    expect(result.tree).toMatchObject({
      sessionId: 's1',
      rootRunId: 'r1',
      generatedAt: 777,
    })
    expect(result.tree.runs[0]).toMatchObject({ runId: 'r1', state: 'idle' })
    expect(result.snapshots).toHaveLength(1)
    expect(result.snapshots[0]).toMatchObject({ snapshotId: 'snap-1', sessionId: 's1' })
    expect(result.settings).toEqual({
      projectPath: '.',
      workspacePath: 'src',
      permissionRules: [
        expect.objectContaining({ id: 'global' }),
        expect.objectContaining({ id: 'project' }),
        expect.objectContaining({ id: 'session' }),
      ],
    })
  })

  it('filters a requested run and reports missing sessions or runs', () => {
    const { inspect, storage } = setup()
    storage.projects.create({ projectId: 'p2', name: 'other', path: '/other' })
    storage.sessions.create({
      sessionId: 's2',
      projectId: 'p2',
      workspacePath: '/other',
      title: '',
    })
    expect(inspect.inspect({ sessionId: 's1', runId: 'r1' }).tree.rootRunId).toBe('r1')
    expect(() => inspect.inspect({ sessionId: 's1', runId: 'missing' })).toThrowError(
      expect.objectContaining({ code: InspectServiceErrorCode.NotFound }),
    )
    expect(() => inspect.inspect({ sessionId: 'missing' })).toThrowError(
      expect.objectContaining({ code: InspectServiceErrorCode.NotFound }),
    )
    expect(() => inspect.inspect({ sessionId: 's2' })).toThrowError(
      expect.objectContaining({ code: InspectServiceErrorCode.NotFound }),
    )
  })
})
