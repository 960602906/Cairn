import { describe, expect, it } from 'vitest'
import { PermissionMode, PermissionRule } from './permissions.js'

const base = { id: 'r1', scope: 'project', effect: 'allow', source: 'user' } as const

describe('PermissionRule', () => {
  it('接受各种匹配条件；空条件匹配所有调用', () => {
    for (const match of [
      {},
      { tool: 'run_command' },
      { tool: ['read_file', 'write_file'] },
      { category: ['write', 'execute'] },
      { path: ['src/**'], command: ['npm test'] },
    ]) {
      expect(PermissionRule.parse({ ...base, match })).toEqual({ ...base, match })
    }
  })

  it('拒绝无效的规则', () => {
    for (const rule of [
      { ...base, match: { tool: '' } },
      { ...base, match: { tool: [] } },
      { ...base, match: { category: ['admin'] } },
      { ...base, match: { path: [] } },
      { ...base, match: { command: [''] } },
      { ...base, match: { unknown: 1 } },
      { ...base, scope: 'user', match: {} },
      { ...base, effect: 'maybe', match: {} },
      { ...base, source: 'model', match: {} },
      { ...base, id: '', match: {} },
    ]) {
      expect(PermissionRule.safeParse(rule).success).toBe(false)
    }
  })

  it('PermissionMode', () => {
    expect(PermissionMode.options).toEqual(['read-only', 'ask', 'auto'])
  })
})
