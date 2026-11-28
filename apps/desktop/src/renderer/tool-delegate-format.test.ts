import { describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { describeToolCall, formatDelegateOutput } from './ToolTimeline.js'

const t = createI18n('en-US').getFixedT('en-US', 'session')

describe('formatDelegateOutput', () => {
  it('expands a delegate JSON result into readable text', () => {
    const text = formatDelegateOutput(
      JSON.stringify({
        status: 'completed',
        summary: 'Found src/math.ts\nIt exports add.',
        usage: { tokens: 1200, durationMs: 10, steps: 3 },
        childRunId: 'child-1',
      }),
    )
    expect(text).toContain('status: completed')
    expect(text).toContain('Found src/math.ts')
    expect(text).toContain('It exports add.')
    expect(text).toContain('tokens 1200')
    expect(text).toContain('childRunId: child-1')
    expect(text).not.toContain('\\n')
  })

  it('returns undefined for non-JSON output', () => {
    expect(formatDelegateOutput('not json')).toBeUndefined()
  })

  it('includes a question when the child needs input', () => {
    const text = formatDelegateOutput(
      JSON.stringify({
        status: 'needs_input',
        question: 'Which file should I open?',
      }),
    )
    expect(text).toContain('status: needs_input')
    expect(text).toContain('Which file should I open?')
  })

  it('returns undefined for an empty JSON object', () => {
    expect(formatDelegateOutput('{}')).toBeUndefined()
  })

  it('returns undefined for JSON null', () => {
    expect(formatDelegateOutput('null')).toBeUndefined()
  })

  it('formats usage with only steps', () => {
    const text = formatDelegateOutput(JSON.stringify({ usage: { steps: 4 } }))
    expect(text).toBe('steps 4')
  })

  it('skips empty summary and question strings', () => {
    const text = formatDelegateOutput(
      JSON.stringify({ status: 'running', summary: '', question: '', usage: { tokens: 9 } }),
    )
    expect(text).toBe('status: running\n\ntokens 9')
  })
})

describe('describeToolCall for delegate', () => {
  it('summarises agent and task instead of raw JSON', () => {
    const description = describeToolCall(
      'delegate',
      { agent: 'builtin.explorer', task: 'Explore the project tree' },
      t,
    )
    expect(description.action).toBe('Delegate')
    expect(description.object).toContain('builtin.explorer')
    expect(description.object).toContain('Explore the project tree')
    expect(description.plain).toBe(true)
  })

  it('falls back when agent or task is missing', () => {
    const description = describeToolCall('delegate', { agent: 'builtin.coder' }, t)
    expect(description.action).toBe('Delegate')
    expect(description.object).toContain('builtin.coder')
  })

  it('summarises raw args when agent and task are absent', () => {
    const description = describeToolCall('delegate', { note: 'handoff' }, t)
    expect(description.action).toBe('Delegate')
    expect(description.object).toContain('handoff')
    expect(description.plain).toBe(true)
  })
})
