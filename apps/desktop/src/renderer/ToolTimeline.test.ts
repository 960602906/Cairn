import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  INPUT_SUMMARY_CHARS,
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
