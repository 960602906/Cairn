// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, reduceSessionEvents, type SessionView } from '@cairn/core'
import type { EventEnvelope } from '@cairn/protocol'
import { createI18n } from '@cairn/i18n'
import { I18nextProvider } from 'react-i18next'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { Markdown } from './Markdown.js'
import { MessageStream, turnFooters } from './MessageStream.js'

afterEach(cleanup)

const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

const ev = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
  ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope

const view = (events: EventEnvelope[]) => reduceSessionEvents(createSessionView('s1'), events)

const START: EventEnvelope[] = [
  ev(1, 'session.created', { projectId: 'p1', projectPath: '/w', workspacePath: '/w', title: 'x' }),
  ev(2, 'run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
  ev(3, 'message.user', { messageId: 'u1', content: text('你好') }),
  ev(4, 'turn.started', {}),
]

describe('turnFooters（M2-03）', () => {
  it('本轮结束后在最后一条助手消息下汇总本轮文本与 token 数', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('第一段'), model }),
        ev(6, 'usage.reported', { model, usage: { inputTokens: 100, outputTokens: 20 } }),
        ev(7, 'message.assistant.completed', { messageId: 'a2', content: text('第二段'), model }),
        ev(8, 'usage.reported', { model, usage: { inputTokens: 200, outputTokens: 30 } }),
        ev(9, 'turn.completed', { durationMs: 10 }),
      ]),
    )
    expect([...footers.keys()]).toEqual(['a2'])
    expect(footers.get('a2')).toEqual({ text: '第一段\n\n第二段', model, tokens: 350 })
  })

  it('进行中的一轮没有轮次操作', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('先看看'), model }),
      ]),
    )
    expect(footers.size).toBe(0)
  })

  it('没有用量时 token 数为 undefined；每轮各有一个', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('一'), model }),
        ev(6, 'turn.completed', { durationMs: 10 }),
        ev(7, 'message.user', { messageId: 'u2', content: text('再来') }, 't2'),
        ev(8, 'turn.started', {}, 't2'),
        ev(9, 'message.assistant.completed', { messageId: 'a2', content: text('二'), model }, 't2'),
        ev(10, 'usage.reported', { model, usage: { inputTokens: 1, outputTokens: 2 } }, 't2'),
        ev(11, 'turn.completed', { durationMs: 10 }, 't2'),
      ]),
    )
    expect(footers.get('a1')).toEqual({ text: '一', model, tokens: undefined })
    expect(footers.get('a2')).toEqual({ text: '二', model, tokens: 3 })
  })
})

describe('Markdown（M2-03）', () => {
  it('渲染 GFM：标题、列表、表格与行内代码', () => {
    render(
      <Markdown
        text={'# 标题\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n用 `pnpm test`'}
      />,
    )
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByText('pnpm test').tagName).toBe('CODE')
  })

  it('不渲染原始 HTML，去掉 javascript: 链接', () => {
    const { container } = render(
      <Markdown
        text={
          '<img src=x onerror="alert(1)">\n\n[点我](javascript:alert(1)) [官网](https://example.com)'
        }
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    const bad = screen.getByText('点我')
    expect(bad.getAttribute('href') ?? '').not.toContain('javascript')
    const good = screen.getByRole('link', { name: '官网' })
    expect(good.getAttribute('href')).toBe('https://example.com')
    expect(good.getAttribute('target')).toBe('_blank')
    expect(good.getAttribute('rel')).toBe('noreferrer')
  })
})

describe('MessageStream 渲染', () => {
  const plan = {
    planId: 'pl2',
    content: {
      goal: '验证',
      files: [],
      steps: [{ id: 'one', title: '一步' }],
      risks: '',
      verification: '',
      markdown: '',
    },
    steps: [{ id: 'one', title: '一步', status: 'pending' }],
    status: 'proposed',
    seq: 8,
    runId: 'r1',
  }

  const rich = {
    sessionId: 's1',
    lastSeq: 20,
    info: undefined,
    archived: false,
    crash: undefined,
    runs: {
      r1: {
        runId: 'r1',
        parentRunId: undefined,
        turn: {
          turnId: 't1',
          status: 'failed',
          limitReached: { limit: 'maxTurnDurationMs', value: 120_000 },
        },
      },
    },
    runOrder: ['r1'],
    messages: [
      {
        messageId: 'u1',
        role: 'user',
        runId: 'r1',
        turnId: 't1',
        seq: 2,
        ts: 1,
        content: [
          { type: 'text', text: '你好' },
          { type: 'image', data: '', mediaType: 'image/png' },
        ],
      },
      {
        messageId: 'a1',
        role: 'assistant',
        runId: 'r1',
        turnId: 't1',
        seq: 3,
        ts: 2,
        content: [{ type: 'text', text: '完成' }],
        reasoning: { type: 'text', text: '想一想' },
        toolCalls: [],
        model,
        incomplete: true,
      },
    ],
    live: {
      l1: {
        messageId: 'l1',
        runId: 'r1',
        turnId: 't1',
        text: '',
        reasoning: '正在思考',
        lastDeltaSeq: 5,
        startedAt: 3,
      },
    },
    tools: {},
    liveToolOutput: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    usageByTurn: { t1: { inputTokens: 1, outputTokens: 2 } },
    contextTokens: undefined,
    checkpoints: [
      { checkpointId: 'c1', reason: 'turn', seq: 1, runId: 'r1', turnId: 't1', createdAt: 1 },
    ],
    restores: [{ checkpointId: 'c1', seq: 4, ts: 3 }],
    compaction: { summary: '压缩摘要', seq: 19 },
    toolOutputOmitted: { seq: 20 },
    plans: [plan, { ...plan, planId: 'pl3', turnId: 't1', seq: 9 }],
  } as unknown as SessionView

  it('renders messages, reasoning, marks, plans and a limit outcome', async () => {
    const sendPrompt = vi.fn(async () => true)
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      settings: { providers: [] },
      sendPrompt,
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={rich} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.getByText('想一想')).toBeTruthy()
    expect(screen.getByText('正在思考')).toBeTruthy()
    expect(screen.getByText('完成')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /较早的对话已压缩/ }))
    expect(screen.getByText('压缩摘要')).toBeTruthy()
    expect(screen.getAllByText(/分钟/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /继续/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(sendPrompt).toHaveBeenCalled()
  })

  it('renders the empty stream without a view', () => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      approvals: {},
      settings: undefined,
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={undefined} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.getByRole('list', { name: '消息' })).toBeTruthy()
  })
})

describe('MessageStream Agent 标记', () => {
  const agent = (id: string, version: number) => ({ id, version })
  const assistant = (
    messageId: string,
    runId: string,
    turnId: string,
    seq: number,
    extra: object = {},
  ) => ({
    messageId,
    role: 'assistant' as const,
    runId,
    turnId,
    seq,
    ts: seq,
    content: [{ type: 'text' as const, text: messageId }],
    toolCalls: [],
    model,
    ...extra,
  })
  const user = (messageId: string, runId: string, turnId: string, seq: number) => ({
    messageId,
    role: 'user' as const,
    runId,
    turnId,
    seq,
    ts: seq,
    content: [{ type: 'text' as const, text: messageId }],
  })

  const base = {
    sessionId: 's1',
    lastSeq: 20,
    info: undefined,
    archived: false,
    crash: undefined,
    tools: {},
    liveToolOutput: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    usageByTurn: {},
    contextTokens: undefined,
    checkpoints: [],
    restores: [],
    compaction: undefined,
    toolOutputOmitted: undefined,
    plans: [],
  }

  const multiRun = {
    ...base,
    runs: {
      r1: { runId: 'r1', agent: agent('builtin.coder', 1) },
      r2: { runId: 'r2', agent: agent('user.custom', 3) },
      r3: { runId: 'r3', agent: agent('user.unknown', 1) },
    },
    runOrder: ['r1', 'r2'],
    messages: [
      user('u1', 'r1', 't1', 1),
      assistant('a1', 'r1', 't1', 2),
      user('u2', 'r2', 't2', 3),
      assistant('a2', 'r2', 't2', 4),
    ],
    live: {},
  } as unknown as SessionView

  const store = (agents: unknown[] = []) =>
    createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      settings: { providers: [] },
      agents,
      changes: {},
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore

  const renderStream = (view: SessionView, agents: unknown[] = []) =>
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store(agents)}>
          <MessageStream view={view} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

  it('renders an agent badge and a switch divider for the second run', () => {
    renderStream(multiRun, [
      {
        agentId: 'user.custom',
        name: { 'zh-CN': '自定义助手' },
        description: {},
        version: 3,
        status: 'published',
        source: 'user',
        archived: false,
        hasDraft: false,
        modelMode: 'inherit',
        updatedAt: 1,
      },
    ])
    expect(screen.getByText('编程助手')).toBeDefined()
    expect(screen.getAllByText('自定义助手').length).toBeGreaterThan(0)
    expect(screen.getByText('已切换到 自定义助手 v3')).toBeDefined()
  })

  it('falls back to the agent id when no summary exists', () => {
    renderStream(multiRun, [])
    expect(screen.getByText('已切换到 user.custom v3')).toBeDefined()
    expect(screen.getByText('user.custom')).toBeDefined()
  })

  it('shows a switch divider before a live message from a later run', () => {
    const live = {
      ...multiRun,
      runOrder: ['r1', 'r3'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      live: {
        l3: {
          messageId: 'l3',
          runId: 'r3',
          turnId: 't3',
          text: '',
          reasoning: 'thinking',
          lastDeltaSeq: 5,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    renderStream(live, [])
    expect(screen.getByText('已切换到 user.unknown v1')).toBeDefined()
    expect(screen.getByText('user.unknown')).toBeDefined()
  })

  it('renders a footer without turn tokens when the turn is unknown', () => {
    const view = {
      ...base,
      runs: { r1: { runId: 'r1', agent: agent('builtin.coder', 1) } },
      runOrder: ['r1'],
      messages: [
        user('u1', 'r1', 't1', 1),
        assistant('a1', 'r1', undefined as unknown as string, 2),
      ],
      live: {},
    } as unknown as SessionView
    renderStream(view, [])
    expect(screen.getByText('a1')).toBeDefined()
  })

  it('shows compaction and omission marks between messages and after the last one', () => {
    const view = {
      ...multiRun,
      messages: [
        user('u1', 'r1', 't1', 1),
        assistant('a1', 'r1', 't1', 2),
        assistant('a2', 'r1', 't1', 5),
      ],
      compaction: { summary: '摘要', seq: 3 },
      toolOutputOmitted: { seq: 6 },
    } as unknown as SessionView
    renderStream(view, [])
    expect(screen.getByRole('button', { name: /较早的对话已压缩/ })).toBeDefined()
    expect(screen.getByText('较早的工具输出已省略，以腾出上下文。')).toBeDefined()
  })

  it('renders restore marks under a user message', () => {
    const view = {
      ...multiRun,
      messages: [user('u1', 'r1', 't1', 1)],
      restores: [{ checkpointId: 'c1', seq: 2, ts: 2 }],
      checkpoints: [
        { checkpointId: 'c1', reason: 'turn', seq: 1, runId: 'r1', turnId: 't1', createdAt: 1 },
      ],
    } as unknown as SessionView
    renderStream(view, [])
    expect(screen.getByText('u1')).toBeDefined()
  })

  it('labels a live message with the known agent and a known switched run', () => {
    const agents = [
      {
        agentId: 'user.custom',
        name: { 'zh-CN': '自定义助手' },
        description: {},
        version: 3,
        status: 'published',
        source: 'user',
        archived: false,
        hasDraft: false,
        modelMode: 'inherit',
        updatedAt: 1,
      },
    ]
    const live = {
      ...multiRun,
      runOrder: ['r1', 'r2'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      live: {
        l2: {
          messageId: 'l2',
          runId: 'r2',
          turnId: 't2',
          text: '实时',
          reasoning: '',
          lastDeltaSeq: 5,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    renderStream(live, agents)
    expect(screen.getByText('已切换到 自定义助手 v3')).toBeDefined()
    expect(screen.getByText('实时')).toBeDefined()
  })

  it('falls back to the default agent name for the built-in coder', () => {
    const view = {
      ...multiRun,
      runOrder: ['r1', 'r2'],
      runs: {
        r1: { runId: 'r1', agent: agent('builtin.coder', 1) },
        r2: { runId: 'r2', agent: agent('builtin.coder', 2) },
      },
      messages: [
        user('u1', 'r1', 't1', 1),
        assistant('a1', 'r1', 't1', 2),
        user('u2', 'r2', 't2', 3),
        assistant('a2', 'r2', 't2', 4),
      ],
    } as unknown as SessionView
    renderStream(view, [])
    expect(screen.getByText('已切换到 编程助手 v2')).toBeDefined()
  })

  it('renders both marks between messages and after the last message', () => {
    const between = {
      ...multiRun,
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 4)],
      compaction: { summary: '摘要', seq: 2 },
      toolOutputOmitted: { seq: 3 },
    } as unknown as SessionView
    renderStream(between, [])
    expect(screen.getAllByRole('button', { name: /较早的对话已压缩/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('较早的工具输出已省略，以腾出上下文。').length).toBeGreaterThan(0)
  })

  it('renders trailing marks after the last message', () => {
    const trailing = {
      ...multiRun,
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      compaction: { summary: '摘要', seq: 9 },
      toolOutputOmitted: { seq: 10 },
    } as unknown as SessionView
    renderStream(trailing, [])
    expect(screen.getByRole('button', { name: /较早的对话已压缩/ })).toBeDefined()
    expect(screen.getByText('较早的工具输出已省略，以腾出上下文。')).toBeDefined()
  })

  it('shows a generic failure reason when a turn fails without a limit', () => {
    const failed = {
      ...multiRun,
      runs: {
        r1: {
          runId: 'r1',
          agent: agent('builtin.coder', 1),
          turn: { turnId: 't1', status: 'failed', error: { code: 'provider_error' } },
        },
      },
      runOrder: ['r1'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
    } as unknown as SessionView
    renderStream(failed, [])
    expect(screen.getByText(/失败|错误/)).toBeDefined()
  })

  it('renders a switch divider for a live draft run', () => {
    const live = {
      ...multiRun,
      runs: {
        r1: { runId: 'r1', agent: agent('builtin.coder', 1) },
        r2: { runId: 'r2', agent: { id: 'user.custom', draftHash: 'hash' } },
      },
      runOrder: ['r1', 'r2'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      live: {
        m2: {
          messageId: 'm2',
          runId: 'r2',
          reasoning: '',
          text: 'hi',
          lastDeltaSeq: 3,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    renderStream(live, [
      {
        agentId: 'user.custom',
        name: { 'zh-CN': '自定义助手' },
        description: {},
        version: 1,
        status: 'draft',
        source: 'user',
        archived: false,
        hasDraft: true,
        modelMode: 'inherit',
        updatedAt: 1,
      },
    ])
    expect(screen.getByText('已切换到 自定义助手 草稿')).toBeDefined()
  })

  it('ignores a live switch for an unknown or first run', () => {
    const unknown = {
      ...multiRun,
      runs: { r1: { runId: 'r1', agent: agent('builtin.coder', 1) } },
      runOrder: ['r1', 'r2'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      live: {
        m2: {
          messageId: 'm2',
          runId: 'r2',
          reasoning: '',
          text: 'hi',
          lastDeltaSeq: 3,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    renderStream(unknown, [])
    expect(screen.queryByText(/已切换到/)).toBeNull()

    const first = {
      ...unknown,
      runs: { r1: { runId: 'r1', agent: agent('builtin.coder', 1) } },
      live: {
        m1: {
          messageId: 'm1',
          runId: 'r1',
          reasoning: '',
          text: 'hi',
          lastDeltaSeq: 3,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    renderStream(first, [])
    expect(screen.queryByText(/已切换到/)).toBeNull()
  })
})

describe('MessageStream 试运行（M4-12）', () => {
  const trialEv = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
    ({ ...ev(seq, type, payload, turnId), sessionId: 't1' }) as EventEnvelope

  const renderWith = (
    view: SessionView,
    state: Record<string, unknown>,
    props: { sessionId?: string; onContinue?: (prompt: string) => void } = {},
  ) => {
    const store = createStore<Record<string, unknown>>(() => state) as unknown as SessionStore
    return render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={view} onOpenPlan={vi.fn()} {...props} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
  }

  it('reads approval state from the given trial session', () => {
    const view = reduceSessionEvents(createSessionView('t1'), [
      trialEv(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/w',
        workspacePath: '/w',
        title: '',
      }),
      trialEv(2, 'run.created', {
        agent: { id: 'user.reviewer', draftHash: 'h1' },
        model,
        mode: 'interactive',
        limits,
      }),
      trialEv(3, 'message.user', { messageId: 'u1', content: text('检查') }),
      trialEv(4, 'turn.started', {}),
      trialEv(5, 'message.assistant.completed', {
        messageId: 'a1',
        content: text('执行'),
        model,
        toolCalls: [{ id: 'c1', name: 'run_command', input: { command: 'ls' } }],
      }),
    ])
    renderWith(
      view,
      {
        activeSessionId: 'normal',
        approvals: {
          normal: [],
          t1: [{ toolCallId: 'c1', approvalId: 'a1' }],
        },
        settings: { providers: [] },
        agents: [],
        sendPrompt: vi.fn(),
      },
      { sessionId: 't1' },
    )
    expect(screen.getByText('等待审批')).toBeDefined()
  })

  it('uses the supplied continue action instead of the active session', async () => {
    const view = reduceSessionEvents(createSessionView('t1'), [
      trialEv(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/w',
        workspacePath: '/w',
        title: '',
      }),
      trialEv(2, 'run.created', {
        agent: { id: 'user.reviewer', draftHash: 'h1' },
        model,
        mode: 'interactive',
        limits,
      }),
      trialEv(3, 'message.user', { messageId: 'u1', content: text('检查') }),
      trialEv(4, 'turn.started', {}),
      trialEv(5, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 1 }),
      trialEv(6, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }),
    ])
    const sendPrompt = vi.fn(async () => true)
    const onContinue = vi.fn()
    renderWith(
      view,
      {
        activeSessionId: 'normal',
        approvals: {},
        settings: { providers: [] },
        agents: [],
        sendPrompt,
      },
      { sessionId: 't1', onContinue },
    )
    await userEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(onContinue).toHaveBeenCalledWith(expect.any(String))
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('renders trailing marks when the view has no messages', () => {
    const view = {
      sessionId: 't1',
      messages: [],
      live: {},
      runs: {},
      runOrder: [],
      tools: {},
      liveToolOutput: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      usageByTurn: {},
      contextTokens: undefined,
      checkpoints: [],
      restores: [],
      compaction: { summary: '摘要', seq: 1 },
      toolOutputOmitted: { seq: 2 },
      plans: [],
      delegations: [],
    } as unknown as SessionView
    renderWith(view, {
      activeSessionId: undefined,
      approvals: {},
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })
    expect(screen.getByRole('button', { name: /较早的对话已压缩/ })).toBeTruthy()
    expect(screen.getByText('较早的工具输出已省略，以腾出上下文。')).toBeTruthy()
  })
})
