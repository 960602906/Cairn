import { presetRules } from '@cairn/core'
import type { PermissionRule } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { describe, expect, it } from 'vitest'
import { createPermissionService } from './permission-service.js'

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

function setup(mode: () => 'read-only' | 'ask' | 'auto' = () => 'ask') {
  const storage = createMemoryStorage()
  for (const [projectId, sessionId] of [
    ['p1', 's1'],
    ['p2', 's2'],
  ] as const) {
    storage.projects.create({ projectId, name: projectId, path: `/work/${projectId}` })
    storage.sessions.create({
      sessionId,
      projectId,
      workspacePath: `/work/${projectId}`,
      title: sessionId,
    })
  }
  return { storage, service: createPermissionService({ storage, mode }) }
}

describe('createPermissionService', () => {
  it('returns the mode presets, then global, project and session rules of the session', () => {
    let mode: 'read-only' | 'ask' | 'auto' = 'ask'
    const { service } = setup(() => mode)
    expect(service.rulesForSession('s1')).toEqual(presetRules('ask'))

    service.addRule('s1', rule('session', 'session'))
    service.addRule('s1', rule('project', 'project'))
    service.addRule('s2', rule('global', 'global', { effect: 'deny', source: 'user' }))
    service.addRule('s2', rule('other', 'session'))

    mode = 'auto'
    expect(service.rulesForSession('s1')).toEqual([
      ...presetRules('auto'),
      rule('global', 'global', { effect: 'deny', source: 'user' }),
      rule('project', 'project'),
      rule('session', 'session'),
    ])
    expect(service.rulesForSession('s2').map((r) => r.id)).toEqual([
      ...presetRules('auto').map((r) => r.id),
      'global',
      'other',
    ])
  })

  it('stores project rules under the project of the session', () => {
    const { storage, service } = setup()
    expect(service.addRule('s1', rule('r', 'project'))).toEqual(rule('r', 'project'))
    expect(storage.permissionRules.get('r')).toMatchObject({ projectId: 'p1' })
    expect(storage.permissionRules.get('r')).not.toHaveProperty('sessionId')
  })

  it('rejects invalid rules, presets and unknown sessions', () => {
    const { service } = setup()
    expect(() => service.addRule('s1', rule('r', 'global', { source: 'preset' }))).toThrow(
      expect.objectContaining({ code: 'rpc.invalid_params' }),
    )
    expect(() =>
      service.addRule('s1', { ...rule('r', 'global'), match: { path: [] } } as PermissionRule),
    ).toThrow(expect.objectContaining({ code: 'rpc.invalid_params' }))
    expect(() => service.addRule('nope', rule('r', 'session'))).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
    expect(() => service.rulesForSession('nope')).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('lists global rules, then the rules of each project, without session rules (M2-11)', () => {
    const { storage, service } = setup()
    service.addRule('s1', rule('p1-rule', 'project'))
    service.addRule('s2', rule('p2-rule', 'project'))
    service.addRule('s1', rule('session', 'session'))
    service.addUserRule(rule('global', 'global', { source: 'user' }))
    const listed = service.listRules()
    expect(listed[0]?.rule.id).toBe('global')
    expect(listed.slice(1).map((e) => [e.rule.id, e.projectId])).toEqual(
      storage.projects.list().map(({ projectId }) => [`${projectId}-rule`, projectId]),
    )
    expect(listed[0]).not.toHaveProperty('projectId')
    expect(listed[0]?.createdAt).toEqual(expect.any(Number))
  })

  it('adds user rules to the global scope or a project and deletes stored rules (M2-11)', () => {
    const { storage, service } = setup()
    const entry = service.addUserRule(rule('u', 'project', { source: 'user' }), 'p2')
    expect(entry).toMatchObject({ rule: rule('u', 'project', { source: 'user' }), projectId: 'p2' })
    expect(storage.permissionRules.get('u')).toMatchObject({ projectId: 'p2' })
    expect(service.rulesForSession('s2').map((r) => r.id)).toContain('u')

    service.addRule('s1', rule('approved', 'project'))
    service.deleteRule('approved')
    service.deleteRule('u')
    expect(service.listRules()).toEqual([])
    expect(() => service.deleteRule('u')).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
  })

  it('rejects manual rules that are not user rules or have the wrong owner (M2-11)', () => {
    const { service } = setup()
    const invalid = expect.objectContaining({ code: 'rpc.invalid_params' })
    expect(() => service.addUserRule(rule('a', 'global'))).toThrow(invalid)
    expect(() => service.addUserRule(rule('b', 'global', { source: 'user' }), 'p1')).toThrow(
      invalid,
    )
    expect(() => service.addUserRule(rule('c', 'project', { source: 'user' }))).toThrow(invalid)
    expect(() => service.addUserRule(rule('d', 'session', { source: 'user' }), 'p1')).toThrow(
      invalid,
    )
    expect(() =>
      service.addUserRule({ ...rule('e', 'global', { source: 'user' }), match: { path: [] } }),
    ).toThrow(invalid)
    expect(() => service.addUserRule(rule('f', 'project', { source: 'user' }), 'nope')).toThrow(
      expect.objectContaining({ code: 'storage.not_found' }),
    )
    service.addUserRule(rule('g', 'global', { source: 'user' }))
    expect(() => service.addUserRule(rule('g', 'global', { source: 'user' }))).toThrow(
      expect.objectContaining({ code: 'storage.conflict' }),
    )
  })
})
