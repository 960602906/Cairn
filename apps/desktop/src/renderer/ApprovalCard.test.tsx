// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@nexus/i18n'
import { RpcError, type EventEnvelope, type PendingApproval } from '@nexus/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

type Listener = (data: { sessionId: string }) => void

const approval = (approvalId: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalId,
  toolCallId: `call-${approvalId}`,
  tool: { name: 'run_command', category: 'execute' },
  input: { command: 'npm test' },
  targets: { command: 'npm test' },
  kind: 'tool',
  preview: { summary: 'Run npm test', command: 'npm test' },
  reasonCode: 'permission.category_default',
  matchedRuleIds: [],
  ...extra,
})

const created = {
  v: 1,
  sessionId: 's1',
  runId: 'r1',
  ts: 1,
  seq: 1,
  type: 'session.created',
  payload: { projectId: 'p1', projectPath: '/work', workspacePath: '/work', title: '审批' },
} as EventEnvelope

function setup(initial: PendingApproval[], resolve?: (params: unknown) => unknown) {
  let pending = initial
  const listeners = new Set<Listener>()
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'session.list':
        return {
          sessions: [
            {
              sessionId: 's1',
              title: '审批',
              projectPath: '/work',
              status: 'waiting_approval',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }
      case 'session.subscribe':
        return { events: [created], lastSeq: 1 }
      case 'approval.pending':
        return { approvals: pending }
      case 'approval.resolve': {
        const result = resolve ? resolve(params) : {}
        const { approvalId } = params as { approvalId: string }
        pending = pending.filter((a) => a.approvalId !== approvalId)
        return result
      }
      default:
        return {}
    }
  })
  const api = {
    ready: () => Promise.resolve(),
    request,
    on: (name: string, listener: Listener) => {
      if (name !== 'approval.changed') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  const open = async () => {
    const [item] = await screen.findAllByRole('listitem')
    await userEvent.click(within(item!).getByRole('button'))
  }
  const notify = (sessionId: string) => act(() => listeners.forEach((l) => l({ sessionId })))
  const setPending = (next: PendingApproval[]) => (pending = next)
  return { request, store, open, notify, setPending }
}

const card = (name: string) => screen.getByRole('article', { name })

describe('ApprovalList', () => {
  it('shows pending approvals and allows for the session', async () => {
    const { request, open } = setup([approval('a1')])
    await open()
    const article = await screen.findByRole('article', { name: '需要审批：run_command' })
    expect(within(article).getByText('原因: 这类操作默认需要审批')).toBeTruthy()
    expect(within(article).getByText('说明: Run npm test')).toBeTruthy()
    expect(within(article).getByText('npm test')).toBeTruthy()
    await userEvent.click(within(article).getByRole('button', { name: '本会话始终允许' }))
    expect(request).toHaveBeenCalledWith('approval.resolve', {
      sessionId: 's1',
      approvalId: 'a1',
      decision: 'allow_session',
    })
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
  })

  it('denies with feedback; shows diffs, inputs and unknown reasons', async () => {
    const { request, open } = setup([
      approval('a1', {
        tool: { name: 'write_file', category: 'write' },
        preview: { summary: 'Write a.ts', diff: '+hello' },
        reasonCode: 'permission.sensitive_path',
      }),
      approval('a2', {
        tool: { name: 'mcp_tool', category: 'network' },
        input: { url: 'https://example.com' },
        preview: undefined,
        reasonCode: 'something.new',
      }),
    ])
    await open()
    await screen.findAllByRole('article')
    const write = card('需要审批：write_file')
    expect(within(write).getByText('+hello')).toBeTruthy()
    expect(within(write).getByText(/涉及敏感文件/)).toBeTruthy()
    const other = card('需要审批：mcp_tool')
    expect(within(other).getByText(/https:\/\/example.com/)).toBeTruthy()
    expect(within(other).getByText('原因: 需要审批')).toBeTruthy()

    await userEvent.type(within(write).getByLabelText(/拒绝说明/), '  改用 b.ts  ')
    await userEvent.click(within(write).getByRole('button', { name: '拒绝' }))
    expect(request).toHaveBeenCalledWith('approval.resolve', {
      sessionId: 's1',
      approvalId: 'a1',
      decision: 'deny',
      feedback: '改用 b.ts',
    })
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1))
  })

  it('offers only continue or deny when no checkpoint could be created', async () => {
    const { open } = setup([
      approval('a1', {
        kind: 'no_checkpoint',
        preview: undefined,
        reasonCode: 'checkpoint.failed',
      }),
    ])
    await open()
    const article = await screen.findByRole('article', {
      name: '无法为 run_command 创建检查点，是否不带检查点继续？',
    })
    expect(
      within(article)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['允许一次', '拒绝'])
  })

  it('keeps the card and shows the error when resolving fails', async () => {
    const { open, store } = setup([approval('a1')], () => {
      throw new RpcError('approval.not_found')
    })
    await open()
    const article = await screen.findByRole('article')
    await userEvent.click(within(article).getByRole('button', { name: '允许一次' }))
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'approval.not_found' }))
  })

  it('reloads pending approvals when the active session is notified', async () => {
    const { open, notify, setPending } = setup([])
    await open()
    expect(await screen.findByRole('heading', { level: 2, name: '审批' })).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    setPending([approval('a1')])
    notify('other')
    await Promise.resolve()
    expect(screen.queryByRole('article')).toBeNull()
    notify('s1')
    expect(await screen.findByRole('article')).toBeTruthy()
  })
})
