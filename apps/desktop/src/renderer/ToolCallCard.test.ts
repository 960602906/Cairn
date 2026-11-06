import { describe, expect, it } from 'vitest'
import { INPUT_SUMMARY_CHARS, previewLines, summarizeInput } from './ToolCallCard.js'

describe('summarizeInput', () => {
  it('prefers the command, path or search fields', () => {
    expect(summarizeInput({ path: 'src/a.ts', content: 'x' })).toBe('src/a.ts')
    expect(summarizeInput({ pattern: 'TODO', path: 'src' })).toBe('src')
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
