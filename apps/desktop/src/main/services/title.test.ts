import { describe, expect, it } from 'vitest'
import type { PersistedEvent, UnsequencedEvent } from '@cairn/protocol'
import {
  AUTO_TITLE_MAX_LENGTH,
  AUTO_TITLE_SOURCE_MAX_LENGTH,
  autoTitleBlocked,
  autoTitleInput,
  clipText,
  normalizeTitle,
} from './title.js'

const model = { providerId: 'local', modelId: 'm' }

function sequenced(events: readonly UnsequencedEvent[]): PersistedEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 })) as PersistedEvent[]
}

const header = (type: UnsequencedEvent['type'], extra: Record<string, unknown> = {}) =>
  ({
    v: 1 as const,
    sessionId: 's1',
    runId: 'r1',
    ts: 1,
    type,
    ...extra,
  }) as UnsequencedEvent

function firstTurn(
  patch: {
    title?: string
    renamed?: { title: string; source?: 'user' | 'auto' }
    model?: typeof model
    user?: string
    assistant?: string
    turnId?: string
    extra?: UnsequencedEvent[]
  } = {},
): PersistedEvent[] {
  const turnId = patch.turnId ?? 't1'
  return sequenced([
    {
      ...header('session.created', { runId: 's1' }),
      type: 'session.created',
      payload: {
        projectId: 'p1',
        projectPath: '/work',
        workspacePath: '/work',
        title: patch.title ?? '',
        ...((patch.model ?? model) ? { model: patch.model ?? model } : {}),
      },
    },
    ...(patch.renamed
      ? [
          {
            ...header('session.renamed', { runId: 's1' }),
            type: 'session.renamed' as const,
            payload: patch.renamed,
          },
        ]
      : []),
    { ...header('turn.started', { turnId }), type: 'turn.started', payload: {} },
    {
      ...header('message.user', { turnId }),
      type: 'message.user',
      payload: {
        messageId: 'u1',
        content: [{ type: 'text' as const, text: patch.user ?? '帮我整理日志' }],
      },
    },
    {
      ...header('message.assistant.completed', { turnId }),
      type: 'message.assistant.completed',
      payload: {
        messageId: 'a1',
        content: [{ type: 'text' as const, text: patch.assistant ?? '好的' }],
        model,
      },
    },
    ...(patch.extra ?? []),
    {
      ...header('turn.completed', { turnId }),
      type: 'turn.completed',
      payload: { durationMs: 5 },
    },
  ])
}

describe('normalizeTitle', () => {
  it('keeps a short title and strips wrapping quotes and extra space', () => {
    expect(normalizeTitle('  "整理日志"  ')).toBe('整理日志')
    expect(normalizeTitle('「修复登录」')).toBe('修复登录')
    expect(normalizeTitle('第一行\n第二行')).toBe('第一行')
    expect(normalizeTitle('  a   b  ')).toBe('a b')
    expect(normalizeTitle('   ')).toBe('')
  })

  it('truncates to 30 code points', () => {
    expect(normalizeTitle('字'.repeat(40))).toBe('字'.repeat(AUTO_TITLE_MAX_LENGTH))
    expect([...normalizeTitle('字'.repeat(40))]).toHaveLength(30)
  })
})

describe('clipText', () => {
  it('leaves short text and cuts long text on code points', () => {
    expect(clipText('hi')).toBe('hi')
    const long = '测'.repeat(AUTO_TITLE_SOURCE_MAX_LENGTH + 5)
    expect([...clipText(long)]).toHaveLength(AUTO_TITLE_SOURCE_MAX_LENGTH)
  })
})

describe('autoTitleInput', () => {
  it('uses the first user message and the reply of the first completed turn', () => {
    expect(autoTitleInput(firstTurn())).toEqual({
      userText: '帮我整理日志',
      assistantText: '好的',
      model,
      runId: 'r1',
      turnId: 't1',
    })
  })

  it('skips when the session already has a title or the user renamed it', () => {
    expect(autoTitleInput(firstTurn({ title: '已有' }))).toBeUndefined()
    expect(autoTitleInput(firstTurn({ renamed: { title: '' } }))).toBeUndefined()
    expect(autoTitleInput(firstTurn({ renamed: { title: '', source: 'user' } }))).toBeUndefined()
  })

  it('skips a later turn after the first one failed', () => {
    const events = sequenced([
      {
        ...header('session.created', { runId: 's1' }),
        type: 'session.created',
        payload: {
          projectId: 'p1',
          projectPath: '/work',
          workspacePath: '/work',
          title: '',
          model,
        },
      },
      { ...header('turn.started', { turnId: 't1' }), type: 'turn.started', payload: {} },
      {
        ...header('turn.failed', { turnId: 't1' }),
        type: 'turn.failed',
        payload: { error: { code: 'model.network_error' }, retryable: true },
      },
      { ...header('turn.started', { turnId: 't2' }), type: 'turn.started', payload: {} },
      {
        ...header('message.user', { turnId: 't2' }),
        type: 'message.user',
        payload: { messageId: 'u2', content: [{ type: 'text', text: '再试一次' }] },
      },
      {
        ...header('message.assistant.completed', { turnId: 't2' }),
        type: 'message.assistant.completed',
        payload: {
          messageId: 'a2',
          content: [{ type: 'text', text: '好' }],
          model,
        },
      },
      {
        ...header('turn.completed', { turnId: 't2' }),
        type: 'turn.completed',
        payload: { durationMs: 1 },
      },
    ])
    expect(autoTitleInput(events)).toBeUndefined()
  })

  it('skips the second completed turn and a turn with no text', () => {
    const once = firstTurn()
    const twice = sequenced([
      ...once.map(({ seq: _seq, ...event }) => event),
      { ...header('turn.started', { turnId: 't2' }), type: 'turn.started', payload: {} },
      {
        ...header('turn.completed', { turnId: 't2' }),
        type: 'turn.completed',
        payload: { durationMs: 1 },
      },
    ])
    expect(autoTitleInput(twice)).toBeUndefined()
    expect(autoTitleInput(firstTurn({ user: '   ' }))).toBeUndefined()
    expect(autoTitleInput(firstTurn({ assistant: '' }))).toBeUndefined()
  })

  it('joins assistant text in the turn and follows a model change', () => {
    const next = { providerId: 'local', modelId: 'other' }
    const events = firstTurn({
      extra: [
        {
          ...header('session.model.changed', { runId: 's1' }),
          type: 'session.model.changed',
          payload: { model: next },
        },
        {
          ...header('message.assistant.completed', { turnId: 't1' }),
          type: 'message.assistant.completed',
          payload: {
            messageId: 'a2',
            content: [{ type: 'text', text: '补充' }],
            model,
          },
        },
      ],
    })
    expect(autoTitleInput(events)).toMatchObject({
      assistantText: '好的\n补充',
      model: next,
    })
  })
})

describe('autoTitleInput edge cases', () => {
  it('ignores events without turn ids', () => {
    const events = sequenced([
      {
        ...header('session.created', { runId: 's1' }),
        type: 'session.created',
        payload: {
          projectId: 'p1',
          projectPath: '/work',
          workspacePath: '/work',
          title: '',
          model,
        },
      },
      { ...header('turn.started', { turnId: 't1' }), type: 'turn.started', payload: {} },
      {
        ...header('message.user', { turnId: 't1' }),
        type: 'message.user',
        payload: { messageId: 'u1', content: [{ type: 'text', text: '整理' }] },
      },
      {
        ...header('message.assistant.completed'),
        type: 'message.assistant.completed',
        payload: { messageId: 'a1', content: [{ type: 'text', text: '好' }], model },
      },
      { ...header('turn.completed'), type: 'turn.completed', payload: { durationMs: 1 } },
    ])
    expect(autoTitleInput(events)).toBeUndefined()
  })

  it('skips a completed first turn without an assistant message', () => {
    const events = sequenced([
      {
        ...header('session.created', { runId: 's1' }),
        type: 'session.created',
        payload: {
          projectId: 'p1',
          projectPath: '/work',
          workspacePath: '/work',
          title: '',
          model,
        },
      },
      { ...header('turn.started', { turnId: 't1' }), type: 'turn.started', payload: {} },
      {
        ...header('message.user', { turnId: 't1' }),
        type: 'message.user',
        payload: { messageId: 'u1', content: [{ type: 'text', text: '整理' }] },
      },
      {
        ...header('turn.completed', { turnId: 't1' }),
        type: 'turn.completed',
        payload: { durationMs: 0 },
      },
    ])
    expect(autoTitleInput(events)).toBeUndefined()
  })
})

describe('autoTitleBlocked', () => {
  it('is blocked by a manual rename and by a non-empty title', () => {
    expect(autoTitleBlocked(firstTurn())).toBe(false)
    expect(autoTitleBlocked(firstTurn({ renamed: { title: '手', source: 'user' } }))).toBe(true)
    expect(autoTitleBlocked(firstTurn({ renamed: { title: '自动', source: 'auto' } }))).toBe(true)
    expect(autoTitleBlocked(firstTurn({ title: '已有' }))).toBe(true)
  })
})
