import type { ApprovalRequest, ToolDefinition } from '@cairn/core'
import { describe, expect, it, vi } from 'vitest'
import { createHostApprovalGate } from './approval-gate.js'

const definition = {
  name: 'write_file',
  category: 'write',
} as unknown as ToolDefinition

function request(signal: AbortSignal, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'a1',
    toolCallId: 'c1',
    definition,
    input: { path: 'a.ts' },
    targets: { paths: ['a.ts'] },
    kind: 'tool',
    preview: { summary: 'write a.ts', diff: '+x' },
    reasonCode: 'permission.rule_requires_approval',
    matchedRuleIds: ['r1'],
    signal,
    ...extra,
  }
}

describe('createHostApprovalGate', () => {
  const attribution = {
    runId: 'r1',
    parentRunId: 'p1',
    agent: { id: 'builtin.coder', version: 1 },
  }

  it('sends the request without a timeout and returns the decision', async () => {
    const endpoint = {
      request: vi.fn(async () => ({ decision: 'deny' as const, feedback: 'no' })),
      emit: vi.fn(),
    }
    const onRule = vi.fn()
    const gate = createHostApprovalGate({
      endpoint: endpoint as never,
      onRule,
      attribution: () => attribution,
    })
    await expect(gate.request(request(new AbortController().signal))).resolves.toEqual({
      decision: 'deny',
      feedback: 'no',
    })
    expect(endpoint.request).toHaveBeenCalledWith(
      'host.approval.request',
      {
        approvalId: 'a1',
        toolCallId: 'c1',
        runId: 'r1',
        parentRunId: 'p1',
        agent: { id: 'builtin.coder', version: 1 },
        tool: { name: 'write_file', category: 'write' },
        input: { path: 'a.ts' },
        targets: { paths: ['a.ts'] },
        kind: 'tool',
        preview: { summary: 'write a.ts', diff: '+x' },
        reasonCode: 'permission.rule_requires_approval',
        matchedRuleIds: ['r1'],
      },
      { timeoutMs: 0 },
    )
    expect(onRule).not.toHaveBeenCalled()
    expect(endpoint.emit).not.toHaveBeenCalled()
  })

  it('passes the generated rule on and emits a cancel when the signal aborts', async () => {
    const rule = {
      id: 'rule1',
      scope: 'project' as const,
      effect: 'allow' as const,
      match: { tool: 'write_file', path: ['a.ts'] },
      source: 'approval' as const,
    }
    let answer!: (value: unknown) => void
    const endpoint = {
      request: vi.fn(() => new Promise((resolve) => (answer = resolve))),
      emit: vi.fn(),
    }
    const onRule = vi.fn()
    const gate = createHostApprovalGate({
      endpoint: endpoint as never,
      onRule,
      attribution: () => attribution,
    })
    const controller = new AbortController()
    const pending = gate.request(
      request(controller.signal, { kind: 'no_checkpoint', targets: { command: 'x' } }),
    )
    controller.abort()
    expect(endpoint.emit).toHaveBeenCalledWith('host.approval.cancelled', { approvalId: 'a1' })
    answer({ decision: 'allow_project', rule })
    await expect(pending).resolves.toEqual({ decision: 'allow_project' })
    expect(onRule).toHaveBeenCalledWith(rule)
    expect((endpoint.request.mock.calls[0] as unknown[])[1]).toMatchObject({
      kind: 'no_checkpoint',
      targets: { command: 'x' },
    })
  })
})
