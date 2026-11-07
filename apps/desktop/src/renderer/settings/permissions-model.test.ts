import { presetRules } from '@cairn/core'
import { describe, expect, it } from 'vitest'
import {
  newRuleDraft,
  presetRows,
  ruleDraftProblem,
  ruleFromDraft,
  ruleRows,
  ruleText,
  targetOf,
} from './permissions-model.js'

describe('permissions model', () => {
  it('matches the presets of the permission engine', () => {
    for (const mode of ['read-only', 'ask', 'auto'] as const) {
      expect(presetRows(mode)).toEqual(presetRules(mode))
    }
  })

  it('splits a rule into tools, categories and patterns', () => {
    expect(
      ruleText({
        id: 'r',
        scope: 'global',
        effect: 'allow',
        match: { tool: ['read_file', 'search'], path: ['src/**'], command: ['npm test'] },
        source: 'user',
      }),
    ).toEqual({ tools: ['read_file', 'search'], categories: [], patterns: ['src/**', 'npm test'] })
    expect(ruleText(presetRules('auto')[0]!)).toEqual({
      tools: [],
      categories: ['write'],
      patterns: [],
    })
  })

  it('lists presets first; only saved rules can be removed', () => {
    const preset = presetRules('auto')[0]!
    const saved = { ...preset, id: 'u', source: 'user' as const }
    expect(ruleRows([preset], [{ rule: saved, projectId: 'p', createdAt: 1 }])).toEqual([
      { rule: preset, removable: false },
      { rule: saved, projectId: 'p', removable: true },
    ])
    expect(ruleRows([], [{ rule: saved, createdAt: 1 }])[0]).not.toHaveProperty('projectId')
  })

  it('builds rules from the form', () => {
    expect(targetOf('run_command')).toBe('command')
    expect(targetOf('edit_file')).toBe('path')
    expect(targetOf('*')).toBe('path')

    const draft = newRuleDraft()
    expect(ruleFromDraft({ ...draft, pattern: ' git status* ' }, 'id')).toEqual({
      rule: {
        id: 'id',
        scope: 'global',
        effect: 'allow',
        match: { tool: 'run_command', command: ['git status*'] },
        source: 'user',
      },
    })
    expect(ruleFromDraft({ ...draft, tool: 'write_file', scope: 'p1' }, 'id')).toEqual({
      rule: expect.objectContaining({ scope: 'project', match: { tool: 'write_file' } }),
      projectId: 'p1',
    })

    const any = { ...draft, tool: '*' as const, effect: 'deny' as const }
    expect(ruleDraftProblem(any)).toBe('empty')
    expect(ruleFromDraft(any, 'id')).toBeUndefined()
    expect(ruleFromDraft({ ...any, pattern: '**/.env*' }, 'id')?.rule.match).toEqual({
      path: ['**/.env*'],
    })
  })
})
