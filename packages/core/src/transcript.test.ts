import { describe, expect, it } from 'vitest'
import type { MessageView } from './session-view.js'
import { transcriptFileName, transcriptMarkdown } from './transcript.js'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const user = (content: string): MessageView => ({
  role: 'user',
  messageId: `u-${content}`,
  runId: 'r1',
  turnId: 't1',
  seq: 1,
  ts: 1,
  content: text(content),
  mentions: [],
  skills: [],
  agents: [],
})

const assistant = (
  content: string,
  extra: Partial<Extract<MessageView, { role: 'assistant' }>> = {},
): MessageView => ({
  role: 'assistant',
  messageId: 'a1',
  runId: 'r1',
  turnId: 't1',
  seq: 2,
  ts: 2,
  content: text(content),
  reasoning: undefined,
  toolCalls: [],
  model: { providerId: 'p1', modelId: 'm1' },
  incomplete: false,
  ...extra,
})

const call = (name: string) => ({ id: `c-${name}`, name, input: {} })

describe('transcriptMarkdown', () => {
  it('renders a Chinese transcript with title, project path and both roles', () => {
    expect(
      transcriptMarkdown([user('修复登录'), assistant('已经修好了。')], {
        title: '修复登录',
        projectPath: '/work/demo',
      }),
    ).toBe(
      [
        '# 修复登录',
        '',
        '> /work/demo',
        '',
        '## 用户',
        '',
        '修复登录',
        '',
        '## 助手',
        '',
        '已经修好了。',
        '',
      ].join('\n'),
    )
  })

  it('uses English labels, image placeholders and one line of tool names', () => {
    const view = assistant('', {
      content: [
        { type: 'text', text: '' },
        { type: 'image', blobRef: 'b1', mimeType: 'image/png' },
      ],
      toolCalls: [call('Read'), call('Bash'), call('Read')],
    })
    expect(transcriptMarkdown([view], { title: '  ', locale: 'en-US' })).toBe(
      [
        '# Untitled chat',
        '',
        '## Assistant',
        '',
        '[image]',
        '',
        '> Tool calls: Read×2, Bash',
        '',
      ].join('\n'),
    )
  })

  it('renders file attachments with their names in both locales (ADR-0052)', () => {
    const view = assistant('', {
      content: [
        { type: 'file', blobRef: 'b2', name: 'a.pdf', mimeType: 'application/pdf', size: 3 },
      ],
    })
    expect(transcriptMarkdown([view], { title: '会话' })).toContain('[附件：a.pdf]')
    expect(transcriptMarkdown([view], { title: 'chat', locale: 'en-US' })).toContain(
      '[file: a.pdf]',
    )
  })

  it('marks incomplete replies and skips empty messages', () => {
    expect(
      transcriptMarkdown([user(''), assistant('部分回复', { incomplete: true }), assistant('')], {
        title: '会话',
        locale: 'zh-CN',
      }),
    ).toBe(['# 会话', '', '## 助手', '', '部分回复', '', '_（回复未完成）_', ''].join('\n'))
  })
})

describe('transcriptFileName', () => {
  it('sanitizes illegal characters and falls back to session', () => {
    expect(transcriptFileName('修复/登录: 问题*?')).toBe('修复 登录 问题.md')
    expect(transcriptFileName('   ')).toBe('session.md')
    expect(transcriptFileName('a\nb')).toBe('a b.md')
    expect(transcriptFileName('x'.repeat(100))).toBe(`${'x'.repeat(60)}.md`)
  })
})
