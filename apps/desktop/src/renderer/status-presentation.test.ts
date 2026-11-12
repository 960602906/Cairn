import { describe, expect, it } from 'vitest'
import type { SessionView } from '@cairn/core'
import type { RunState } from '@cairn/protocol'
import {
  outcomePresentation,
  runningActivityKey,
  statusPresentation,
  TONE_DOT,
  TONE_SOFT,
  TONE_TEXT,
} from './status-presentation.js'

/** 只有一个根运行的会话视图；turn 由参数决定。 */
function viewWith(turn: Partial<SessionView['runs'][string]['turn']>, crash = false): SessionView {
  return {
    sessionId: 's1',
    lastSeq: 1,
    info: undefined,
    archived: false,
    crash: crash ? { code: 'host.exited' } : undefined,
    runs: {
      r1: {
        runId: 'r1',
        parentRunId: undefined,
        agent: { id: 'builtin.coder', version: 1 },
        state: 'failed',
        turn: {
          turnId: 't1',
          status: 'failed',
          startedAt: 1,
          endedAt: 2,
          stepCount: 1,
          step: undefined,
          durationMs: 1,
          abortReason: undefined,
          error: { code: 'run.failed' },
          retryable: false,
          limitReached: undefined,
          retry: undefined,
          ...turn,
        },
      },
    },
    runOrder: ['r1'],
    messages: [],
    live: {},
    tools: {},
    liveToolOutput: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    usageByTurn: {},
    contextTokens: undefined,
    checkpoints: [],
    restores: [],
    plans: [],
    delegations: [],
    compaction: undefined,
    toolOutputOmitted: undefined,
  } as unknown as SessionView
}

describe('statusPresentation', () => {
  it('maps every session status to a tone and a shape', () => {
    expect(statusPresentation('idle').tone).toBe('neutral')
    expect(statusPresentation('running').tone).toBe('accent')
    expect(statusPresentation('waiting_approval').tone).toBe('warn')
    expect(statusPresentation('failed').tone).toBe('danger')
    expect(statusPresentation('interrupted').tone).toBe('warn')
    expect(statusPresentation('crashed').tone).toBe('danger')
    expect(statusPresentation('archived').tone).toBe('neutral')
  })

  it('gives each status its own icon', () => {
    const icons = [
      statusPresentation('idle').Icon,
      statusPresentation('running').Icon,
      statusPresentation('waiting_approval').Icon,
      statusPresentation('failed').Icon,
      statusPresentation('interrupted').Icon,
      statusPresentation('crashed').Icon,
      statusPresentation('archived').Icon,
    ]
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('outcomePresentation', () => {
  it('grades a crash as danger', () => {
    expect(outcomePresentation(viewWith({}, true)).tone).toBe('danger')
  })

  it('grades an aborted turn as neutral', () => {
    const view = viewWith({ status: 'aborted' })
    expect(outcomePresentation(view).tone).toBe('neutral')
  })

  it('grades a retrying turn as a warning', () => {
    const view = viewWith({
      status: 'running',
      retry: { attempt: 1, delayMs: 1000, error: { code: 'model.http' }, at: 1, maxRetries: 3 },
    })
    expect(outcomePresentation(view).tone).toBe('warn')
  })

  it('grades a limit as a warning and a plain failure as danger', () => {
    expect(
      outcomePresentation(viewWith({ limitReached: { limit: 'maxStepsPerTurn', value: 10 } })).tone,
    ).toBe('warn')
    expect(outcomePresentation(viewWith({})).tone).toBe('danger')
  })

  it('falls back to neutral when the turn is not failed', () => {
    const view = viewWith({ status: 'completed' })
    expect(outcomePresentation(view).tone).toBe('neutral')
  })
})

describe('tone classes', () => {
  it('provides a text, dot and soft background class for every tone', () => {
    expect(Object.keys(TONE_TEXT)).toEqual(['neutral', 'accent', 'warn', 'danger'])
    expect(Object.keys(TONE_DOT)).toEqual(['neutral', 'accent', 'warn', 'danger'])
    expect(Object.keys(TONE_SOFT)).toEqual(['neutral', 'warn', 'danger'])
  })
})

describe('runningActivityKey', () => {
  /** 一个根运行的会话视图：运行态、进行中的流式内容与工具按参数决定。 */
  const viewFor = (
    state: RunState,
    extra: { live?: boolean; tool?: 'requested' | 'running' } = {},
  ): SessionView => {
    const base = viewWith({ status: 'running' })
    return {
      ...base,
      runs: { r1: { ...base.runs.r1!, state } },
      live: extra.live
        ? {
            m1: {
              messageId: 'm1',
              runId: 'r1',
              turnId: 't1',
              text: '你好',
              reasoning: '',
              lastDeltaSeq: 1,
              startedAt: 1,
            },
          }
        : {},
      tools: extra.tool
        ? {
            tc1: {
              toolCallId: 'tc1',
              runId: 'r1',
              turnId: 't1',
              name: 'read_file',
              input: { path: 'a.ts' },
              status: extra.tool,
              requestedAt: 1,
              output: undefined,
              display: undefined,
              sandbox: undefined,
              truncated: false,
              error: undefined,
              cancelReason: undefined,
              durationMs: undefined,
            },
          }
        : {},
    } as unknown as SessionView
  }

  it('describes the stage the run is in', () => {
    expect(runningActivityKey(viewFor('thinking'), false)).toBe('run.thinking')
    expect(runningActivityKey(viewFor('tooling'), false)).toBe('run.tooling')
    expect(runningActivityKey(viewFor('aborting'), false)).toBe('run.aborting')
    expect(runningActivityKey(viewFor('awaiting_approval'), false)).toBe('status.waiting_approval')
    expect(runningActivityKey(viewFor('awaiting_children'), false)).toBe('status.running')
  })

  it('says running while the turn has not started yet', () => {
    expect(runningActivityKey(viewFor('idle'), true)).toBe('status.running')
  })

  it('says nothing when the session is not running', () => {
    expect(runningActivityKey(viewFor('idle'), false)).toBeUndefined()
    expect(runningActivityKey(viewFor('completed'), false)).toBeUndefined()
  })

  it('says nothing once there is something to look at', () => {
    expect(runningActivityKey(viewFor('thinking', { live: true }), false)).toBeUndefined()
    expect(runningActivityKey(viewFor('tooling', { tool: 'running' }), false)).toBeUndefined()
    expect(runningActivityKey(viewFor('tooling', { tool: 'requested' }), false)).toBeUndefined()
  })
})
