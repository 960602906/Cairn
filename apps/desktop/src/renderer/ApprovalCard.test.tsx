// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type EventEnvelope, type PendingApproval } from '@cairn/protocol'
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
    await userEvent.click(within(item!).getAllByRole('button')[0]!)
  }
  const notify = (sessionId: string) => act(() => listeners.forEach((l) => l({ sessionId })))
  const setPending = (next: PendingApproval[]) => (pending = next)
  return { request, store, open, notify, setPending }
}

const card = (name: string) => screen.getByRole('article', { name })

const option = (article: HTMLElement, name: RegExp) => within(article).getByRole('button', { name })

describe('ApprovalList', () => {
  it('asks a question with the command, the reason and three numbered options', async () => {
    const { request, open } = setup([approval('a1')])
    await open()
    const article = await screen.findByRole('article', { name: '需要审批：run_command' })
    expect(within(article).getByRole('heading', { name: '要运行这条命令吗？' })).toBeTruthy()
    expect(within(article).getByText('原因: 这类操作默认需要审批')).toBeTruthy()
    expect(within(article).getByText('npm test')).toBeTruthy()
    expect(
      within(within(article).getByRole('list', { name: '选项' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      '1运行一次Enter',
      '2运行，并且以后同类命令不再询问仅此项目',
      '3不运行，告诉 Agent 换个做法Esc',
    ])
    await userEvent.click(option(article, /以后同类命令不再询问/))
    expect(request).toHaveBeenCalledWith('approval.resolve', {
      sessionId: 's1',
      approvalId: 'a1',
      decision: 'allow_project',
    })
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
  })

  it('denies with feedback; shows diffs, paths, inputs and unknown reasons', async () => {
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
      approval('a3', {
        tool: { name: 'edit_file', category: 'write' },
        targets: { paths: ['src/a.ts', 'src/b.ts'] },
        preview: undefined,
      }),
    ])
    await open()
    await screen.findAllByRole('article')
    const write = card('需要审批：write_file')
    expect(within(write).getByRole('heading', { name: '要修改这些文件吗？' })).toBeTruthy()
    expect(within(write).getByText('+hello')).toBeTruthy()
    expect(within(write).getByText('Write a.ts')).toBeTruthy()
    expect(within(write).getByText(/涉及敏感文件/)).toBeTruthy()
    expect(option(write, /^允许一次$/)).toBeTruthy()
    const other = card('需要审批：mcp_tool')
    expect(within(other).getByRole('heading', { name: '要执行这个操作吗？' })).toBeTruthy()
    expect(within(other).getByText(/https:\/\/example.com/)).toBeTruthy()
    expect(within(other).getByText('原因: 需要审批')).toBeTruthy()
    const edit = card('需要审批：edit_file')
    expect(within(edit).getByText('src/b.ts')).toBeTruthy()

    await userEvent.click(option(write, /不允许，告诉 Agent/))
    const field = within(write).getByLabelText('告诉 Agent 怎么做（可选）')
    expect(document.activeElement).toBe(field)
    await userEvent.type(field, '  改用 b.ts  ')
    await userEvent.click(within(write).getByRole('button', { name: '提交' }))
    expect(request).toHaveBeenCalledWith('approval.resolve', {
      sessionId: 's1',
      approvalId: 'a1',
      decision: 'deny',
      feedback: '改用 b.ts',
    })
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2))
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
    const article = await screen.findByRole('article', { name: '需要审批：run_command' })
    expect(
      within(article).getByRole('heading', { name: '无法创建检查点，仍要继续吗？' }),
    ).toBeTruthy()
    expect(
      within(within(article).getByRole('list', { name: '选项' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['1不带检查点继续一次Enter', '3不继续，告诉 Agent 换个做法Esc'])
    // 没有“以后不再询问”，数字键 2 不起作用
    await userEvent.keyboard('2')
    expect(screen.getByRole('article')).toBeTruthy()
  })

  it('keeps the card and shows the error when resolving fails', async () => {
    const { open, store } = setup([approval('a1')], () => {
      throw new RpcError('approval.not_found')
    })
    await open()
    const article = await screen.findByRole('article')
    await userEvent.click(option(article, /^运行一次$/))
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'approval.not_found' }))
    expect(screen.getByRole('article')).toBeTruthy()
  })

  describe('keyboard', () => {
    const decided = (
      request: ReturnType<typeof setup>['request'],
      approvalId: string,
      decision: string,
      feedback?: string,
    ) =>
      expect(request).toHaveBeenCalledWith('approval.resolve', {
        sessionId: 's1',
        approvalId,
        decision,
        ...(feedback === undefined ? {} : { feedback }),
      })

    it('chooses with 1, Enter and 2, oldest card first', async () => {
      const { request, open } = setup([approval('a1'), approval('a2'), approval('a3')])
      await open()
      await screen.findAllByRole('article')
      await userEvent.keyboard('1')
      decided(request, 'a1', 'allow_once')
      await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2))
      await userEvent.keyboard('{Enter}')
      decided(request, 'a2', 'allow_once')
      await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1))
      await userEvent.keyboard('2')
      decided(request, 'a3', 'allow_project')
      await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    })

    it('denies with Esc, or with 3 and feedback submitted by Enter', async () => {
      const { request, open } = setup([approval('a1'), approval('a2')])
      await open()
      await screen.findAllByRole('article')
      await userEvent.keyboard('{Escape}')
      decided(request, 'a1', 'deny')
      await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1))
      await userEvent.keyboard('3')
      const field = screen.getByLabelText('告诉 Agent 怎么做（可选）')
      expect(document.activeElement).toBe(field)
      // 在说明框里打数字不会选择选项
      await userEvent.type(field, '用 2 个空格{Enter}')
      decided(request, 'a2', 'deny', '用 2 个空格')
    })

    it('ignores keys while typing elsewhere or when a dialog is open', async () => {
      const { request, open } = setup([approval('a1')])
      await open()
      await screen.findByRole('article')
      const input = screen.getByLabelText('输入消息')
      await userEvent.type(input, 'x1{Enter}')
      expect(request).not.toHaveBeenCalledWith('approval.resolve', expect.anything())
      await userEvent.clear(input)
      await userEvent.keyboard('{Control>}1{/Control}')
      expect(request).not.toHaveBeenCalledWith('approval.resolve', expect.anything())
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      await userEvent.keyboard('1')
      dialog.remove()
      expect(request).not.toHaveBeenCalledWith('approval.resolve', expect.anything())
    })
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
