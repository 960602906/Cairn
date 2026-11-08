import { describe, expect, it } from 'vitest'
import {
  RunAgentRef,
  TrialStarted,
  TrialSummary,
  isAgentDraftRef,
  payloadSchemaOf,
} from './index.js'

const model = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const draft = { id: 'user.reviewer', draftHash: 'sha256-abc' }
const published = { id: 'user.reviewer', version: 3 }

describe('AgentDraftRef（M4-12）', () => {
  it('accepts both published versions and draft hashes', () => {
    expect(RunAgentRef.parse(published)).toEqual(published)
    expect(RunAgentRef.parse(draft)).toEqual(draft)
    expect(RunAgentRef.safeParse({ id: 'user.reviewer' }).success).toBe(false)
    expect(RunAgentRef.safeParse({ id: 'user.reviewer', version: 0 }).success).toBe(false)
  })

  it('distinguishes draft references', () => {
    expect(isAgentDraftRef(draft)).toBe(true)
    expect(isAgentDraftRef(published)).toBe(false)
  })

  it('allows drafts in run.created but not in delegated child runs', () => {
    expect(
      payloadSchemaOf('run.created').safeParse({
        agent: draft,
        model,
        mode: 'interactive',
        limits,
      }).success,
    ).toBe(true)
    expect(
      payloadSchemaOf('run.delegated').safeParse({
        childRunId: 'c1',
        agent: draft,
        task: '检查',
      }).success,
    ).toBe(false)
    expect(
      payloadSchemaOf('run.delegated').safeParse({
        childRunId: 'c1',
        agent: published,
        task: '检查',
      }).success,
    ).toBe(true)
  })
})

describe('trial payloads', () => {
  it('parses a started trial and a summary', () => {
    const started = {
      sessionId: 't1',
      agent: draft,
      draftHash: draft.draftHash,
      useAgentPermissions: false,
    }
    expect(TrialStarted.parse(started)).toEqual(started)
    expect(
      TrialSummary.parse({
        sessionId: 't1',
        agent: draft,
        projectPath: '/work',
        title: '',
        createdAt: 1,
        updatedAt: 2,
      }),
    ).toMatchObject({ sessionId: 't1', projectPath: '/work' })
  })

  it('rejects incomplete trial payloads', () => {
    expect(TrialStarted.safeParse({ sessionId: 't1', agent: draft }).success).toBe(false)
    expect(
      TrialSummary.safeParse({
        sessionId: 't1',
        agent: draft,
        projectPath: '',
        createdAt: 1,
        updatedAt: 2,
      }).success,
    ).toBe(false)
  })
})
