import { describe, expect, it, vi } from 'vitest'
import type { ActivityChange } from './activity-service.js'
import { createActivityNotifier } from './activity-notifier.js'

const approval = (sessionId: string, sessionTitle: string, approvalId = 'a1') => ({
  approvalId,
  sessionId,
  sessionTitle,
  runId: 'r1',
  agent: { id: 'builtin.coder', version: 1 },
  toolName: 'run_command',
  toolCategory: 'execute' as const,
  kind: 'tool' as const,
  summary: 'npm test',
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
  requestedAt: 1,
})

const completed = (sessionId: string, sessionTitle: string, turnId = 't1') => ({
  sessionId,
  sessionTitle,
  runId: 'r1',
  turnId,
  agent: { id: 'builtin.coder', version: 1 },
  status: 'completed' as const,
  summary: 'done',
  completedAt: 1,
})

function setup(options: { foreground?: boolean; enabled?: boolean } = {}) {
  let listener: ((change: ActivityChange) => void) | undefined
  let now = 1_000
  const notify = vi.fn()
  const onError = vi.fn()
  const notifier = createActivityNotifier({
    activity: {
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    },
    isForeground: () => options.foreground ?? false,
    enabled: () => options.enabled ?? true,
    notify,
    format: ({ kind, title, agentId }) => ({
      title,
      body: `${agentId}:${kind}`,
    }),
    now: () => now,
    onError,
  })
  const emit = (change: ActivityChange) => listener?.(change)
  return {
    notifier,
    notify,
    onError,
    emit,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('createActivityNotifier', () => {
  it('notifies new approvals and completions with only title and agent text', () => {
    const { emit, notify } = setup()
    emit({ reason: 'approvals', approvals: [approval('s1', '重构 utils')], completed: [] })
    expect(notify).toHaveBeenLastCalledWith({
      sessionId: 's1',
      title: '重构 utils',
      body: 'builtin.coder:approval',
    })
    emit({ reason: 'completed', approvals: [], completed: [completed('s2', '修复登录')] })
    expect(notify).toHaveBeenLastCalledWith({
      sessionId: 's2',
      title: '修复登录',
      body: 'builtin.coder:completed',
    })
    expect(JSON.stringify(notify.mock.calls)).not.toContain('npm test')
    expect(JSON.stringify(notify.mock.calls)).not.toContain('done')
  })

  it('does not notify while foreground or disabled', () => {
    const foreground = setup({ foreground: true })
    foreground.emit({
      reason: 'approvals',
      approvals: [approval('s1', '一')],
      completed: [],
    })
    expect(foreground.notify).not.toHaveBeenCalled()

    const disabled = setup({ enabled: false })
    disabled.emit({
      reason: 'completed',
      approvals: [],
      completed: [completed('s2', '二')],
    })
    expect(disabled.notify).not.toHaveBeenCalled()
  })

  it('coalesces the same session within the minimum interval', () => {
    const { emit, notify, advance } = setup()
    emit({ reason: 'approvals', approvals: [approval('s1', '一')], completed: [] })
    emit({ reason: 'approvals', approvals: [approval('s1', '一', 'a2')], completed: [] })
    expect(notify).toHaveBeenCalledTimes(1)
    advance(15_000)
    emit({ reason: 'approvals', approvals: [approval('s1', '一', 'a3')], completed: [] })
    expect(notify).toHaveBeenCalledTimes(2)
    emit({ reason: 'approvals', approvals: [approval('s2', '二')], completed: [] })
    expect(notify).toHaveBeenCalledTimes(3)
  })

  it('ignores changes without new approvals or completions and falls back to session id', () => {
    const { emit, notify } = setup()
    emit({ reason: 'runs', approvals: [], completed: [] })
    expect(notify).not.toHaveBeenCalled()
    emit({
      reason: 'approvals',
      sessionId: 's9',
      approvals: [{ ...approval('s9', ''), sessionTitle: '' }],
      completed: [],
    })
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 's9', title: 's9' }),
    )
    emit({
      reason: 'approvals',
      approvals: [{ ...approval('s10', ''), sessionTitle: '' }],
      completed: [],
    })
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: '' }))
  })

  it('prefers approval over completion and reports formatter or notify failures', () => {
    const { emit, notify } = setup()
    emit({
      reason: 'approvals',
      approvals: [approval('s1', '一')],
      completed: [completed('s1', '一')],
    })
    expect(notify.mock.calls[0]![0].body).toContain('approval')

    let listener: ((change: ActivityChange) => void) | undefined
    const notifyError = vi.fn()
    createActivityNotifier({
      activity: {
        subscribe: (next) => {
          listener = next
          return () => undefined
        },
      },
      isForeground: () => false,
      enabled: () => true,
      notify: () => {
        throw new Error('no permission')
      },
      format: ({ kind, title, agentId }) => ({ title, body: `${agentId}:${kind}` }),
      onError: notifyError,
    })
    listener?.({
      reason: 'approvals',
      approvals: [approval('s2', '二')],
      completed: [],
    })
    expect(notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no permission' }))

    const formatError = vi.fn()
    let formatListener: ((change: ActivityChange) => void) | undefined
    createActivityNotifier({
      activity: {
        subscribe: (next) => {
          formatListener = next
          return () => undefined
        },
      },
      isForeground: () => false,
      enabled: () => true,
      notify: vi.fn(),
      format: () => {
        throw new Error('i18n')
      },
      onError: formatError,
    })
    formatListener?.({
      reason: 'completed',
      approvals: [],
      completed: [completed('s3', '三')],
    })
    expect(formatError).toHaveBeenCalledWith(expect.objectContaining({ message: 'i18n' }))
  })

  it('stops listening after close', () => {
    const { notifier, emit, notify } = setup()
    notifier.close()
    emit({ reason: 'approvals', approvals: [approval('s1', '一')], completed: [] })
    expect(notify).not.toHaveBeenCalled()
  })
})
