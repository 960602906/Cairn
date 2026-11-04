import { describe, expect, it } from 'vitest'
import { createToolRegistry, ToolError, type ToolDefinition } from './tools.js'

const readFile: ToolDefinition<{ path: string; startLine?: number }> = {
  name: 'read_file',
  description: 'Read a file in the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      startLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  category: 'read',
  source: { kind: 'builtin' },
  trust: 'builtin',
  execute: async ({ path }) => ({ content: [{ type: 'text', text: path }] }),
}

const tool = (over: Partial<ToolDefinition>): ToolDefinition => ({
  ...(readFile as ToolDefinition),
  ...over,
})

describe('ToolRegistry', () => {
  it('registers tools and lists them in order', () => {
    const registry = createToolRegistry()
    registry.register(readFile)
    registry.register(tool({ name: 'write_file', category: 'write' }))
    expect(registry.list().map((t) => t.name)).toEqual(['read_file', 'write_file'])
    expect(registry.get('read_file')).toBe(readFile)
    expect(registry.get('missing')).toBeUndefined()
  })

  it('gives specs for the model, optionally filtered', () => {
    const registry = createToolRegistry()
    registry.register(readFile)
    registry.register(tool({ name: 'run_command', category: 'execute' }))
    expect(registry.specs()).toEqual([
      { name: 'read_file', description: readFile.description, inputSchema: readFile.inputSchema },
      { name: 'run_command', description: readFile.description, inputSchema: readFile.inputSchema },
    ])
    expect(registry.specs((d) => d.category === 'read').map((s) => s.name)).toEqual(['read_file'])
  })

  it('rejects bad names, duplicates and unsupported schemas', () => {
    const registry = createToolRegistry()
    registry.register(readFile)
    expect(() => registry.register(readFile)).toThrow('duplicate tool: read_file')
    for (const name of ['', '1abc', 'github.create_issue', 'a b', 'x'.repeat(65)]) {
      expect(() => registry.register(tool({ name })), name).toThrow('invalid tool name')
    }
    expect(() => registry.register(tool({ name: 'a', inputSchema: { type: 'string' } }))).toThrow(
      'must be an object schema',
    )
    expect(() =>
      registry.register(
        tool({ name: 'b', inputSchema: { type: 'object', properties: { x: { type: 'wat' } } } }),
      ),
    ).toThrow('unsupported inputSchema')
    expect(registry.list()).toHaveLength(1)
  })

  it('validates input against the JSON Schema with issues for the model', () => {
    const registry = createToolRegistry()
    registry.register(readFile)
    expect(registry.validate('read_file', { path: 'a.ts', startLine: 3 })).toEqual({
      ok: true,
      value: { path: 'a.ts', startLine: 3 },
    })
    expect(registry.validate('read_file', {})).toEqual({
      ok: false,
      issues: ['path: Invalid input: expected string, received undefined'],
    })
    const extra = registry.validate('read_file', { path: 'a', startLine: 0.5, other: 1 })
    expect(extra.ok).toBe(false)
    expect(!extra.ok && extra.issues).toHaveLength(2)
    expect(registry.validate('read_file', 'a.ts')).toMatchObject({ ok: false })
    expect(registry.validate('missing', {})).toEqual({
      ok: false,
      issues: ['Unknown tool: missing'],
    })
  })

  it('caps the number of issues', () => {
    const registry = createToolRegistry()
    const properties = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`p${i}`, { type: 'string' }]),
    )
    registry.register(
      tool({
        name: 'many',
        inputSchema: { type: 'object', properties, required: Object.keys(properties) },
      }),
    )
    const result = registry.validate('many', {})
    expect(!result.ok && result.issues).toHaveLength(11)
    expect(!result.ok && result.issues.at(-1)).toBe('(2 more issues omitted)')
  })
})

describe('ToolError', () => {
  it('carries a code, a message for the model and params', () => {
    const error = new ToolError('tool.execution_failed', 'File not found: a.ts', { path: 'a.ts' })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'ToolError',
      code: 'tool.execution_failed',
      message: 'File not found: a.ts',
      params: { path: 'a.ts' },
    })
    expect(new ToolError('x', 'y').params).toEqual({})
  })
})
