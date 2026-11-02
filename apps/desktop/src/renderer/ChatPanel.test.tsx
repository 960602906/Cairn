// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n, type Locale } from '@nexus/i18n'
import { RpcError, type EventEnvelope, type SessionSummary } from '@nexus/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

type Listener = (data: { sessionId: string; events: EventEnvelope[] }) => void

const summary = (title: string, status: SessionSummary['status'] = 'idle'): SessionSummary => ({
  sessionId: 's1',
  title,
  projectPath: '/work',
  status,
  createdAt: 1,
  updatedAt: 1,
})

const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

const ev = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
  ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope

const created = (title: string) =>
  ev(1, 'session.created', { projectId: 'p1', projectPath: '/work', workspacePath: '/work', title })
const runCreated = (seq: number) =>
  ev(seq, 'run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits })
const state = (seq: number, from: string, to: string) => ev(seq, 'run.state.changed', { from, to })
const userMessage = (seq: number, messageId: string, t: string) =>
  ev(seq, 'message.user', { messageId, content: text(t) })
const completed = (seq: number, messageId: string, t: string, extra: object = {}) =>
  ev(seq, 'message.assistant.completed', { messageId, content: text(t), model, ...extra })

/** 一轮完整对话：用户“你好”，助手“你好！” */
const HISTORY: EventEnvelope[] = [
  created('修复登录'),
  runCreated(2),
  userMessage(3, 'm1', '你好'),
  ev(4, 'turn.started', {}),
  state(5, 'idle', 'thinking'),
  completed(6, 'm2', '你好！'),
  ev(7, 'turn.completed', { durationMs: 10 }),
  state(8, 'thinking', 'completed'),
]

/** 正在进行第二轮。 */
const RUNNING: EventEnvelope[] = [
  ...HISTORY,
  userMessage(9, 'm3', '再说一次'),
  ev(10, 'turn.started', {}, 't2'),
  state(11, 'completed', 'thinking'),
]

function setup({
  history = [] as EventEnvelope[],
  title = '修复登录',
  status = 'idle' as SessionSummary['status'],
  locale = 'zh-CN' as Locale,
  handlers = {} as Record<string, (params: never) => unknown>,
} = {}) {
  const listeners = new Set<Listener>()
  const request = vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method]
    if (handler) return handler(params as never)
    if (method === 'session.list') return { sessions: [summary(title, status)] }
    if (method === 'session.subscribe') return { events: history, lastSeq: history.length }
    return {}
  })
  const api = {
    ready: () => Promise.resolve(),
    request,
    on: (_name: string, listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n(locale)} store={store} />)
  const emit = (...events: EventEnvelope[]) =>
    act(() => listeners.forEach((l) => l({ sessionId: 's1', events })))
  const open = async () => {
    const [item] = await screen.findAllByRole('listitem')
    await userEvent.click(within(item!).getByRole('button'))
    await waitFor(() => expect(store.getState().views.s1).toBeDefined())
  }
  return { request, store, emit, open }
}

const messages = () =>
  within(screen.getByRole('list', { name: '消息' }))
    .queryAllByRole('listitem')
    .map((li) => li.textContent)
const runStatus = () => screen.getByRole('status').textContent
const input = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: '发送' }) as HTMLButtonElement
const stopButton = () => screen.queryByRole('button', { name: '停止' }) as HTMLButtonElement | null

describe('ChatPanel', () => {
  it('asks to pick a session when none is selected', async () => {
    setup()
    expect(await screen.findByText('选择或新建一个会话开始对话')).toBeTruthy()
    expect(screen.queryByLabelText('输入消息')).toBeNull()
  })

  it('shows the replayed history of the selected session', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    expect(request).toHaveBeenCalledWith('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    expect(screen.getByRole('heading', { level: 2, name: '修复登录' })).toBeTruthy()
    expect(messages()).toEqual(['你你好', '助手你好！'])
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
  })

  it('uses the list entry until the subscription returns', async () => {
    let replay!: (value: { events: EventEnvelope[]; lastSeq: number }) => void
    const { store } = setup({
      title: '',
      status: 'running',
      handlers: { 'session.subscribe': () => new Promise((resolve) => (replay = resolve)) },
    })
    const [item] = await screen.findAllByRole('listitem')
    await userEvent.click(within(item!).getByRole('button'))
    expect(screen.getByRole('heading', { level: 2, name: '未命名会话' })).toBeTruthy()
    expect(runStatus()).toBe('运行中')
    expect(messages()).toEqual([])

    await act(async () => replay({ events: [created('新标题')], lastSeq: 1 }))
    expect(store.getState().views.s1?.lastSeq).toBe(1)
    expect(screen.getByRole('heading', { level: 2, name: '新标题' })).toBeTruthy()
    expect(runStatus()).toBe('空闲')
  })

  it('streams the live reply and replaces it with the completed message once', async () => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    expect(runStatus()).toBe('运行中 · 思考中')
    expect(sendButton().disabled).toBe(true)
    expect(stopButton()).toBeTruthy()

    emit(
      ev(12, 'message.reasoning.delta', { messageId: 'm4', text: '想想' }, 't2'),
      ev(13, 'message.assistant.delta', { messageId: 'm4', text: '好的' }, 't2'),
      ev(14, 'message.assistant.delta', { messageId: 'm4', text: '，' }, 't2'),
    )
    const live = screen.getAllByRole('listitem').at(-1)!
    expect(live.getAttribute('aria-busy')).toBe('true')
    expect(live.textContent).toBe('助手思考过程想想好的，')

    emit(state(15, 'thinking', 'tooling'))
    expect(runStatus()).toBe('运行中 · 正在调用工具')

    const done = ev(
      17,
      'message.assistant.completed',
      {
        messageId: 'm4',
        content: [
          ...text('好的，\n你好！'),
          { type: 'image', blobRef: 'b1', mimeType: 'image/png' },
        ],
        reasoning: { text: '想想', providerId: 'fake' },
        toolCalls: [{ id: 'c1', name: 'read_file', input: {} }],
        model,
      },
      't2',
    )
    emit(
      state(16, 'tooling', 'thinking'),
      done,
      ev(18, 'turn.completed', { durationMs: 10 }, 't2'),
      state(19, 'thinking', 'completed'),
    )
    // 补发与实时重叠：重复的事件被忽略
    emit(done)
    expect(messages()).toEqual([
      '你你好',
      '助手你好！',
      '你再说一次',
      '助手思考过程想想好的，\n你好！[图片]调用工具：read_file',
    ])
    expect(screen.queryByRole('listitem', { busy: true })).toBeNull()
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
  })

  it('sends with Enter, keeps Shift+Enter and composition for editing', async () => {
    const { request, open, emit } = setup({ history: HISTORY })
    await open()
    expect(sendButton().disabled).toBe(true)

    await userEvent.type(input(), '第一行{Shift>}{Enter}{/Shift}第二行')
    expect(input().value).toBe('第一行\n第二行')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())

    await userEvent.type(input(), '{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('第一行\n第二行'),
    })
    expect(input().value).toBe('')

    emit(userMessage(9, 'm3', '第一行\n第二行'))
    expect(messages().at(-1)).toBe('你第一行\n第二行')

    await userEvent.type(input(), '  再来  ')
    await userEvent.click(sendButton())
    expect(request).toHaveBeenLastCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('再来'),
    })
  })

  it('restores the draft and shows the error when sending fails', async () => {
    const { request, open } = setup({
      history: HISTORY,
      handlers: {
        'session.prompt': () => {
          throw new RpcError('run.busy', { sessionId: 's1' })
        },
      },
    })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    expect((await screen.findByRole('alert')).textContent).toContain('当前运行正忙，请稍后再试')
    expect(request).toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(input().value).toBe('你好')
  })

  it('stops the running turn', async () => {
    let finishAbort!: () => void
    const { request, open, emit } = setup({
      history: RUNNING,
      handlers: { 'session.abort': () => new Promise<object>((r) => (finishAbort = () => r({}))) },
    })
    await open()
    await userEvent.click(stopButton()!)
    expect(request).toHaveBeenCalledWith('session.abort', { sessionId: 's1' })
    expect(stopButton()!.disabled).toBe(true)
    await act(async () => finishAbort())
    expect(stopButton()!.disabled).toBe(false)

    emit(state(12, 'thinking', 'aborting'))
    expect(runStatus()).toBe('运行中 · 正在停止')
    expect(stopButton()!.disabled).toBe(true)

    emit(ev(13, 'turn.aborted', { reason: 'user' }, 't2'), state(14, 'aborting', 'idle'))
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
    expect(screen.getByText('已停止')).toBeTruthy()
  })

  it.each([
    [
      '达到步数限额',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 50 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '失败',
      '已达到本轮最多 50 步，可以继续执行。',
    ],
    [
      '模型失败',
      [
        ev(12, 'turn.failed', { error: { code: 'model.unknown_error' }, retryable: false }, 't2'),
        state(13, 'thinking', 'failed'),
      ],
      '失败',
      '本轮失败：模型请求失败',
    ],
    [
      '宿主崩溃',
      [ev(12, 'session.crashed', { error: { code: 'host.exited' } })],
      '已崩溃',
      'Agent 进程意外退出，可以从最后保存的位置继续。',
    ],
  ])('explains how the last turn ended: %s', async (_name, events, status, note) => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    emit(...events)
    expect(runStatus()).toBe(status)
    expect(screen.getByText(note)).toBeTruthy()
    expect(stopButton()).toBeNull()
    expect(sendButton().disabled).toBe(true)
    await userEvent.type(input(), '继续')
    expect(sendButton().disabled).toBe(false)
  })

  it('uses the current language', async () => {
    const { open } = setup({ history: RUNNING, locale: 'en-US' })
    await open()
    expect(screen.getByRole('status').textContent).toBe('Running · Thinking')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe(
      'Type a message. Enter to send, Shift+Enter for a new line',
    )
  })
})
