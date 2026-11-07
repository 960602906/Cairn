import type { PersistedEvent } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  BRIEF_SYSTEM_PROMPT,
  BRIEF_USER_EDITED_NOTE,
  briefRequest,
  briefUpdateInput,
  latestBrief,
  mergeBrief,
  sameBrief,
} from './brief.js'

const model = { providerId: 'local', modelId: 'main' }

function ev(
  type: PersistedEvent['type'],
  payload: PersistedEvent['payload'],
  extra: { seq: number; turnId?: string } = { seq: 1 },
): PersistedEvent {
  return {
    v: 1,
    sessionId: 's1',
    runId: 'r1',
    ts: extra.seq,
    seq: extra.seq,
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    type,
    payload,
  } as PersistedEvent
}

describe('mergeBrief', () => {
  it('keeps a user edit verbatim and only appends new lines', () => {
    const user = { content: '不要改 API', editedBy: 'user' as const }
    expect(mergeBrief(user, '完全重写')).toBe('不要改 API\n完全重写')
    expect(mergeBrief(user, '不要改 API\n测试用 Vitest')).toBe('不要改 API\n测试用 Vitest')
    expect(mergeBrief(user, '不要改 API')).toBe('不要改 API')
    expect(mergeBrief(user, '  ')).toBe('不要改 API')
    expect(mergeBrief({ content: '目标：修复测试', editedBy: 'agent' }, '新的目标')).toBe(
      '新的目标',
    )
  })

  it('treats the same trimmed text as unchanged', () => {
    expect(sameBrief('目标：修复测试', '  目标：修复测试\n')).toBe(true)
    expect(sameBrief(undefined, '  ')).toBe(true)
    expect(sameBrief('目标', '另一个')).toBe(false)
  })
})

describe('latestBrief', () => {
  it('uses the latest non-empty brief and treats a blank one as cleared', () => {
    const events = [
      ev('session.brief.updated', { content: '旧', editedBy: 'agent' }, { seq: 1 }),
      ev('session.brief.updated', { content: '不要改 API', editedBy: 'user' }, { seq: 2 }),
    ]
    expect(latestBrief(events)).toEqual({ content: '不要改 API', editedBy: 'user' })
    expect(
      latestBrief([
        ...events,
        ev('session.brief.updated', { content: '  ', editedBy: 'user' }, { seq: 3 }),
      ]),
    ).toBeUndefined()
  })
})

describe('briefUpdateInput', () => {
  it('builds the latest turn and tells the model to keep a user edit', () => {
    const events = [
      ev(
        'session.created',
        {
          projectId: 'p1',
          projectPath: '/work',
          workspacePath: '/work',
          title: '修复',
          model,
        },
        { seq: 1 },
      ),
      ev(
        'message.user',
        { messageId: 'u1', content: [{ type: 'text', text: '目标是修复登录' }] },
        { seq: 2 },
      ),
      ev(
        'message.assistant.completed',
        { messageId: 'a1', content: [{ type: 'text', text: '好的' }], model },
        { seq: 3, turnId: 't1' },
      ),
      ev('turn.completed', { durationMs: 5 }, { seq: 4, turnId: 't1' }),
      ev('session.brief.updated', { content: '不要改 API', editedBy: 'user' }, { seq: 5 }),
    ]
    const input = briefUpdateInput(events)
    expect(input).toMatchObject({
      userText: '目标是修复登录',
      assistantText: '好的',
      model,
      turnId: 't1',
      brief: { content: '不要改 API', editedBy: 'user' },
    })
    const request = briefRequest(input!)
    expect(BRIEF_SYSTEM_PROMPT).toContain('You keep a session brief.')
    expect(request).toContain('不要改 API')
    expect(request).toContain(BRIEF_USER_EDITED_NOTE)
    expect(request).toContain('目标是修复登录')
  })
})
