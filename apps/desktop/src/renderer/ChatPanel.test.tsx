// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n, type Locale } from '@cairn/i18n'
import { RpcError, type EventEnvelope, type SessionSummary } from '@cairn/protocol'
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
    await userEvent.click(within(item!).getAllByRole('button')[0]!)
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
    await userEvent.click(within(item!).getAllByRole('button')[0]!)
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
      '助手思考过程想想好的，\n你好！[图片]read_file {} 等待执行',
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

    emit(userMessage(9, 'm3', '第一行\n第二行'), ev(10, 'turn.started', {}, 't2'))
    expect(messages().at(-1)).toBe('你第一行\n第二行')
    emit(ev(11, 'turn.completed', { durationMs: 10 }, 't2'))

    await userEvent.type(input(), '  再来  ')
    await userEvent.click(sendButton())
    expect(request).toHaveBeenLastCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('再来'),
    })
  })

  it('shows the turn as running between sending and turn.started', async () => {
    const { request, store, open, emit } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    // 排队或宿主启动中：还没有 turn.started
    expect(runStatus()).toBe('运行中')
    expect(stopButton()).toBeTruthy()
    await userEvent.type(input(), '下一句')
    expect(sendButton().disabled).toBe(true)
    expect(store.getState().sessions[0]?.status).toBe('running')
    // 刷新列表时同样保留
    await act(() => store.getState().refreshSessions())
    expect(store.getState().sessions[0]?.status).toBe('running')
    // 中途的其他事件不清除等待
    emit(userMessage(9, 'm3', '你好'))
    expect(runStatus()).toBe('运行中')

    emit(ev(10, 'turn.started', {}, 't2'), state(11, 'completed', 'thinking'))
    expect(runStatus()).toBe('运行中 · 思考中')
    expect(store.getState().awaitingTurn).toEqual({})
    emit(ev(12, 'turn.completed', { durationMs: 10 }, 't2'), state(13, 'thinking', 'completed'))
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
    expect(request.mock.calls.filter(([m]) => m === 'session.prompt')).toHaveLength(1)
  })

  it('cancels a queued prompt with the stop button', async () => {
    const { request, store, open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    await userEvent.click(stopButton()!)
    expect(request).toHaveBeenCalledWith('session.abort', { sessionId: 's1' })
    // 取消排队中的输入不会产生事件，由停止成功清除等待
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
    expect(store.getState().sessions[0]?.status).toBe('idle')
  })

  it('keeps waiting when stopping fails', async () => {
    const { store, open } = setup({
      history: HISTORY,
      handlers: {
        'session.abort': () => {
          throw new RpcError('rpc.timeout', { timeoutMs: 1 })
        },
      },
    })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    await userEvent.click(stopButton()!)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(runStatus()).toBe('运行中')
    expect(store.getState().awaitingTurn).toEqual({ s1: true })
  })

  it('ignores Enter while sending and keeps a newer draft when sending fails', async () => {
    let fail!: () => void
    const { request, open } = setup({
      history: HISTORY,
      handlers: {
        'session.prompt': () =>
          new Promise((_resolve, reject) => (fail = () => reject(new RpcError('run.busy')))),
      },
    })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    await userEvent.type(input(), '新的{Enter}')
    expect(request.mock.calls.filter(([m]) => m === 'session.prompt')).toHaveLength(1)
    await act(async () => fail())
    expect(input().value).toBe('新的')
    // 发送失败后不再等待
    expect(runStatus()).toBe('空闲')
    expect(sendButton().disabled).toBe(false)
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

    emit(
      ev(
        13,
        'message.assistant.completed',
        { messageId: 'm4', content: text('说到'), model, incomplete: true },
        't2',
      ),
      ev(14, 'turn.aborted', { reason: 'user' }, 't2'),
      state(15, 'aborting', 'idle'),
    )
    expect(runStatus()).toBe('空闲')
    expect(stopButton()).toBeNull()
    expect(screen.getByText('已停止')).toBeTruthy()
    // 已输出的部分保留，并注明未完成
    expect(messages().at(-1)).toBe('助手说到（回复未完成）')
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
      '工具连续失败',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxConsecutiveToolErrors', value: 5 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '失败',
      '工具调用连续失败 5 次，本轮已停止，可以继续执行。',
    ],
    [
      '单轮时长',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxTurnDurationMs', value: 600_000 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '失败',
      '本轮已运行超过 10 分钟，可以继续执行。',
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
    [
      '应用退出后中断',
      [
        ev(12, 'turn.aborted', { reason: 'shutdown' }, 't2'),
        ev(13, 'run.state.changed', { from: 'thinking', to: 'interrupted', reason: 'app_restart' }),
      ],
      '已中断',
      '本轮已中断，可以继续对话。',
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

  it('shows that a failed model request is being retried', async () => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    const retry = {
      attempt: 1,
      maxRetries: 3,
      delayMs: 1500,
      error: { code: 'model.rate_limited' },
    }
    emit(ev(12, 'model.retry', retry, 't2'))
    const note = '模型请求失败（请求过于频繁，已被模型服务限流），2 秒后重试（第 1/3 次）'
    expect(screen.getByText(note)).toBeTruthy()
    expect(stopButton()).toBeTruthy()
    emit({ ...ev(13, 'step.started', { model }, 't2'), stepId: 'st2' } as EventEnvelope)
    expect(screen.queryByText(note)).toBeNull()
  })

  it('falls back to defaults for a session missing from the list', async () => {
    const { store } = setup({
      handlers: {
        'session.list': () => ({ sessions: [] }),
        'session.subscribe': () => new Promise(() => {}),
      },
    })
    await act(async () => void store.getState().selectSession('s1'))
    expect(screen.getByRole('heading', { level: 2, name: '未命名会话' })).toBeTruthy()
    expect(runStatus()).toBe('空闲')
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

describe('tool calls and undo turn', () => {
  const call = { id: 'c1', name: 'run_command', input: { command: 'npm   test' } }
  const toolTurn = (...tail: EventEnvelope[]): EventEnvelope[] => [
    created('工具'),
    runCreated(2),
    userMessage(3, 'm1', '跑测试'),
    ev(4, 'turn.started', {}),
    state(5, 'idle', 'thinking'),
    completed(6, 'm2', '', { toolCalls: [call] }),
    ev(7, 'tool.requested', { toolCallId: 'c1', name: 'run_command', input: call.input }),
    ev(8, 'tool.started', { toolCallId: 'c1' }),
    ...tail,
  ]
  const card = () => screen.getByRole('region', { name: '调用工具：run_command' })
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

  it('shows the tool name, argument summary, status and the first output lines', async () => {
    const { open } = setup({
      history: toolTurn(
        ev(9, 'tool.completed', {
          toolCallId: 'c1',
          output: text(lines(8)),
          truncated: true,
          durationMs: 5,
        }),
      ),
    })
    await open()
    expect(card().textContent).toContain('run_command npm test 完成')
    expect(within(card()).getByText(/line 1/).textContent).toBe(lines(5))
    expect(within(card()).getByText('……还有 3 行')).toBeTruthy()
    expect(within(card()).getByText('（输出过长，交给模型时已截断）')).toBeTruthy()
  })

  it('shows the last live output lines while running and the error when failed', async () => {
    const { open, emit } = setup({ history: toolTurn() })
    await open()
    expect(card().textContent).toContain('执行中')
    emit({
      ...ev(9, 'tool.output.delta', { toolCallId: 'c1', stream: 'stdout', text: lines(7) }),
    })
    expect(within(card()).getByText(/line 7/).textContent).toBe(
      ['line 3', 'line 4', 'line 5', 'line 6', 'line 7'].join('\n'),
    )
    expect(within(card()).getByText('……前面还有 2 行')).toBeTruthy()
    emit(ev(9, 'tool.failed', { toolCallId: 'c1', error: { code: 'tool.denied' } }))
    expect(card().textContent).toContain('失败')
    expect(within(card()).getByRole('note').textContent).not.toBe('')
  })

  const CHECKPOINT = 'a'.repeat(40)
  const finished = (...tail: EventEnvelope[]) =>
    toolTurn(
      ev(9, 'tool.completed', { toolCallId: 'c1', output: text('ok'), durationMs: 5 }),
      completed(10, 'm3', '完成'),
      ev(11, 'turn.completed', { durationMs: 10 }),
      state(12, 'tooling', 'completed'),
      ...tail,
    )
  const listed = (turnId = 't1') => ({
    checkpoints: [
      { checkpointId: CHECKPOINT, reason: 'turn_start', seq: 4, runId: 'r1', turnId, createdAt: 1 },
    ],
  })

  it('undoes the turn after showing the files to restore', async () => {
    const plan = {
      before: 'b'.repeat(40),
      files: [
        { path: 'src/new.ts', status: 'deleted' },
        { path: 'src/app.ts', status: 'modified' },
      ],
    }
    const { open, request } = setup({
      history: finished(),
      handlers: {
        'checkpoint.list': () => listed(),
        'checkpoint.preview': () => plan,
        'checkpoint.restore': () => plan,
      },
    })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    const dialog = await screen.findByRole('alertdialog', { name: '撤销本轮' })
    expect(
      within(within(dialog).getByRole('list', { name: '将恢复的文件' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['删除 src/new.ts', '还原 src/app.ts'])
    expect(request).not.toHaveBeenCalledWith('checkpoint.restore', expect.anything())

    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认撤销' }))
    expect(await screen.findByText('已撤销本轮，恢复了 2 个文件。')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('checkpoint.restore', {
      sessionId: 's1',
      checkpointId: CHECKPOINT,
    })
  })

  it('cannot confirm when the turn changed no files', async () => {
    const { open } = setup({
      history: finished(),
      handlers: {
        'checkpoint.list': () => listed(),
        'checkpoint.preview': () => ({ before: CHECKPOINT, files: [] }),
      },
    })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    expect(await screen.findByText('本轮没有改动文件，无需撤销。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '确认撤销' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('reports a missing turn checkpoint or a failed restore', async () => {
    let turnId = 'other'
    const { open, store } = setup({
      history: finished(),
      handlers: {
        'checkpoint.list': () => listed(turnId),
        'checkpoint.preview': () => ({
          before: CHECKPOINT,
          files: [{ path: 'a', status: 'added' }],
        }),
        'checkpoint.restore': () => {
          throw new RpcError('run.busy')
        },
      },
    })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'checkpoint.not_found' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    turnId = 't1'
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认撤销' }))
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'run.busy' }))
    expect(screen.getByRole('button', { name: '撤销本轮' })).toBeTruthy()
  })

  it('hides undo while the turn is running', async () => {
    const { open } = setup({ history: RUNNING })
    await open()
    expect(screen.queryByRole('button', { name: '撤销本轮' })).toBeNull()
  })
})
