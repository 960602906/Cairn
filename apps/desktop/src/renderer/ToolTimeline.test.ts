import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@cairn/core'
import type { TFunction } from '@cairn/i18n'
import type { ToolCall } from '@cairn/protocol'
import {
  describeToolCall,
  formatAskUserAnswers,
  formatDuration,
  INPUT_SUMMARY_CHARS,
  isAskUserCancelled,
  previewLines,
  summarizeActivity,
  summarizeInput,
} from './ToolTimeline.js'

const t = ((key: string) => key) as unknown as TFunction

describe('summarizeInput', () => {
  it('prefers the command, path or search fields', () => {
    expect(summarizeInput({ path: 'src/a.ts', content: 'x' })).toBe('src/a.ts')
    expect(summarizeInput({ pattern: 'TODO', path: 'src' })).toBe('TODO')
    expect(summarizeInput({ command: 'npm\n  test', path: '.' })).toBe('npm test')
  })

  it('falls back to single-line JSON and truncates long values', () => {
    expect(summarizeInput({ a: 1 })).toBe('{"a":1}')
    expect(summarizeInput(['x'])).toBe('["x"]')
    expect(summarizeInput(undefined)).toBe('undefined')
    const long = summarizeInput({ command: 'x'.repeat(500) })
    expect(long).toHaveLength(INPUT_SUMMARY_CHARS)
    expect(long.endsWith('…')).toBe(true)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(summarizeInput(cyclic)).toBe('[object Object]')
  })
})

describe('previewLines', () => {
  it('keeps short output and drops trailing newlines', () => {
    expect(previewLines('a\nb\n\n', 'start')).toEqual({ lines: 'a\nb', omitted: 0 })
  })

  it('takes the first or last lines', () => {
    const text = 'a\nb\nc\nd'
    expect(previewLines(text, 'start', 2)).toEqual({ lines: 'a\nb', omitted: 2 })
    expect(previewLines(text, 'end', 2)).toEqual({ lines: 'c\nd', omitted: 2 })
  })
})

describe('formatDuration', () => {
  it('uses milliseconds below one second, otherwise seconds', () => {
    expect(formatDuration(5)).toBe('5ms')
    expect(formatDuration(999.4)).toBe('999ms')
    expect(formatDuration(1234)).toBe('1.2s')
  })
})

describe('describeToolCall', () => {
  it('summarises remember with the note content, not raw JSON', () => {
    const description = describeToolCall(
      'remember',
      { scope: 'session', content: '用户指定的测试用令牌：CEDAR-NOVEMBER-42' },
      t,
    )
    expect(description).toEqual({
      action: 'tool.action.remember',
      object: '用户指定的测试用令牌：CEDAR-NOVEMBER-42',
      plain: true,
    })
  })

  it('falls back when remember has no usable content', () => {
    expect(describeToolCall('remember', { scope: 'session', content: '' }, t).object).toBe(
      '{"scope":"session","content":""}',
    )
    expect(describeToolCall('remember', { scope: 'project' }, t).object).toBe('{"scope":"project"}')
    expect(describeToolCall('remember', null, t).object).toBe('null')
  })
})

describe('summarizeActivity', () => {
  it('returns undefined without tools; otherwise action + object', () => {
    expect(summarizeActivity([], {}, t)).toBeUndefined()
    const calls = [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }] as ToolCall[]
    const tools = {
      c1: { toolCallId: 'c1', status: 'completed', input: { path: 'a.ts' } },
    } as unknown as Record<string, ToolCallView>
    expect(summarizeActivity(calls, tools, t)).toBe('tool.action.read_file a.ts')
  })

  it('uses only the object when the action is empty (load_skill)', () => {
    const calls = [{ id: 'c1', name: 'load_skill', input: { name: 'git' } }] as ToolCall[]
    const tools = {
      c1: { toolCallId: 'c1', status: 'completed', input: { name: 'git' } },
    } as unknown as Record<string, ToolCallView>
    expect(summarizeActivity(calls, tools, t)).toBe('git')
  })
})

describe('ask_user output', () => {
  it('formats the answers as question → answer', () => {
    const output = JSON.stringify({
      answers: [
        { question: '用哪种方案？', selected: ['A', 'B'] },
        { question: '还要什么？', selected: [], custom: '文档' },
      ],
    })
    expect(formatAskUserAnswers(output)).toBe(
      ['用哪种方案？ → A, B', '还要什么？ → 文档'].join('\n'),
    )
  })

  it('tolerates odd entries and invalid JSON', () => {
    expect(formatAskUserAnswers(JSON.stringify({ answers: [null, { question: 'Q' }] }))).toBe(
      'Q → —',
    )
    // selected / custom 不是预期类型时当作没填
    expect(formatAskUserAnswers(JSON.stringify({ answers: [{ question: 'Q2', custom: 7 }] }))).toBe(
      'Q2 → —',
    )
    expect(formatAskUserAnswers('not json')).toBeUndefined()
    expect(formatAskUserAnswers(JSON.stringify({ answers: 'x' }))).toBeUndefined()
  })

  it('recognises a dismissed question', () => {
    expect(isAskUserCancelled(JSON.stringify({ cancelled: true }))).toBe(true)
    expect(isAskUserCancelled(JSON.stringify({ answers: [] }))).toBe(false)
    expect(isAskUserCancelled('not json')).toBe(false)
  })
})
