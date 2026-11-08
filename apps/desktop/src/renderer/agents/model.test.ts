import { describe, expect, it } from 'vitest'
import type { AgentDefinition, AgentValidationResult } from '@cairn/protocol'
import {
  AGENT_SECTIONS,
  defaultDraft,
  defaultDelegationPolicy,
  draftFieldsOf,
  issuesAt,
  localized,
  sameFields,
  sectionChanged,
  sectionMarks,
  sectionOf,
} from './model.js'

describe('agents/model', () => {
  describe('sectionOf', () => {
    it('classifies field paths into corresponding sections', () => {
      expect(sectionOf('name')).toBe('basic')
      expect(sectionOf('name.zh-CN')).toBe('basic')
      expect(sectionOf('description')).toBe('basic')
      expect(sectionOf('icon')).toBe('basic')
      expect(sectionOf('color')).toBe('basic')
      expect(sectionOf('tags')).toBe('basic')
      expect(sectionOf('instructions')).toBe('instructions')
      expect(sectionOf('model.mode')).toBe('model')
      expect(sectionOf('tools.allow')).toBe('capabilities')
      expect(sectionOf('skills.allow.0')).toBe('capabilities')
      expect(sectionOf('permissions')).toBe('permissions')
      expect(sectionOf('pathPolicy.write')).toBe('permissions')
      expect(sectionOf('delegation.allowedAgents')).toBe('delegation')
      expect(sectionOf('limits.maxStepsPerTurn')).toBe('limits')
      expect(sectionOf('context.includeProjectInstructions')).toBe('context')
      expect(sectionOf('memory.scopes')).toBe('memory')
      expect(sectionOf('unknown_field')).toBe('basic')
    })
  })

  describe('sectionMarks', () => {
    it('returns zero marks when validation is undefined', () => {
      const marks = sectionMarks(undefined)
      for (const section of AGENT_SECTIONS) {
        expect(marks[section]).toEqual({ errors: 0, warnings: 0 })
      }
    })

    it('tallies errors and warnings by section', () => {
      const validation: AgentValidationResult = {
        ok: false,
        errors: [
          { path: 'name', code: 'required' },
          { path: 'tools.allow', code: 'invalid' },
          { path: 'skills.allow.0', code: 'not_found' },
        ],
        warnings: [
          { path: 'instructions', code: 'too_long' },
          { path: 'model.primary', code: 'expensive' },
        ],
      }
      const marks = sectionMarks(validation)
      expect(marks.basic).toEqual({ errors: 1, warnings: 0 })
      expect(marks.capabilities).toEqual({ errors: 2, warnings: 0 })
      expect(marks.instructions).toEqual({ errors: 0, warnings: 1 })
      expect(marks.model).toEqual({ errors: 0, warnings: 1 })
      expect(marks.permissions).toEqual({ errors: 0, warnings: 0 })
    })
  })

  describe('issuesAt', () => {
    it('filters issues by exact path and subpaths', () => {
      const validation: AgentValidationResult = {
        ok: false,
        errors: [
          { path: 'name', code: 'required' },
          { path: 'name.zh-CN', code: 'too_short' },
          { path: 'description', code: 'empty' },
        ],
        warnings: [{ path: 'name', code: 'warn' }],
      }
      expect(issuesAt(validation, 'name', 'errors')).toEqual([
        { path: 'name', code: 'required' },
        { path: 'name.zh-CN', code: 'too_short' },
      ])
      expect(issuesAt(validation, 'description', 'errors')).toEqual([
        { path: 'description', code: 'empty' },
      ])
      expect(issuesAt(undefined, 'name', 'errors')).toEqual([])
    })
  })

  describe('defaultDraft', () => {
    it('creates starter fields with inherit mode and default permissions', () => {
      const draft = defaultDraft()
      expect(draft.model.mode).toBe('inherit')
      expect(draft.permissions).toBe('ask')
      expect(draft.tools.allow).toEqual(['*'])
      expect(draft.skills.allow).toEqual(['*'])
      expect(draft.context.includeProjectInstructions).toBe(true)
      expect(draft.context.compaction).toBe('auto')
      expect(draft.delegation).toEqual(defaultDelegationPolicy())
      expect(draft.delegation?.enabled).toBe(false)
      expect(draft.delegation?.maxDepth).toBe(1)
      expect(draft.delegation?.maxChildrenPerTurn).toBe(6)
      expect(draft.delegation?.maxParallel).toBe(3)
      expect(draft.delegation?.childBudgetShare).toBe(0.5)
    })
  })

  describe('draftFieldsOf', () => {
    it('extracts draft fields from an AgentDefinition, stripping version & metadata', () => {
      const def: AgentDefinition = {
        id: 'agent.custom',
        version: 3,
        schemaVersion: 1,
        source: 'user',
        status: 'published',
        createdAt: 1000,
        updatedAt: 2000,
        name: { 'zh-CN': '测试', 'en-US': 'Test' },
        description: { 'zh-CN': '描述', 'en-US': 'Desc' },
        icon: 'bot',
        color: 'agent-blue',
        instructions: 'Do work',
        model: { mode: 'fixed', primary: { providerId: 'p1', modelId: 'm1' } },
        tools: { allow: ['read'] },
        skills: { allow: ['s1'] },
        permissions: 'auto',
        pathPolicy: { write: ['tests/**'] },
        delegation: {
          enabled: true,
          allowedAgents: ['builtin.reviewer'],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
        limits: { maxStepsPerTurn: 5 },
        context: { includeProjectInstructions: false, compaction: 'off' },
        memory: { scopes: ['session'], write: 'never' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tags: ['helper'],
      }
      const fields = draftFieldsOf(def)
      expect(fields).toEqual({
        name: { 'zh-CN': '测试', 'en-US': 'Test' },
        description: { 'zh-CN': '描述', 'en-US': 'Desc' },
        icon: 'bot',
        color: 'agent-blue',
        instructions: 'Do work',
        model: { mode: 'fixed', primary: { providerId: 'p1', modelId: 'm1' } },
        tools: { allow: ['read'] },
        skills: { allow: ['s1'] },
        permissions: 'auto',
        pathPolicy: { write: ['tests/**'] },
        delegation: {
          enabled: true,
          allowedAgents: ['builtin.reviewer'],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
        limits: { maxStepsPerTurn: 5 },
        context: { includeProjectInstructions: false, compaction: 'off' },
        memory: { scopes: ['session'], write: 'never' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tags: ['helper'],
      })
      expect('version' in fields).toBe(false)
      expect('createdAt' in fields).toBe(false)
    })
  })

  describe('localized', () => {
    it('picks language with fallback to other language and default', () => {
      expect(localized({ 'zh-CN': '助手', 'en-US': 'Assistant' }, 'zh-CN')).toBe('助手')
      expect(localized({ 'zh-CN': '助手', 'en-US': 'Assistant' }, 'en-US')).toBe('Assistant')
      expect(localized({ 'en-US': 'Assistant' }, 'zh-CN')).toBe('Assistant')
      expect(localized({ 'zh-CN': '助手' }, 'en-US')).toBe('助手')
      expect(localized({}, 'zh-CN', 'Fallback')).toBe('Fallback')
    })
  })

  describe('sameFields and sectionChanged', () => {
    it('detects changes correctly by section', () => {
      const a = defaultDraft()
      const b = { ...defaultDraft(), instructions: 'new prompt' }
      expect(sameFields(a, b)).toBe(false)
      expect(sameFields(a, a)).toBe(true)
      expect(sectionChanged(a, b, 'instructions')).toBe(true)
      expect(sectionChanged(a, b, 'basic')).toBe(false)
      expect(sectionChanged(a, b, 'model')).toBe(false)

      const c = { ...a, model: { mode: 'fixed' as const } }
      expect(sectionChanged(a, c, 'model')).toBe(true)

      const d = {
        ...a,
        delegation: { ...defaultDelegationPolicy(), enabled: true },
        pathPolicy: { write: ['tests/**'] },
      }
      expect(sectionChanged(a, d, 'delegation')).toBe(true)
      expect(sectionChanged(a, d, 'permissions')).toBe(true)
    })
  })
})
