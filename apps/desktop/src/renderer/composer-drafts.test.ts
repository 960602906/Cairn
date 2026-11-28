// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerDraft,
  NEW_SESSION_DRAFT_KEY,
  readComposerDraft,
  readNewSessionAgent,
  readNewSessionModel,
  readNewSessionProject,
  readNewSessionTeam,
  sessionDraftKey,
  writeComposerDraft,
  writeNewSessionAgent,
  writeNewSessionModel,
  writeNewSessionProject,
  writeNewSessionTeam,
} from './composer-drafts.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composer drafts', () => {
  it('round-trips a draft per key', () => {
    writeComposerDraft(sessionDraftKey('s1'), { text: '写点什么', planMode: true })
    writeComposerDraft(NEW_SESSION_DRAFT_KEY, { text: '新对话草稿', planMode: false })

    expect(readComposerDraft(sessionDraftKey('s1'))).toEqual({
      text: '写点什么',
      planMode: true,
      attachments: [],
    })
    expect(readComposerDraft(NEW_SESSION_DRAFT_KEY)).toEqual({
      text: '新对话草稿',
      planMode: false,
      attachments: [],
    })
    expect(readComposerDraft(sessionDraftKey('s2'))).toEqual({
      text: '',
      planMode: false,
      attachments: [],
    })
  })

  it('drops the entry for an empty draft', () => {
    writeComposerDraft('x', { text: 'a', planMode: false })
    expect(localStorage.getItem('cairn.composerDraft:x')).not.toBeNull()

    writeComposerDraft('x', { text: '', planMode: false })
    expect(localStorage.getItem('cairn.composerDraft:x')).toBeNull()

    // 只有计划模式开着时也要留下，否则退出再回来标记就没了。
    writeComposerDraft('x', { text: '', planMode: true })
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: true, attachments: [] })
    clearComposerDraft('x')
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false, attachments: [] })
  })

  it('falls back to an empty draft for broken records', () => {
    localStorage.setItem('cairn.composerDraft:x', '{not json')
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false, attachments: [] })

    localStorage.setItem('cairn.composerDraft:x', JSON.stringify({ text: 7, planMode: 'yes' }))
    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false, attachments: [] })
  })

  it('附件随草稿保存与恢复，坏条目被丢弃，不保存预览（ADR-0052）', () => {
    writeComposerDraft('x', {
      text: '看这个',
      planMode: false,
      attachments: [
        {
          blobRef: 'b1',
          kind: 'image',
          name: '截图.png',
          mimeType: 'image/png',
          size: 8,
          preview: 'data:image/png;base64,AAAA',
        } as never,
        { blobRef: 'b2', kind: 'file', name: 'a.pdf', mimeType: 'application/pdf', size: 3 },
      ],
    })
    expect(readComposerDraft('x')).toEqual({
      text: '看这个',
      planMode: false,
      attachments: [
        { blobRef: 'b1', kind: 'image', name: '截图.png', mimeType: 'image/png', size: 8 },
        { blobRef: 'b2', kind: 'file', name: 'a.pdf', mimeType: 'application/pdf', size: 3 },
      ],
    })
    // 多出来的字段（比如预览）读回时被丢弃。

    // 坏条目：类型、名字或大小不合法的一律丢弃；只有附件时草稿也保留。
    localStorage.setItem(
      'cairn.composerDraft:x',
      JSON.stringify({
        text: '',
        planMode: false,
        attachments: [
          { blobRef: '', kind: 'image', name: 'a', mimeType: 'image/png', size: 1 },
          { blobRef: 'b', kind: 'nope', name: 'a', mimeType: 'image/png', size: 1 },
          { blobRef: 'b', kind: 'file', name: '', mimeType: 'text/plain', size: 1 },
          { blobRef: 'b', kind: 'file', name: 'a', mimeType: '', size: 1 },
          { blobRef: 'b', kind: 'file', name: 'a', mimeType: 'text/plain', size: -1 },
          { blobRef: 'ok', kind: 'file', name: 'a.txt', mimeType: 'text/plain', size: 1 },
        ],
      }),
    )
    expect(readComposerDraft('x')).toEqual({
      text: '',
      planMode: false,
      attachments: [
        { blobRef: 'ok', kind: 'file', name: 'a.txt', mimeType: 'text/plain', size: 1 },
      ],
    })
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

  it('remembers the new-session team per workspace and keeps it exclusive with an agent', () => {
    expect(readNewSessionTeam('/team-work')).toBeUndefined()
    writeNewSessionAgent('/team-work', 'builtin.reviewer')
    writeNewSessionTeam('/team-work', 'user.team-1')
    expect(readNewSessionTeam('/team-work')).toBe('user.team-1')
    // 选中团队后不再记着旧的单个 Agent。
    expect(readNewSessionAgent('/team-work')).toBeUndefined()
    expect(readNewSessionTeam('/other')).toBeUndefined()
    expect(readNewSessionTeam('')).toBeUndefined()

    // 再选 Agent 就离开团队。
    writeNewSessionAgent('/team-work', 'builtin.coder')
    expect(readNewSessionTeam('/team-work')).toBeUndefined()
    expect(readNewSessionAgent('/team-work')).toBe('builtin.coder')

    // 还没有工作空间时不记团队；null 等同于清除。
    writeNewSessionTeam('', 'user.team-1')
    expect(localStorage.getItem('cairn.newSession.team:')).toBeNull()
    writeNewSessionTeam('/team-work', 'user.team-1')
    writeNewSessionTeam('/team-work', null)
    expect(readNewSessionTeam('/team-work')).toBeUndefined()
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

    expect(readComposerDraft('x')).toEqual({ text: '', planMode: false, attachments: [] })
    expect(readNewSessionProject()).toBeUndefined()
    expect(readNewSessionModel('/work')).toBeUndefined()
    expect(readNewSessionAgent('/work')).toBeUndefined()
    expect(readNewSessionTeam('/work')).toBeUndefined()
    expect(() => writeComposerDraft('x', { text: 'a', planMode: false })).not.toThrow()
    expect(() => writeNewSessionModel('/work', { providerId: 'p', modelId: 'm' })).not.toThrow()
    expect(() => writeNewSessionAgent('/work', 'builtin.coder')).not.toThrow()
    expect(() => writeNewSessionTeam('/work', 'user.team-1')).not.toThrow()
    expect(() => writeNewSessionProject('/work')).not.toThrow()
    expect(() => clearComposerDraft('x')).not.toThrow()
  })
})
