import type { AskUserRequest } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createQuestionService } from './question-service.js'

const request = (questionId: string): AskUserRequest => ({
  questionId,
  toolCallId: `call-${questionId}`,
  questions: [
    {
      id: 'q1',
      question: 'Which one?',
      options: [{ label: 'A', recommended: true }, { label: 'B' }],
    },
  ],
})

function setup() {
  const service = createQuestionService({ now: () => 123 })
  return { service }
}

describe('createQuestionService', () => {
  it('lists pending questions per session and resolves them', async () => {
    const { service } = setup()
    const first = service.request('s1', request('q1'))
    const second = service.request('s1', request('q2'))
    void service.request('s2', request('q3'))
    expect(service.pending({ sessionId: 's1' }).questions.map((q) => q.questionId)).toEqual([
      'q1',
      'q2',
    ])
    expect(
      service.resolve({
        sessionId: 's1',
        questionId: 'q2',
        answers: [{ questionId: 'q1', selected: ['B'] }],
      }),
    ).toEqual({})
    await expect(second).resolves.toEqual({
      answers: [{ questionId: 'q1', selected: ['B'] }],
    })
    service.resolve({
      sessionId: 's1',
      questionId: 'q1',
      answers: [{ questionId: 'q1', selected: [], custom: 'C' }],
    })
    await expect(first).resolves.toEqual({
      answers: [{ questionId: 'q1', selected: [], custom: 'C' }],
    })
    expect(service.pending({ sessionId: 's1' }).questions).toEqual([])
  })

  it('resolves a question the user cancelled without answers', async () => {
    const { service } = setup()
    const pending = service.request('s1', request('q1'))
    service.resolve({ sessionId: 's1', questionId: 'q1', cancelled: true })
    await expect(pending).resolves.toEqual({ answers: [], cancelled: true })
    expect(service.pending({ sessionId: 's1' }).questions).toEqual([])
  })

  it('lists pending questions across sessions with request time', () => {
    const { service } = setup()
    void service.request('s1', request('q1'))
    void service.request('s2', request('q2'))
    expect(service.list()).toEqual([
      {
        sessionId: 's1',
        requestedAt: 123,
        request: expect.objectContaining({ questionId: 'q1' }),
      },
      {
        sessionId: 's2',
        requestedAt: 123,
        request: expect.objectContaining({ questionId: 'q2' }),
      },
    ])
  })

  it('cancels questions and rejects unknown or foreign ones', async () => {
    const { service } = setup()
    const pending = service.request('s1', request('q1'))
    expect(() => service.resolve({ sessionId: 's2', questionId: 'q1', answers: [] })).toThrow(
      expect.objectContaining({ code: 'question.not_found' }),
    )
    service.cancel('s2', 'q1')
    expect(service.pending({ sessionId: 's1' }).questions).toHaveLength(1)
    service.cancel('s1', 'q1')
    await expect(pending).rejects.toMatchObject({ code: 'question.cancelled' })
    service.cancel('s1', 'q1')
    expect(() => service.resolve({ sessionId: 's1', questionId: 'q1', answers: [] })).toThrow(
      expect.objectContaining({ code: 'question.not_found' }),
    )
  })

  it('replaces a repeated question id and notifies subscribers', async () => {
    const { service } = setup()
    const seen: string[] = []
    const off = service.subscribe((sessionId) => seen.push(sessionId))
    const first = service.request('s1', request('q1'))
    const second = service.request('s1', request('q1'))
    await expect(first).rejects.toMatchObject({ code: 'question.cancelled' })
    service.resolve({
      sessionId: 's1',
      questionId: 'q1',
      answers: [{ questionId: 'q1', selected: ['A'] }],
    })
    await expect(second).resolves.toEqual({
      answers: [{ questionId: 'q1', selected: ['A'] }],
    })
    expect(seen).toEqual(['s1', 's1', 's1'])
    off()
    service.request('s1', request('q2'))
    expect(seen).toEqual(['s1', 's1', 's1'])
  })
})
