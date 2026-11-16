import { describe, expect, it } from 'vitest'
import {
  formatAskUserAnswers,
  formatDuration,
  INPUT_SUMMARY_CHARS,
  isAskUserCancelled,
  previewLines,
  summarizeInput,
} from './ToolTimeline.js'

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
