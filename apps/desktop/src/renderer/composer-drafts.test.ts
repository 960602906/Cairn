// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerDraft,
  NEW_SESSION_DRAFT_KEY,
  readComposerDraft,
  readNewSessionAgent,
  readNewSessionModel,
  readNewSessionProject,
  sessionDraftKey,
  writeComposerDraft,
  writeNewSessionAgent,
  writeNewSessionModel,
  writeNewSessionProject,
} from './composer-drafts.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composer drafts', () => {
  it('round-trips a draft per key', () => {
    writeComposerDraft(sessionDraftKey('s1'), { text: '写点什么', planMode: true })
    writeComposerDraft(NEW_SESSION_DRAFT_KEY, { text: '新对话草稿', planMode: false })

    expect(readComposerDraft(sessionDraftKey('s1'))).toEqual({ text: '写点什么', planMode: true })
    expect(readComposerDraft(NEW_SESSION_DRAFT_KEY)).toEqual({
      text: '新对话草稿',
      planMode: false,
    })
    expect(readComposerDraft(sessionDraftKey('s2'))).toEqual({ text: '', planMode: false })
  })

  it('drops the entry for an empty draft', () => {
    writeComposerDraft('x', { text: 'a', planMode: false })
    expect(localStorage.getItem('cairn.composerDraft:x')).not.toBeNull()

    writeComposerDraft('x', { text: '', planMode: false })
    expect(localStorage.getItem('cairn.composerDraft:x')).toBeNull()

    // 只有计划模式开着时也要留下，否则退出再回来标记就没了。
    writeComposerDraft('x', { text: '', planMode: true })
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: true })
    clearComposerDraft('x')
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false })
  })

  it('falls back to an empty draft for broken records', () => {
    localStorage.setItem('cairn.composerDraft:x', '{not json')
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false })

    localStorage.setItem('cairn.composerDraft:x', JSON.stringify({ text: 7, planMode: 'yes' }))
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false })
  })

  it('remembers the new-session workspace and its model', () => {
    expect(readNewSessionProject()).toBeUndefined()
    localStorage.setItem('cairn.newSession.project', '')
    expect(readNewSessionProject()).toBeUndefined()

    writeNewSessionProject('/work')
    expect(readNewSessionProject()).toBe('/work')
    expect(readNewSessionModel('/work')).toBeUndefined()

    writeNewSessionModel('/work', { providerId: 'p1', modelId: 'strong' })
    expect(readNewSessionModel('/work')).toEqual({ providerId: 'p1', modelId: 'strong' })
    expect(readNewSessionModel('/other')).toBeUndefined()
    expect(readNewSessionModel('')).toBeUndefined()

    // 还没有工作空间时不记模型。
    writeNewSessionModel('', { providerId: 'p1', modelId: 'strong' })
    expect(localStorage.getItem('cairn.newSession.model:')).toBeNull()

    writeNewSessionProject('')
    expect(readNewSessionProject()).toBeUndefined()
  })

  it('remembers the new-session agent per workspace', () => {
    expect(readNewSessionAgent('/agent-work')).toBeUndefined()

    writeNewSessionAgent('/agent-work', 'builtin.reviewer')
    expect(readNewSessionAgent('/agent-work')).toBe('builtin.reviewer')
    expect(readNewSessionAgent('/other')).toBeUndefined()
    expect(readNewSessionAgent('')).toBeUndefined()

    // 还没有工作空间时不记 Agent；空 id 等同于清除。
    writeNewSessionAgent('', 'builtin.coder')
    expect(localStorage.getItem('cairn.newSession.agent:')).toBeNull()
    writeNewSessionAgent('/agent-work', '')
    expect(readNewSessionAgent('/agent-work')).toBeUndefined()
  })

  it('ignores broken model records', () => {
    localStorage.setItem('cairn.newSession.model:/work', 'oops')
    expect(readNewSessionModel('/work')).toBeUndefined()

    localStorage.setItem('cairn.newSession.model:/work', JSON.stringify({ providerId: 1 }))
    expect(readNewSessionModel('/work')).toBeUndefined()
  })

  it('survives storage that throws', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('blocked')
      })
    }

    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false })
    expect(readNewSessionProject()).toBeUndefined()
    expect(readNewSessionModel('/work')).toBeUndefined()
    expect(readNewSessionAgent('/work')).toBeUndefined()
    expect(() => writeComposerDraft('x', { text: 'a', planMode: false })).not.toThrow()
    expect(() => writeNewSessionModel('/work', { providerId: 'p', modelId: 'm' })).not.toThrow()
    expect(() => writeNewSessionAgent('/work', 'builtin.coder')).not.toThrow()
    expect(() => writeNewSessionProject('/work')).not.toThrow()
    expect(() => clearComposerDraft('x')).not.toThrow()
  })
})
