import type { AskUserGateRequest } from '@cairn/core'
import { describe, expect, it, vi } from 'vitest'
import { createHostQuestionGate } from './question-gate.js'

const questions = [
  {
    id: 'q1',
    question: 'Which one?',
    options: [{ label: 'A', recommended: true }, { label: 'B' }],
  },
]

function request(signal: AbortSignal, extra: Partial<AskUserGateRequest> = {}): AskUserGateRequest {
  return {
    questionId: 'q1',
    toolCallId: 'c1',
    questions,
    signal,
    ...extra,
  }
}

describe('createHostQuestionGate', () => {
  it('sends the questions without a timeout and returns the answers', async () => {
    const endpoint = {
      request: vi.fn(async () => ({
        answers: [{ questionId: 'q1', selected: ['A'] }],
      })),
      emit: vi.fn(),
    }
    const gate = createHostQuestionGate({ endpoint: endpoint as never })
    await expect(gate.ask(request(new AbortController().signal))).resolves.toEqual({
      answers: [{ questionId: 'q1', selected: ['A'] }],
    })
    expect(endpoint.request).toHaveBeenCalledWith(
      'host.question.request',
      { questionId: 'q1', toolCallId: 'c1', questions },
      { timeoutMs: 0 },
    )
    expect(endpoint.emit).not.toHaveBeenCalled()
  })

  it('emits a cancel when the signal aborts', async () => {
    let answer!: (value: unknown) => void
    const endpoint = {
      request: vi.fn(() => new Promise((resolve) => (answer = resolve))),
      emit: vi.fn(),
    }
    const gate = createHostQuestionGate({ endpoint: endpoint as never })
    const controller = new AbortController()
    const pending = gate.ask(request(controller.signal))
    controller.abort()
    expect(endpoint.emit).toHaveBeenCalledWith('host.question.cancelled', { questionId: 'q1' })
    answer({ answers: [{ questionId: 'q1', selected: ['B'] }] })
    await expect(pending).resolves.toEqual({
      answers: [{ questionId: 'q1', selected: ['B'] }],
    })
  })
})
