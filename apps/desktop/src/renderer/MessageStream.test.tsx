// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, reduceSessionEvents, type SessionView } from '@cairn/core'
import type { EventEnvelope } from '@cairn/protocol'
import { createI18n } from '@cairn/i18n'
import { I18nextProvider } from 'react-i18next'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { codeBlockOf, Markdown } from './Markdown.js'
import { fileRefCandidates, parseFileRef } from './file-refs.js'
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
  it('本轮结束后在最后一条助手消息下汇总本轮文本', () => {
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
    expect(footers.get('a2')).toEqual({ text: '第一段\n\n第二段' })
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

  it('每轮各有一个轮次操作，只带这一轮的文本', () => {
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
    expect(footers.get('a1')).toEqual({ text: '一' })
    expect(footers.get('a2')).toEqual({ text: '二' })
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

  it('renders the remaining block elements', () => {
    const { container } = render(
      <Markdown text={'#### 四\n\n##### 五\n\n###### 六\n\n> 引用\n\n---\n\n1. 一\n2. 二'} />,
    )
    expect(screen.getByRole('heading', { level: 4, name: '四' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 5, name: '五' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 6, name: '六' })).toBeTruthy()
    expect(container.querySelector('blockquote')?.textContent).toContain('引用')
    expect(container.querySelector('hr')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('recognises file references in prose and inline code', () => {
    expect(parseFileRef('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parseFileRef('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseFileRef('src/a.ts:12-30')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseFileRef('src/a.ts:0')).toBeUndefined()
    expect(parseFileRef('a.ts:12')).toEqual({ path: 'a.ts', line: 12 })
    expect(parseFileRef('Dockerfile')).toEqual({ path: 'Dockerfile' })
    expect(parseFileRef('/abs/a.ts')).toBeUndefined()
    expect(parseFileRef('./a/b.ts')).toBeUndefined()
    expect(parseFileRef('../a/b.ts')).toBeUndefined()
    expect(parseFileRef('https://a.dev/x')).toBeUndefined()
    expect(parseFileRef('src/a b.ts')).toBeUndefined()
    expect(parseFileRef('pnpm test')).toBeUndefined()
    expect(parseFileRef(`src/${'a'.repeat(4089)}.ts`)).toEqual({
      path: `src/${'a'.repeat(4089)}.ts`,
    })
    expect(parseFileRef(`src/${'a'.repeat(4090)}.ts`)).toBeUndefined()
    expect(
      fileRefCandidates('`src/a.ts` 和 ```ts\nsrc/b.ts\n``` 和 `pnpm test`，见 README.md'),
    ).toEqual(['src/a.ts', 'README.md'])
  })

  it('makes an existing inline-code path clickable and leaves the rest alone', async () => {
    const resolvePaths = vi.fn(
      async (paths: readonly string[]) => new Map([[paths[0]!, `apps/${paths[0]}`]]),
    )
    const onOpenFile = vi.fn()
    render(
      <Markdown
        text={'见 `src/a.ts:12` 和 `src/missing.ts`，跑 `pnpm test`'}
        resolvePaths={resolvePaths}
        onOpenFile={onOpenFile}
      />,
    )
    const button = await screen.findByRole('button', { name: 'src/a.ts:12' })
    await userEvent.click(button)
    expect(resolvePaths).toHaveBeenCalledWith(['src/a.ts', 'src/missing.ts'])
    expect(onOpenFile).toHaveBeenCalledWith('apps/src/a.ts', 12)
    expect(screen.getByText('src/missing.ts').tagName).toBe('CODE')
    expect(screen.getByText('pnpm test').tagName).toBe('CODE')
  })

  it('does not resolve paths without both props', () => {
    const resolvePaths = vi.fn(async () => new Map([['src/a.ts', 'src/a.ts']]))
    render(<Markdown text={'`src/a.ts`'} resolvePaths={resolvePaths} />)
    expect(screen.getByText('src/a.ts').tagName).toBe('CODE')
    expect(resolvePaths).not.toHaveBeenCalled()
  })

  it('解析代码块的语言与重点行，非 pre>code 结构返回 undefined', () => {
    const pre = (child: unknown) =>
      ({ type: 'element', tagName: 'pre', properties: {}, children: [child] }) as never
    expect(codeBlockOf(undefined)).toBeUndefined()
    expect(
      codeBlockOf(pre({ type: 'element', tagName: 'div', properties: {}, children: [] })),
    ).toBeUndefined()

    const block = codeBlockOf(
      pre({
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-ts'] },
        data: { meta: '{1-3}' },
        children: [{ type: 'text', value: 'const a = 1\n' }],
      }),
    )
    expect(block).toEqual({
      lang: 'ts',
      highlightLines: new Set([1, 2, 3]),
      text: 'const a = 1',
    })

    // className 不是数组、meta 缺失时没有语言与重点行
    const plain = codeBlockOf(
      pre({
        type: 'element',
        tagName: 'code',
        properties: { className: 'language-js' },
        children: [{ type: 'text', value: 'x' }],
      }),
    )
    expect(plain?.lang).toBeUndefined()
    expect(plain?.highlightLines.size).toBe(0)
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

describe('MessageStream 用户消息高亮', () => {
  const userMessage = (extra: object = {}) =>
    reduceSessionEvents(createSessionView('s1'), [
      ev(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/w',
        workspacePath: '/w',
        title: 'x',
      }),
      ev(2, 'run.created', {
        agent: { id: 'a', version: 1 },
        model,
        mode: 'interactive',
        limits,
      }),
      ev(3, 'message.user', {
        messageId: 'u1',
        content: text('/plan @审查员 看 @a.ts:12 和 @b.ts https://a.dev 跑 `pnpm test`'),
        mentions: [{ path: 'a.ts', kind: 'file', lines: { start: 12, end: 12 } }],
        skills: [{ name: 'review' }],
        agents: [{ agentId: 'user.review', name: '审查员' }],
        ...extra,
      }),
    ])

  const renderMessage = (
    view: SessionView,
    onOpenFile?: ((path: string, line?: number) => void) | undefined,
  ) => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      settings: { providers: [] },
      agents: [],
      projects: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    const result = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={view} onOpenPlan={vi.fn()} onOpenFile={onOpenFile} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    return result
  }

  it('marks the command, the skill, the agent and confirmed files', async () => {
    const view = userMessage()
    const onOpenFile = vi.fn()
    const { container } = renderMessage(view, onOpenFile)
    const tokens = (name: string) => container.querySelectorAll(`[data-token="${name}"]`)
    expect(tokens('command')[0]?.textContent).toBe('/plan')
    expect(tokens('skill')[0]?.textContent).toBe('/review')
    expect(tokens('agent')[0]?.textContent).toBe('@审查员')
    expect(container.querySelector('code')?.textContent).toBe('`pnpm test`')
    expect(screen.getByRole('link', { name: 'https://a.dev' })).toBeTruthy()

    // 只有主进程确认过的文件引用才成为按钮
    expect(tokens('mention')).toHaveLength(1)
    expect(container.textContent).toContain('@b.ts')
    await userEvent.click(screen.getByRole('button', { name: /@a\.ts:12/ }))
    expect(onOpenFile).toHaveBeenCalledWith('a.ts', 12)
  })

  it('keeps a confirmed mention a plain chip without a file opener', () => {
    const view = userMessage({ agents: [], skills: [] })
    const { container } = renderMessage(view)
    const mention = container.querySelector('[data-token="mention"]')
    expect(mention?.tagName).toBe('SPAN')
    expect(mention?.textContent).toBe('@a.ts:12')
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
      changes: {},
      changeSets: {},
      inspections: {},
      inspectRun: vi.fn(),
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
    expect(screen.getAllByText('想一想').length).toBeGreaterThan(0)
    expect(screen.getAllByText('正在思考').length).toBeGreaterThan(0)
    expect(screen.getByText('完成')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /较早的对话已压缩/ }))
    expect(screen.getByText('压缩摘要')).toBeTruthy()
    expect(screen.getAllByText(/分钟/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /继续/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(sendPrompt).toHaveBeenCalled()
  })

  it('只有一个工具步骤时也默认折叠，失败也不自动展开', async () => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: 's1',
      awaitingTurn: {},
      approvals: {},
      changes: {},
      agents: [],
      settings: { providers: [] },
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    const renderStream = (stream: SessionView) => (
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} />
        </SessionStoreProvider>
      </I18nextProvider>
    )
    const base = view([
      ...START,
      ev(5, 'message.assistant.completed', {
        messageId: 'a1',
        content: text('先检查'),
        model,
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
      }),
      ev(6, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
    ])
    const rendered = render(renderStream(base))
    const trigger = screen.getByRole('button', { name: /读取 a\.ts/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // 组头已经说了对象，步骤正文在折叠容器里
    expect(trigger.nextElementSibling?.getAttribute('aria-hidden')).toBe('true')
    const completed = view([
      ...START,
      ev(5, 'message.assistant.completed', {
        messageId: 'a1',
        content: text('先检查'),
        model,
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
      }),
      ev(6, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
      ev(7, 'tool.completed', {
        toolCallId: 'tc1',
        output: text('ok'),
        truncated: false,
        durationMs: 50,
      }),
      ev(8, 'turn.completed', { durationMs: 100 }),
    ])
    rendered.rerender(renderStream(completed))
    expect(screen.getByRole('button', { name: /读取 a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.getByText('先检查')).toBeTruthy()
    cleanup()
    const failed = {
      ...completed,
      tools: { ...completed.tools, tc1: { ...completed.tools.tc1!, status: 'failed' as const } },
    }
    render(renderStream(failed))
    // 组头仍只说最新一步，失败只体现在图标颜色上，仍然等用户点开
    const failedTrigger = screen.getByRole('button', { name: /读取 a\.ts/ })
    expect(failedTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(
      failedTrigger.querySelector('svg[data-tool-icon="read_file"]')?.getAttribute('class'),
    ).toContain('text-danger')
  })

  it('shows the reasoning as a collapsible card that expands on click', async () => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      inspectRun: vi.fn(),
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={rich} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const triggers = screen.getAllByRole('button', { name: '思考过程' })
    expect(triggers.length).toBe(2)
    // 收起时正文仍可读（读屏与流式内容不丢失），点击后展开
    expect(screen.getAllByText('想一想').length).toBeGreaterThan(0)
    expect(triggers[0]!.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(triggers[0]!)
    expect(triggers[0]!.getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the empty stream without a view', () => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
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

  it('does not draw a location ring when both turn ids are undefined', () => {
    const stream = view([
      ev(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/w',
        workspacePath: '/w',
        title: 'x',
      }),
      ev(2, 'run.created', {
        agent: { id: 'a', version: 1 },
        model,
        mode: 'interactive',
        limits,
      }),
      {
        ...ev(3, 'message.user', { messageId: 'u1', content: text('1') }),
        turnId: undefined,
      } as EventEnvelope,
    ])
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      settings: { providers: [] },
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.getByRole('listitem').className).not.toContain('ring-1')
  })

  it('renders delegations that are not assigned to a turn', () => {
    const unassigned = {
      ...rich,
      delegations: [
        {
          childRunId: 'child1',
          parentRunId: 'r1',
          agent: { id: 'a', version: 1 },
          task: '补测试',
          workspace: 'isolated',
          workspacePath: '/w',
          budget: undefined,
          turnId: undefined,
          createdAt: 1,
          completed: undefined,
        },
      ],
    } as unknown as SessionView
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      inspectRun: vi.fn(),
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={unassigned} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.getByText('补测试')).toBeTruthy()
  })

  it('shows a running delegation for a turn that only has live messages, after the live text', async () => {
    const liveOnly = {
      ...rich,
      messages: [],
      live: {
        l1: {
          messageId: 'l1',
          runId: 'r1',
          turnId: 't2',
          text: '流式正文',
          reasoning: '',
          lastDeltaSeq: 5,
          startedAt: 3,
        },
      },
      delegations: [
        {
          childRunId: 'child1',
          parentRunId: 'r1',
          agent: { id: 'a', version: 1 },
          task: '补测试',
          workspace: 'isolated',
          workspacePath: '/w',
          budget: undefined,
          turnId: 't2',
          createdAt: 1,
          completed: undefined,
        },
      ],
    } as unknown as SessionView
    const onOpenRun = vi.fn()
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={liveOnly} onOpenRun={onOpenRun} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const cards = screen.getAllByRole('article', { name: '委派任务：补测试' })
    expect(cards).toHaveLength(1)
    const list = screen.getByRole('list', { name: '消息' })
    const cardItem = cards[0]!.closest('li')
    expect(cardItem?.parentElement).toBe(list)
    expect(list.lastElementChild).toBe(cardItem)
    await userEvent.click(screen.getByRole('button', { name: /补测试/ }))
    expect(onOpenRun).toHaveBeenCalledWith('child1')
  })

  it('does not repeat a delegation when its turn already has messages', () => {
    const withTurn = {
      ...rich,
      delegations: [
        {
          childRunId: 'child1',
          parentRunId: 'r1',
          agent: { id: 'a', version: 1 },
          task: '补测试',
          workspace: 'isolated',
          workspacePath: '/w',
          budget: undefined,
          turnId: 't1',
          createdAt: 1,
          completed: undefined,
        },
      ],
    } as unknown as SessionView
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={withTurn} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.getAllByRole('article', { name: '委派任务：补测试' })).toHaveLength(1)
    const list = screen.getByRole('list', { name: '消息' })
    expect(list.lastElementChild?.textContent).not.toContain('补测试')
  })

  it('renders a streaming caret on live text and limits enter animations to newly added messages', () => {
    const initialView = {
      ...rich,
      live: {
        l1: {
          messageId: 'l1',
          runId: 'r1',
          turnId: 't1',
          text: '流式正文',
          reasoning: '',
          lastDeltaSeq: 5,
          startedAt: 3,
        },
      },
    } as unknown as SessionView

    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      inspectRun: vi.fn(),
      settings: { providers: [] },
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore

    const { container, rerender } = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={initialView} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

    // 流式文本段末挂着光标
    expect(container.querySelector('.stream-caret')).toBeTruthy()
    // 首次挂载已有消息不播入场动画，避免历史会话整列闪
    const initialItems = container.querySelectorAll('li')
    expect(initialItems.length).toBeGreaterThan(0)
    for (const item of initialItems) {
      expect(item.className).not.toContain('animate-message-in')
    }

    // 后续新追加的消息播入场动画
    const updatedView = {
      ...initialView,
      messages: [
        ...initialView.messages,
        {
          messageId: 'u2',
          role: 'user',
          runId: 'r1',
          turnId: 't2',
          seq: 4,
          ts: 4,
          content: [{ type: 'text', text: '新追加' }],
        },
      ],
    } as unknown as SessionView

    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={updatedView} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

    const newlyAdded = container.querySelector('[data-turn="t2"]')
    expect(newlyAdded?.className).toContain('animate-message-in')
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
    reviewLoops: [],
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

  const teamBinding = {
    teamId: 'user.team-1',
    name: { 'zh-CN': '日常协作', 'en-US': 'Daily pair' },
    version: 2,
    pattern: 'delegate' as const,
  }

  it('shows a team switch divider instead of the agent divider for the next message', () => {
    const view = {
      ...multiRun,
      messages: [
        user('u1', 'r1', 't1', 1),
        assistant('a1', 'r1', 't1', 2),
        user('u2', 'r2', 't2', 4),
        assistant('a2', 'r2', 't2', 5),
      ],
      teamChanges: [{ seq: 3, team: teamBinding }],
    } as unknown as SessionView
    renderStream(view, [])
    expect(screen.getByText('已切换到团队 日常协作 v2')).toBeDefined()
    expect(screen.queryByText('已切换到 user.custom v3')).toBeNull()
  })

  it('ignores team bindings from before the first message and keeps the latest switch', () => {
    const initial = {
      ...multiRun,
      messages: [user('u1', 'r1', 't1', 5), assistant('a1', 'r1', 't1', 6)],
      teamChanges: [{ seq: 2, team: teamBinding }],
    } as unknown as SessionView
    renderStream(initial, [])
    expect(screen.queryByText(/已切换到团队/)).toBeNull()
    cleanup()

    const switched = {
      ...multiRun,
      messages: [user('u1', 'r1', 't1', 5), assistant('a1', 'r1', 't1', 6)],
      teamChanges: [
        { seq: 2, team: teamBinding },
        { seq: 7, team: { ...teamBinding, version: 3 } },
      ],
    } as unknown as SessionView
    renderStream(switched, [])
    expect(screen.getByText('已切换到团队 日常协作 v3')).toBeDefined()
    expect(screen.queryByText('已切换到团队 日常协作 v2')).toBeNull()
  })

  it('shows a team switch before a live message and the agent divider when leaving', () => {
    const live = {
      ...multiRun,
      runOrder: ['r1', 'r3'],
      messages: [user('u1', 'r1', 't1', 1), assistant('a1', 'r1', 't1', 2)],
      teamChanges: [{ seq: 3, team: teamBinding }],
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
    expect(screen.getByText('已切换到团队 日常协作 v2')).toBeDefined()
    expect(screen.queryByText('已切换到 user.unknown v1')).toBeNull()
    cleanup()

    const left = {
      ...live,
      teamChanges: [
        { seq: 3, team: teamBinding },
        { seq: 4, team: undefined },
      ],
    } as unknown as SessionView
    renderStream(left, [])
    expect(screen.queryByText(/已切换到团队/)).toBeNull()
    expect(screen.getByText('已切换到 user.unknown v1')).toBeDefined()
  })

  it('shows a team switch divider before a live message from a later run', () => {
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

describe('MessageStream 状态呈现', () => {
  const emptyStore = (awaiting = false) =>
    createStore<Record<string, unknown>>(() => ({
      activeSessionId: undefined,
      awaitingTurn: awaiting ? { s1: true } : {},
      approvals: {},
      settings: { providers: [] },
      agents: [],
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore

  const renderStream = (stream: SessionView | undefined, awaiting = false) =>
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={emptyStore(awaiting)}>
          <MessageStream view={stream} onOpenPlan={vi.fn()} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

  it('guides the user when the session has no messages yet', () => {
    const empty = reduceSessionEvents(createSessionView('s1'), START.slice(0, 1))
    renderStream(empty)
    expect(screen.getByText('开始一个新任务')).toBeTruthy()
    expect(screen.getByText(/工具调用和文件改动/)).toBeTruthy()
  })

  it('guides the user when no view is available', () => {
    renderStream(undefined)
    expect(screen.getByText('开始一个新任务')).toBeTruthy()
  })

  it('fills the blank right after sending with a running indicator', () => {
    const { container } = renderStream(view(START), true)
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(container.querySelector('[data-running-status]')).toBeTruthy()
  })

  it('shows the current activity while the model is thinking', () => {
    const stream = view([...START, ev(5, 'run.state.changed', { from: 'idle', to: 'thinking' })])
    const { container } = renderStream(stream)
    expect(screen.getByText('思考中')).toBeTruthy()
    expect(container.querySelector('[data-running-status]')).toBeTruthy()
  })

  it('hides the running indicator once the reply starts streaming', () => {
    const stream = view([
      ...START,
      ev(5, 'run.state.changed', { from: 'idle', to: 'thinking' }),
      ev(6, 'message.assistant.delta', { messageId: 'm1', text: '你好' }),
    ])
    const { container } = renderStream(stream)
    expect(container.querySelector('[data-running-status]')).toBeNull()
  })

  it('hides the running indicator while a tool is running', () => {
    const stream = view([
      ...START,
      ev(5, 'run.state.changed', { from: 'idle', to: 'tooling' }),
      ev(6, 'message.assistant.completed', {
        messageId: 'a1',
        content: [],
        model,
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
      }),
      ev(7, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
      ev(8, 'tool.started', { toolCallId: 'tc1' }),
    ])
    const { container } = renderStream(stream)
    expect(container.querySelector('[data-running-status]')).toBeNull()
    expect(screen.getByRole('button', { name: /读取 a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('只有一个工具步骤时组头也保持折叠，不另起一行运行指示', () => {
    const stream = view([
      ...START,
      ev(5, 'run.state.changed', { from: 'idle', to: 'tooling' }),
      ev(6, 'message.assistant.completed', {
        messageId: 'a1',
        content: [],
        model,
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
      }),
      ev(7, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
      ev(8, 'tool.completed', {
        toolCallId: 'tc1',
        output: text('ok'),
        truncated: false,
        durationMs: 5,
      }),
      ev(9, 'run.state.changed', { from: 'tooling', to: 'thinking' }),
    ])
    const { container } = renderStream(stream)
    // 组头折叠成一句摘要，消息列末尾不再补一行运行指示
    expect(screen.getByRole('button', { name: /读取 a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(container.querySelector('[data-running-status]')).toBeNull()
  })

  it('grades an aborted turn as neutral instead of an error', () => {
    const stream = view([...START, ev(5, 'turn.aborted', { reason: 'user' })])
    const { container } = renderStream(stream)
    expect(screen.getByText('已停止')).toBeTruthy()
    expect(screen.getByRole('img', { name: '已停止' })).toBeTruthy()
    expect(container.textContent).not.toContain('本轮失败')
  })

  it('grades a failed turn as danger and a limit as a warning', () => {
    const failed = renderStream(
      view([...START, ev(5, 'turn.failed', { error: { code: 'unknown' }, retryable: false })]),
    )
    expect(screen.getByRole('img', { name: '本轮失败' })).toBeTruthy()
    expect(screen.getByText(/^本轮失败：/).closest('div')?.className).toContain('bg-danger-soft')
    failed.unmount()

    renderStream(
      view([
        ...START,
        ev(5, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 10 }),
        ev(6, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }),
      ]),
    )
    expect(screen.getByRole('img', { name: '达到限额' })).toBeTruthy()
    expect(screen.getByText(/最多 10 步/).closest('div')?.className).toContain('bg-warn-soft')
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
    const store = createStore<Record<string, unknown>>(() => ({
      awaitingTurn: {},
      ...state,
    })) as unknown as SessionStore
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
    expect(screen.getAllByText('等待审批').length).toBeGreaterThan(0)
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
      reviewLoops: [],
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

  it('多个思考与工具调用时自动汇总折叠为单行卡片，点击可展开与收起', async () => {
    const view = {
      sessionId: 's1',
      lastSeq: 10,
      info: undefined,
      archived: false,
      crash: undefined,
      tools: {
        t1: { toolCallId: 't1', status: 'completed', durationMs: 100 },
        t2: { toolCallId: 't2', status: 'completed', durationMs: 200 },
      },
      liveToolOutput: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      usageByTurn: {},
      contextTokens: undefined,
      checkpoints: [],
      restores: [],
      compaction: undefined,
      toolOutputOmitted: undefined,
      plans: [],
      reviewLoops: [],
      delegations: [],
      runs: { r1: { runId: 'r1', agent: { id: 'builtin.coder', version: 1 } } },
      runOrder: ['r1'],
      messages: [
        {
          messageId: 'u1',
          role: 'user',
          runId: 'r1',
          turnId: 't1',
          seq: 1,
          ts: 1,
          content: [{ type: 'text', text: '查代码' }],
        },
        {
          messageId: 'a1',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 2,
          ts: 2,
          content: [],
          reasoning: { type: 'text', text: '思考中第1步' },
          toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
          model: { providerId: 'p', modelId: 'm' },
          incomplete: false,
        },
        {
          messageId: 'a2',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 3,
          ts: 3,
          content: [],
          reasoning: { type: 'text', text: '思考中第2步' },
          toolCalls: [{ id: 't2', name: 'run_command', input: { command: 'pnpm test' } }],
          model: { providerId: 'p', modelId: 'm' },
          incomplete: false,
        },
        {
          messageId: 'a3',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 4,
          ts: 4,
          content: [{ type: 'text', text: '全部完成' }],
          toolCalls: [],
          model: { providerId: 'p', modelId: 'm' },
          incomplete: false,
        },
      ],
      live: {},
    } as unknown as SessionView

    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider
          store={
            createStore<Record<string, unknown>>(() => ({
              activeSessionId: undefined,
              awaitingTurn: {},
              approvals: {},
              settings: { providers: [] },
              agents: [],
              changes: {},
              sendPrompt: vi.fn(),
            })) as unknown as SessionStore
          }
        >
          <MessageStream view={view} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

    // 折叠状态下，组头只说最新一步在做什么
    const activityButton = screen.getByRole('button', { name: /运行 pnpm test/ })
    expect(activityButton).toBeTruthy()
    // 最终回复正常显示
    expect(screen.getByText('全部完成')).toBeTruthy()

    // 默认完成状态下收起
    expect(activityButton.getAttribute('aria-expanded')).toBe('false')

    // 点击展开
    await userEvent.click(activityButton)
    expect(activityButton.getAttribute('aria-expanded')).toBe('true')

    // 点击再次收起
    await userEvent.click(activityButton)
    expect(activityButton.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('MessageStream 多步骤归组的细节', () => {
  const renderStream = (
    stream: SessionView,
    awaiting: string[] = [],
    onOpenChanges?: () => void,
    agents: unknown[] = [],
  ) => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: 's1',
      awaitingTurn: {},
      approvals: awaiting.length > 0 ? { s1: awaiting.map((toolCallId) => ({ toolCallId })) } : {},
      changes: {},
      changeSets: {},
      inspections: {},
      inspectRun: vi.fn(),
      settings: { providers: [] },
      agents,
      sendPrompt: vi.fn(),
    })) as unknown as SessionStore
    return render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} onOpenChanges={onOpenChanges} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
  }

  const base = {
    sessionId: 's1',
    lastSeq: 20,
    info: undefined,
    archived: false,
    crash: undefined,
    runs: {
      r1: {
        runId: 'r1',
        parentRunId: undefined,
        agent: { id: 'builtin.coder', version: 1 },
        turn: { turnId: 't1', status: 'completed' },
      },
      r2: { runId: 'r2', parentRunId: undefined, agent: { id: 'other.agent', version: 1 } },
    },
    runOrder: ['r1', 'r2'],
    messages: [
      {
        messageId: 'u1',
        role: 'user',
        runId: 'r1',
        turnId: 't1',
        seq: 2,
        ts: 1,
        content: text('开始'),
      },
      {
        messageId: 'a1',
        role: 'assistant',
        runId: 'r1',
        turnId: 't1',
        seq: 3,
        ts: 2,
        content: [],
        reasoning: { type: 'text', text: '想一想' },
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
        model,
        incomplete: false,
      },
      {
        messageId: 'a2',
        role: 'assistant',
        runId: 'r1',
        turnId: 't1',
        seq: 4,
        ts: 3,
        content: text('补充说明'),
        reasoning: { type: 'text', text: '' },
        toolCalls: [{ id: 'tc2', name: 'run_command', input: { command: 'pnpm test' } }],
        model,
        incomplete: false,
      },
      {
        messageId: 'a3',
        role: 'assistant',
        runId: 'r1',
        turnId: 't1',
        seq: 5,
        ts: 4,
        content: [],
        reasoning: undefined,
        toolCalls: [{ id: 'tc3', name: 'list_dir', input: { path: 'src' } }],
        model,
        incomplete: true,
      },
    ],
    live: {},
    tools: {
      tc1: { toolCallId: 'tc1', status: 'completed', durationMs: 10 },
      tc2: { toolCallId: 'tc2', status: 'completed', durationMs: 20 },
      tc3: { toolCallId: 'tc3', status: 'completed', durationMs: 30 },
    },
    liveToolOutput: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    usageByTurn: {},
    contextTokens: undefined,
    checkpoints: [],
    restores: [],
    compaction: undefined,
    toolOutputOmitted: undefined,
    plans: [],
    reviewLoops: [],
    delegations: [],
  } as unknown as SessionView

  it('展开归组卡片时显示步骤正文与工具，并带出计划、委派、恢复和轮次操作', async () => {
    const stream = {
      ...base,
      checkpoints: [
        {
          checkpointId: 'c1',
          reason: 'turn_start',
          seq: 1,
          runId: 'r1',
          turnId: 't1',
          createdAt: 1,
        },
      ],
      restores: [{ checkpointId: 'c1', seq: 6, ts: 6 }],
      compaction: { summary: '压缩摘要', seq: 3 },
      toolOutputOmitted: { seq: 3 },
      plans: [
        {
          planId: 'pl1',
          turnId: 't1',
          status: 'approved',
          seq: 6,
          runId: 'r1',
          content: {
            goal: '归组验证',
            files: [],
            steps: [],
            risks: '',
            verification: '',
            markdown: '',
          },
          steps: [],
        },
      ],
      delegations: [
        {
          childRunId: 'child1',
          parentRunId: 'r1',
          agent: { id: 'a', version: 1 },
          task: '补测试',
          workspace: 'isolated',
          workspacePath: '/w',
          budget: undefined,
          turnId: 't1',
          createdAt: 1,
          completed: undefined,
        },
      ],
    } as unknown as SessionView
    renderStream(stream, [], vi.fn())

    expect(screen.getByText('较早的对话已压缩')).toBeTruthy()
    expect(screen.getByText('较早的工具输出已省略，以腾出上下文。')).toBeTruthy()
    expect(screen.getByText('编程助手')).toBeTruthy()

    const activity = screen.getByRole('button', { name: /查看目录 src/ })
    expect(activity.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(activity)
    expect(activity.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByText('想一想').length).toBeGreaterThan(0)
    expect(screen.getByText('补充说明')).toBeTruthy()
    expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0)
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('（回复未完成）')).toBeTruthy()
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('补测试')).toBeTruthy()
    expect(screen.getByRole('button', { name: '撤销本轮' })).toBeTruthy()
  })

  it('运行中的归组同样默认收起，用户的展开选择在状态变化后保留', async () => {
    const live = {
      ...base,
      live: {
        l1: {
          messageId: 'l1',
          runId: 'r1',
          turnId: 't1',
          text: '',
          reasoning: '',
          lastDeltaSeq: 5,
          startedAt: 3,
        },
      },
    } as unknown as SessionView
    const rendered = renderStream(live)
    const running = screen.getByRole('button', { name: /查看目录 src/ })
    expect(running.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(running)
    expect(running.getAttribute('aria-expanded')).toBe('true')

    // 本轮结束后组头仍折叠，用户手动展开后不会被自动收起
    rendered.rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider
          store={
            createStore<Record<string, unknown>>(() => ({
              activeSessionId: 's1',
              awaitingTurn: {},
              approvals: {},
              changes: {},
              changeSets: {},
              inspections: {},
              inspectRun: vi.fn(),
              settings: { providers: [] },
              agents: [],
              sendPrompt: vi.fn(),
            })) as unknown as SessionStore
          }
        >
          <MessageStream view={base} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const done = screen.getByRole('button', { name: /查看目录 src/ })
    expect(done.getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(done)
    expect(done.getAttribute('aria-expanded')).toBe('false')
  })

  it('已经结束的轮次组头不闪，图标是完成的弱色', () => {
    renderStream(base)
    const done = screen.getByRole('button', { name: /查看目录 src/ })
    expect(done.querySelector('.animate-shimmer')).toBeNull()
    expect(done.querySelector('svg[data-tool-icon="list_dir"]')?.getAttribute('class')).toContain(
      'text-muted',
    )
  })

  it('正在运行的这一轮，只有末尾的活动组在闪', () => {
    const stream = {
      ...base,
      runs: {
        r1: {
          ...base.runs.r1,
          turn: { turnId: 't1', status: 'running' },
          state: 'thinking',
        },
      },
      runOrder: ['r1'],
    } as unknown as SessionView
    renderStream(stream)
    // 前面的组不闪，只有末尾组承担“这一轮还在进行”
    expect(
      screen.getByRole('button', { name: /读取 a\.ts/ }).querySelector('.animate-shimmer'),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: /查看目录 src/ }).querySelector('.animate-shimmer'),
    ).toBeTruthy()
  })

  it('组里有没跑完的工具时，即使不是末尾也闪', () => {
    const stream = {
      ...base,
      tools: { ...base.tools, tc1: { ...base.tools.tc1!, status: 'running' } },
    } as unknown as SessionView
    renderStream(stream)
    expect(
      screen.getByRole('button', { name: /读取 a\.ts/ }).querySelector('.animate-shimmer'),
    ).toBeTruthy()
  })

  it('等待审批的步骤不改变组头，也不自动展开', async () => {
    const stream = {
      ...base,
      tools: { ...base.tools, tc2: { ...base.tools.tc2!, status: 'requested' as const } },
    } as unknown as SessionView
    renderStream(stream, ['tc2'])
    const activity = screen.getByRole('button', { name: /查看目录 src/ })
    expect(activity.getAttribute('aria-expanded')).toBe('false')
    expect(activity.textContent).not.toContain('等待审批')
    // 展开后，等待审批写在步骤行本身
    await userEvent.click(activity)
    expect(screen.getByText('等待审批')).toBeTruthy()
  })

  it('用户取消的工具不改变组头，也不使用失败或横杠图形', async () => {
    const stream = {
      ...base,
      runs: { ...base.runs, r1: { ...base.runs.r1, turn: { turnId: 't1', status: 'aborted' } } },
      tools: { ...base.tools, tc2: { toolCallId: 'tc2', status: 'cancelled', durationMs: 20 } },
    } as unknown as SessionView
    renderStream(stream)
    // 组头只说最新一步，取消状态写在步骤行里。
    const activity = screen.getByRole('button', { name: /查看目录 src/ })
    expect(activity.textContent).not.toContain('已取消')
    expect(activity.querySelector('svg.lucide-minus')).toBeNull()
    expect(activity.querySelector('svg[data-tool-icon="list_dir"]')).toBeTruthy()
    expect(activity.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(activity)
    expect(screen.getByText('已取消')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /失败/ })).toBeNull()
  })

  /** 一组两步工具，第二步是命令，退出码固定为 1；`recovered` 时再补一步跑成功的步骤。 */
  const failingTurn = (recovered: boolean) =>
    view([
      ...START,
      ev(5, 'run.state.changed', { from: 'idle', to: 'tooling' }),
      ev(6, 'message.assistant.completed', {
        messageId: 'a1',
        content: [],
        model,
        toolCalls: [
          { id: 'tc1', name: 'read_file', input: { path: 'a.ts' } },
          { id: 'tc2', name: 'run_command', input: { command: 'pnpm test' } },
          ...(recovered ? [{ id: 'tc3', name: 'read_file', input: { path: 'b.ts' } }] : []),
        ],
      }),
      ev(7, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
      ev(8, 'tool.completed', {
        toolCallId: 'tc1',
        output: text('ok'),
        truncated: false,
        durationMs: 5,
      }),
      ev(9, 'tool.requested', {
        toolCallId: 'tc2',
        name: 'run_command',
        input: { command: 'pnpm test' },
      }),
      ev(10, 'tool.completed', {
        toolCallId: 'tc2',
        output: text('boom'),
        truncated: false,
        durationMs: 5,
        display: {
          kind: 'terminal',
          exitCode: 1,
          timedOut: false,
          aborted: false,
          durationMs: 5,
          shell: 'bash',
          cwd: '/w',
          chunks: [],
          omittedChars: 0,
        },
      }),
      ...(recovered
        ? [
            ev(11, 'tool.requested', {
              toolCallId: 'tc3',
              name: 'read_file',
              input: { path: 'b.ts' },
            }),
            ev(12, 'tool.completed', {
              toolCallId: 'tc3',
              output: text('ok'),
              truncated: false,
              durationMs: 5,
            }),
          ]
        : []),
      ev(recovered ? 13 : 11, 'turn.completed', { durationMs: 20 }),
    ])

  it('最后一步命令非零退出时组头仍说最新一步，图标标红，界面保持折叠', () => {
    renderStream(failingTurn(false))
    const activity = screen.getByRole('button', { name: /运行 pnpm test/ })
    expect(activity.getAttribute('aria-expanded')).toBe('false')
    expect(activity.textContent).not.toContain('失败')
    const icon = activity.querySelector('svg[data-tool-icon="run_command"]')!
    expect(icon.getAttribute('class')).toContain('text-danger')
  })

  it('非零退出后又有别的步骤跑完，组头回到最新一步而不是停在失败', () => {
    renderStream(failingTurn(true))
    const activity = screen.getByRole('button', { name: /读取 b\.ts/ })
    expect(activity.getAttribute('aria-expanded')).toBe('false')
  })

  it('加载技能时组头把技能名带进摘要', () => {
    const stream = view([
      ...START,
      ev(5, 'run.state.changed', { from: 'idle', to: 'tooling' }),
      ev(6, 'message.assistant.completed', {
        messageId: 'a1',
        content: [],
        model,
        toolCalls: [
          { id: 'tc1', name: 'read_file', input: { path: 'a.ts' } },
          { id: 'tc2', name: 'load_skill', input: { name: 'debug' } },
        ],
      }),
      ev(7, 'tool.requested', { toolCallId: 'tc1', name: 'read_file', input: { path: 'a.ts' } }),
      ev(8, 'tool.completed', {
        toolCallId: 'tc1',
        output: text('ok'),
        truncated: false,
        durationMs: 5,
      }),
      ev(9, 'tool.requested', {
        toolCallId: 'tc2',
        name: 'load_skill',
        input: { name: 'debug' },
      }),
    ])
    renderStream(stream)
    expect(screen.getByRole('button', { name: /debug/ })).toBeTruthy()
  })

  it('从第一条消息开始的归组与单独的思考步骤', () => {
    const started = {
      ...base,
      messages: [
        {
          messageId: 'a1',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 3,
          ts: 2,
          content: [],
          reasoning: { type: 'text', text: '' },
          toolCalls: [],
          model,
          incomplete: false,
        },
        {
          messageId: 'a2',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 4,
          ts: 3,
          content: [],
          reasoning: { type: 'text', text: '第二步' },
          toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
          model,
          incomplete: false,
        },
      ],
    } as unknown as SessionView
    renderStream(started)
    // 组头只说最新一步，默认折叠
    expect(screen.getByRole('button', { name: /读取 a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    cleanup()

    const single = {
      ...base,
      messages: [
        {
          messageId: 'u1',
          role: 'user',
          runId: 'r1',
          turnId: 't1',
          seq: 2,
          ts: 1,
          content: text('开始'),
        },
        {
          messageId: 'a1',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 3,
          ts: 2,
          content: [],
          reasoning: { type: 'text', text: '只想一下' },
          toolCalls: [],
          model,
          incomplete: false,
        },
      ],
    } as unknown as SessionView
    renderStream(single)
    expect(screen.queryByRole('button', { name: /个步骤/ })).toBeNull()
    expect(screen.getAllByText('只想一下').length).toBeGreaterThan(0)
  })

  it('复制本轮回复后显示已复制，剪贴板失败时保持原样', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const stream = view([
      ...START,
      ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('结果'), model }),
      ev(6, 'turn.completed', { durationMs: 10 }),
    ])
    const rendered = renderStream(stream)
    await userEvent.click(screen.getByRole('button', { name: '复制本轮回复' }))
    expect(writeText).toHaveBeenCalledWith('结果')
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
    rendered.unmount()

    const failing = vi.fn().mockRejectedValue(new Error('no clipboard'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: failing },
    })
    renderStream(stream)
    await userEvent.click(screen.getByRole('button', { name: '复制本轮回复' }))
    expect(screen.getByRole('button', { name: '复制本轮回复' })).toBeTruthy()
  })

  it('本轮仍在运行时组头也保持折叠，用摘要而不是状态词', () => {
    const stream = {
      ...base,
      runOrder: ['r1'],
      runs: {
        ...base.runs,
        r1: { ...base.runs.r1, turn: { turnId: 't1', status: 'running' } },
      },
    } as unknown as SessionView
    renderStream(stream)
    expect(screen.getByRole('button', { name: /查看目录 src/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('宿主退出导致的中断使用中断文案', () => {
    renderStream(view([...START, ev(5, 'turn.aborted', { reason: 'shutdown' })]))
    expect(screen.getByText('本轮已中断，可以继续对话。')).toBeTruthy()
  })

  it('只有实时消息且还没有内容时显示思考中占位', () => {
    const stream = {
      ...base,
      messages: [base.messages[0]],
      live: {
        l1: {
          messageId: 'l1',
          runId: 'r1',
          turnId: 't1',
          text: '',
          reasoning: '',
          lastDeltaSeq: 1,
          startedAt: 1,
        },
      },
    } as unknown as SessionView
    renderStream(stream)
    expect(screen.getAllByText('思考中').length).toBeGreaterThan(0)
  })

  it('归组会收集没有工具但有后续工具的思考步骤，并在不连续处停止', () => {
    const stream = {
      ...base,
      runOrder: ['r1'],
      messages: [
        {
          messageId: 'a1',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 3,
          ts: 2,
          content: [],
          reasoning: undefined,
          toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
          model,
          incomplete: false,
        },
        {
          messageId: 'a2',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 4,
          ts: 3,
          content: [],
          reasoning: undefined,
          toolCalls: [],
          model,
          incomplete: false,
        },
        {
          messageId: 'a3',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 5,
          ts: 4,
          content: [],
          reasoning: { type: 'text', text: '' },
          toolCalls: [],
          model,
          incomplete: false,
        },
        {
          messageId: 'a4',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 6,
          ts: 5,
          content: [],
          reasoning: undefined,
          toolCalls: [{ id: 'tc2', name: 'list_dir', input: { path: 'src' } }],
          model,
          incomplete: false,
        },
        {
          messageId: 'a5',
          role: 'assistant',
          runId: 'r1',
          turnId: 't1',
          seq: 7,
          ts: 6,
          content: [],
          reasoning: undefined,
          toolCalls: [],
          model,
          incomplete: false,
        },
      ],
    } as unknown as SessionView
    renderStream(stream, [], vi.fn())
    expect(screen.getByRole('button', { name: /查看目录 src/ })).toBeTruthy()
  })

  it('失败但没有错误详情时使用未知错误说明', () => {
    const stream = {
      ...base,
      runOrder: ['r1'],
      runs: {
        ...base.runs,
        r1: {
          ...base.runs.r1,
          turn: { turnId: 't1', status: 'failed', error: undefined },
        },
      },
      messages: [base.messages[0]],
    } as unknown as SessionView
    renderStream(stream)
    expect(screen.getByText(/^本轮失败：/)).toBeTruthy()
  })

  it('新出现的归组播放入场动画', () => {
    const tree = (stream: SessionView) => (
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider
          store={
            createStore<Record<string, unknown>>(() => ({
              activeSessionId: 's1',
              awaitingTurn: {},
              approvals: {},
              changes: {},
              changeSets: {},
              inspections: {},
              inspectRun: vi.fn(),
              settings: { providers: [] },
              agents: [],
              sendPrompt: vi.fn(),
            })) as unknown as SessionStore
          }
        >
          <MessageStream view={stream} />
        </SessionStoreProvider>
      </I18nextProvider>
    )
    const initial = { ...base, messages: [base.messages[0]] } as unknown as SessionView
    const rendered = render(tree(initial))
    rendered.rerender(tree(base))
    expect(screen.getByRole('button', { name: /查看目录 src/ })).toBeTruthy()
    expect(document.querySelector('.animate-message-in')).toBeTruthy()
  })

  it('归组找不到运行或 Agent 摘要时回退到 Agent id', () => {
    // 运行不在 view.runs 里：按未知 Agent 渲染，不回退到任何名字
    const unknown = {
      ...base,
      runs: {},
      runOrder: [],
      messages: base.messages.slice(1),
    } as unknown as SessionView
    const first = renderStream(unknown, [], undefined, [
      {
        agentId: 'builtin.coder',
        name: { 'zh-CN': '编程助手', 'en-US': 'Coder' },
      },
    ])
    expect(screen.getByRole('button', { name: /查看目录 src/ })).toBeTruthy()
    first.unmount()

    // 有 Agent 摘要时使用摘要里的名字
    const summary = renderStream(base, [], undefined, [
      {
        agentId: 'builtin.coder',
        name: { 'zh-CN': '编程助手', 'en-US': 'Coder' },
      },
    ])
    expect(screen.getByRole('button', { name: /查看目录 src/ })).toBeTruthy()
    summary.unmount()

    // 只有 Agent id、没有摘要时显示 id
    const other = {
      ...base,
      runOrder: ['r1'],
      runs: {
        r1: { ...base.runs.r1, agent: { id: 'other.agent', version: 1 } },
      },
    } as unknown as SessionView
    renderStream(other)
    expect(screen.getByRole('button', { name: /查看目录 src/ })).toBeTruthy()
  })

  it('说明崩溃、等待重试与其他限额', () => {
    const crash = renderStream({
      ...base,
      crash: { code: 'host.crashed', message: '' },
    } as unknown as SessionView)
    expect(screen.getByText('Agent 进程意外退出，可以从最后保存的位置继续。')).toBeTruthy()
    crash.unmount()

    // 重试等待按秒倒数：计时用假时钟，避免真的等 5 秒
    const retryAt = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(retryAt)
    try {
      const retrying = renderStream({
        ...base,
        runOrder: ['r1'],
        runs: {
          ...base.runs,
          r1: {
            ...base.runs.r1,
            turn: {
              turnId: 't1',
              status: 'running',
              retry: {
                attempt: 1,
                maxRetries: 3,
                delayMs: 5000,
                error: { code: 'model.error' },
                at: retryAt,
              },
            },
          },
        },
      } as unknown as SessionView)
      expect(screen.getByText(/模型请求失败/)).toBeTruthy()
      expect(screen.getByText(/5 秒后重试/)).toBeTruthy()
      act(() => vi.advanceTimersByTime(1000))
      expect(screen.getByText(/4 秒后重试/)).toBeTruthy()
      act(() => vi.advanceTimersByTime(3000))
      expect(screen.getByText(/1 秒后重试/)).toBeTruthy()
      retrying.unmount()
    } finally {
      vi.useRealTimers()
    }

    renderStream({
      ...base,
      runOrder: ['r1'],
      runs: {
        ...base.runs,
        r1: {
          ...base.runs.r1,
          turn: {
            turnId: 't1',
            status: 'failed',
            limitReached: { limit: 'maxConsecutiveToolErrors', value: 2 },
            error: { code: 'run.limit_reached' },
          },
        },
      },
    } as unknown as SessionView)
    expect(screen.getByText(/工具调用连续失败 2 次/)).toBeTruthy()
  })
})

describe('MessageStream 审查循环（M7-07）', () => {
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    awaitingTurn: {},
    approvals: {},
    changes: {},
    agents: [],
    settings: { providers: [] },
    sendPrompt: vi.fn(),
  })) as unknown as SessionStore

  const renderStream = (stream: SessionView) =>
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

  it('把审查循环挂在本轮末尾，没有消息的循环排在流末尾', () => {
    renderStream(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
        ev(6, 'team.review.round', {
          reviewId: 'rv1',
          round: 1,
          makerRunId: 'm1',
          checkerRunId: 'c1',
          verdict: 'pass',
        }),
        ev(7, 'team.review.completed', { reviewId: 'rv1', status: 'passed', rounds: 1 }),
        ev(8, 'turn.completed', { durationMs: 10 }),
        ev(9, 'team.review.completed', { reviewId: 'rv2', status: 'failed', rounds: 0 }, 't2'),
      ]),
    )
    const cards = screen.getAllByRole('region', { name: '审查循环' })
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('已通过')
    expect(cards[1]?.textContent).toContain('失败')
  })
})

describe('MessageStream 流水线（M7-08）', () => {
  const store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    awaitingTurn: {},
    approvals: {},
    changes: {},
    agents: [],
    settings: { providers: [] },
    sendPrompt: vi.fn(),
  })) as unknown as SessionStore

  const renderStream = (stream: SessionView) =>
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )

  it('把流水线挂在本轮末尾，没有消息的流水线排在流末尾', () => {
    renderStream(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
        ev(6, 'team.pipeline.stage', {
          pipelineId: 'pl1',
          stage: 'build',
          agentRunId: 'run-build',
          status: 'completed',
          summary: '构建完成',
        }),
        ev(7, 'team.pipeline.completed', {
          pipelineId: 'pl1',
          status: 'completed',
          stages: 1,
          skipped: [],
        }),
        ev(8, 'turn.completed', { durationMs: 10 }),
        ev(
          9,
          'team.pipeline.completed',
          { pipelineId: 'pl2', status: 'failed', stages: 0, skipped: ['a'], summary: '非法' },
          't2',
        ),
      ]),
    )
    const cards = screen.getAllByRole('region', { name: '流水线' })
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('已完成')
    expect(cards[1]?.textContent).toContain('失败')
  })
})

describe('编辑重发与重新生成（ADR-0046）', () => {
  const finished = () =>
    view([
      ...START,
      ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('回答一'), model }),
      ev(6, 'turn.completed', { durationMs: 5 }),
      ev(7, 'message.user', { messageId: 'u2', content: text('第二轮') }, 't2'),
      ev(8, 'turn.started', {}, 't2'),
      ev(
        9,
        'message.assistant.completed',
        { messageId: 'a2', content: text('回答二'), model },
        't2',
      ),
      ev(10, 'turn.completed', { durationMs: 5 }, 't2'),
    ])

  function renderStream(
    stream: SessionView,
    actions: { editMessage?: ReturnType<typeof vi.fn>; regenerate?: ReturnType<typeof vi.fn> } = {},
    awaiting = false,
  ) {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: 's1',
      awaitingTurn: awaiting ? { s1: true } : {},
      approvals: {},
      changes: {},
      projects: [],
      agents: [],
      settings: { providers: [] },
      sendPrompt: vi.fn(),
      editMessage: actions.editMessage ?? vi.fn(async () => true),
      regenerate: actions.regenerate ?? vi.fn(async () => true),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
  }

  it('编辑轮次开头的用户消息：显示输入框，确认后带新文本重发', async () => {
    const editMessage = vi.fn(async () => true)
    renderStream(finished(), { editMessage })
    // 每一轮开头的用户消息都有编辑入口；中间的引导输入没有。
    const edits = screen.getAllByRole('button', { name: '编辑消息' })
    expect(edits).toHaveLength(2)
    await userEvent.click(edits[0]!)

    const box = screen.getByRole('textbox', { name: '编辑消息' })
    expect((box as HTMLTextAreaElement).value).toBe('你好')
    await userEvent.clear(box)
    await userEvent.type(box, '改过的问题')
    await userEvent.click(screen.getByRole('button', { name: '保存并重发' }))

    // 后面还有一轮：先确认会丢弃它们。
    expect(screen.getByText('回退这段对话？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '回退并重新开始' }))
    expect(editMessage).toHaveBeenCalledWith('u1', '改过的问题', {
      agents: [],
      agentNames: [],
    })
  })

  it('取消编辑不发请求', async () => {
    const editMessage = vi.fn(async () => true)
    renderStream(finished(), { editMessage })
    await userEvent.click(screen.getAllByRole('button', { name: '编辑消息' })[1]!)
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '编辑消息' })).toBeNull()
    expect(editMessage).not.toHaveBeenCalled()
  })

  it('重新生成：最后一轮直接重发，较早的轮次先确认', async () => {
    const regenerate = vi.fn(async () => true)
    renderStream(finished(), { regenerate })
    const buttons = screen.getAllByRole('button', { name: '重新生成' })
    expect(buttons).toHaveLength(2)

    // 最后一轮之后没有别的轮次：直接开始。
    await userEvent.click(buttons[1]!)
    expect(regenerate).toHaveBeenCalledWith('a2')

    // 第一轮之后还有一轮：确认后才回退。
    await userEvent.click(buttons[0]!)
    expect(screen.getByText('回退这段对话？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '回退并重新开始' }))
    expect(regenerate).toHaveBeenCalledWith('a1')
  })

  it('运行中不可编辑或重新生成', () => {
    renderStream(finished(), {}, true)
    for (const name of ['编辑消息', '重新生成']) {
      for (const button of screen.getAllByRole('button', { name })) {
        expect((button as HTMLButtonElement).disabled).toBe(true)
      }
    }
  })
})

describe('目标续轮与结束卡（ADR-0047）', () => {
  const goalLimits = { maxTurns: 20, maxDurationMs: 3_600_000 }
  const goalModel = { providerId: 'fake', modelId: 'judge' }
  const goalBase = () => [
    ev(1, 'session.created', {
      projectId: 'p1',
      projectPath: '/w',
      workspacePath: '/w',
      title: 'x',
    }),
    ev(2, 'run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
    ev(3, 'goal.created', { goalId: 'g1', condition: '测试全部通过', limits: goalLimits }),
    ev(4, 'message.user', { messageId: 'u1', content: text('测试全部通过') }),
  ]

  const renderGoal = (stream: SessionView, onOpenGoal?: () => void) => {
    const store = createStore<Record<string, unknown>>(() => ({
      activeSessionId: 's1',
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      inspections: {},
      settings: { providers: [] },
      agents: [],
      projects: [],
      sendPrompt: vi.fn(),
      editMessage: vi.fn(async () => true),
      regenerate: vi.fn(async () => true),
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <MessageStream view={stream} onOpenGoal={onOpenGoal} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
  }

  it('把自动续轮消息折叠成目标继续行，不提供编辑入口', () => {
    const stream = reduceSessionEvents(createSessionView('s1'), [
      ...goalBase(),
      ev(5, 'turn.started', {}),
      ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('先看看'), model }),
      ev(7, 'goal.evaluated', {
        goalId: 'g1',
        verdict: 'not_met',
        reason: '还差测试',
        evidence: [],
        model: goalModel,
      }),
      ev(8, 'turn.completed', { durationMs: 10 }),
      ev(9, 'message.user', {
        messageId: 'u2',
        content: text('The goal is not yet met. Continue working toward it.'),
        origin: 'goal',
        goalId: 'g1',
      }),
      ev(10, 'turn.started', {}, 't2'),
    ])
    renderGoal(stream)
    const row = screen.getByText('目标继续').closest('div')
    expect(row).toBeTruthy()
    expect(screen.getByText('还差测试')).toBeTruthy()
    expect(within(row!).queryByRole('button', { name: '编辑消息' })).toBeNull()

    const expand = screen.getByRole('button', { name: '展开继续说明' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(screen.getByText('The goal is not yet met. Continue working toward it.')).toBeTruthy()
  })

  it('在结束那一轮之后插入结果卡，并可从卡片打开目标面板', () => {
    const stream = reduceSessionEvents(createSessionView('s1'), [
      ...goalBase(),
      ev(5, 'turn.started', {}),
      ev(6, 'message.assistant.completed', { messageId: 'a1', content: text('做完了'), model }),
      ev(7, 'turn.completed', { durationMs: 10 }),
      ev(8, 'goal.ended', { goalId: 'g1', reason: 'met', turns: 1, durationMs: 9_000 }),
    ])
    const onOpenGoal = vi.fn()
    renderGoal(stream, onOpenGoal)
    expect(screen.getByText('目标已达成')).toBeTruthy()
    expect(screen.getByText('1 轮 · 活动 0:09')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看目标' }))
    expect(onOpenGoal).toHaveBeenCalled()
  })
})
