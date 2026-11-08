import type { HostApprovalRequest, PermissionRule } from '@cairn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createApprovalService } from './approval-service.js'

const request = (approvalId: string, extra: Partial<HostApprovalRequest> = {}) => ({
  approvalId,
  toolCallId: `call-${approvalId}`,
  runId: 'r1',
  agent: { id: 'builtin.coder', version: 1 },
  tool: { name: 'run_command', category: 'execute' as const },
  input: { command: 'npm test && npm run lint' },
  targets: { command: 'npm test && npm run lint' },
  kind: 'tool' as const,
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
  ...extra,
})

function setup() {
  const added: [string, PermissionRule][] = []
  const addRule = vi.fn((sessionId: string, rule: PermissionRule) => {
    added.push([sessionId, rule])
    return rule
  })
  const onRuleAdded = vi.fn()
  let id = 0
  const service = createApprovalService({
    permissions: { addRule },
    onRuleAdded,
    createId: () => `rule${++id}`,
    now: () => 123,
  })
  return { service, addRule, added, onRuleAdded }
}

describe('createApprovalService', () => {
  it('lists pending approvals per session and resolves them', async () => {
    const { service, addRule } = setup()
    const a1 = service.request('s1', 'r1', request('a1'))
    const a2 = service.request('s1', 'r1', request('a2'))
    void service.request('s2', 'r2', request('b1'))
    expect(service.pending({ sessionId: 's1' }).approvals.map((a) => a.approvalId)).toEqual([
      'a1',
      'a2',
    ])
    expect(service.resolve({ sessionId: 's1', approvalId: 'a2', decision: 'allow_once' })).toEqual(
      {},
    )
    await expect(a2).resolves.toEqual({ decision: 'allow_once' })
    service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'deny', feedback: 'use b' })
    await expect(a1).resolves.toEqual({ decision: 'deny', feedback: 'use b' })
    expect(service.pending({ sessionId: 's1' }).approvals).toEqual([])
    expect(addRule).not.toHaveBeenCalled()
  })

  it('lists pending approvals across sessions with request time', () => {
    const { service } = setup()
    void service.request('s1', 'r1', request('a1'))
    void service.request('s2', 'r2', request('a2'))
    expect(service.list()).toEqual([
      {
        sessionId: 's1',
        requestedAt: 123,
        request: expect.objectContaining({ approvalId: 'a1' }),
      },
      {
        sessionId: 's2',
        requestedAt: 123,
        request: expect.objectContaining({ approvalId: 'a2' }),
      },
    ])
  })

  it('saves a rule for "always allow" and returns it to the host', async () => {
    const { service, added, onRuleAdded } = setup()
    const pending = service.request('s1', 'r1', request('a1'))
    service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_project', feedback: 'x' })
    const rule: PermissionRule = {
      id: 'rule1',
      scope: 'project',
      effect: 'allow',
      match: { tool: 'run_command', command: ['npm test', 'npm run lint'] },
      source: 'approval',
    }
    await expect(pending).resolves.toEqual({ decision: 'allow_project', rule })
    expect(added).toEqual([['s1', rule]])
    expect(onRuleAdded).toHaveBeenCalledWith('s1', rule)

    const write = service.request(
      's1',
      'r1',
      request('a2', {
        tool: { name: 'write_file', category: 'write' },
        targets: { paths: ['src/a.ts'] },
      }),
    )
    service.resolve({ sessionId: 's1', approvalId: 'a2', decision: 'allow_session' })
    await expect(write).resolves.toMatchObject({
      rule: { id: 'rule2', scope: 'session', match: { tool: 'write_file', path: ['src/a.ts'] } },
    })
  })

  it('keeps the approval pending when the rule cannot be saved', async () => {
    const { service, addRule } = setup()
    addRule.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const pending = service.request('s1', 'r1', request('a1'))
    expect(() =>
      service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_session' }),
    ).toThrow('disk full')
    expect(service.pending({ sessionId: 's1' }).approvals).toHaveLength(1)
    service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_once' })
    await expect(pending).resolves.toEqual({ decision: 'allow_once' })
  })

  it('cancels approvals and rejects unknown or foreign ones', async () => {
    const { service } = setup()
    const pending = service.request('s1', 'r1', request('a1'))
    expect(() =>
      service.resolve({ sessionId: 's2', approvalId: 'a1', decision: 'allow_once' }),
    ).toThrow(expect.objectContaining({ code: 'approval.not_found' }))
    service.cancel('s2', 'a1')
    expect(service.pending({ sessionId: 's1' }).approvals).toHaveLength(1)
    service.cancel('s1', 'a1')
    await expect(pending).rejects.toMatchObject({ code: 'approval.cancelled' })
    service.cancel('s1', 'a1')
    expect(() =>
      service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_once' }),
    ).toThrow(expect.objectContaining({ code: 'approval.not_found' }))
  })

  it('replaces a repeated approval id', async () => {
    const { service } = setup()
    const first = service.request('s1', 'r1', request('a1'))
    const second = service.request('s1', 'r1', request('a1'))
    await expect(first).rejects.toMatchObject({ code: 'approval.cancelled' })
    service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_once' })
    await expect(second).resolves.toEqual({ decision: 'allow_once' })
  })

  it('notifies subscribers when pending approvals change', async () => {
    const { service } = setup()
    const changed: string[] = []
    const off = service.subscribe((sessionId) => changed.push(sessionId))
    const a1 = service.request('s1', 'r1', request('a1'))
    const b1 = service.request('s2', 'r2', request('b1'))
    service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_once' })
    service.cancel('s2', 'b1')
    service.cancel('s2', 'missing')
    expect(() =>
      service.resolve({ sessionId: 's1', approvalId: 'a1', decision: 'allow_once' }),
    ).toThrow()
    expect(changed).toEqual(['s1', 's2', 's1', 's2'])
    await a1
    await expect(b1).rejects.toMatchObject({ code: 'approval.cancelled' })
    off()
    void service.request('s1', 'r1', request('a2'))
    expect(changed).toHaveLength(4)
  })
})
