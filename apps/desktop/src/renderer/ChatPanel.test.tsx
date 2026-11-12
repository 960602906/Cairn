// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createSessionView } from '@cairn/core'
import { createI18n, type Locale } from '@cairn/i18n'
import { RpcError, type EventEnvelope, type SessionSummary } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { ChatPanel } from './ChatPanel.js'
import { FILE_DRAG_TYPE } from './file-drag.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { TooltipProvider } from './ui/index.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as { cairn?: unknown }).cairn
})

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

/** 文件树直接走 `window.cairn`，测试里把 store 的请求替身转成桥接响应。 */
function installFileBridge(request: (method: string, params: unknown) => unknown) {
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request: async (method: string, params: unknown) => ({
      ok: true,
      result: await request(method, params),
    }),
    on: () => () => undefined,
  }
}

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

/** 消息流中的消息（列表的直接子项；工具时间线等嵌套列表不算）。 */
const messages = () =>
  [...screen.getByRole('list', { name: '消息' }).children].map((li) => li.textContent)
const input = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement
/** 运行中发送按钮换成停止按钮，此时为 null。 */
const sendButton = () => screen.queryByRole('button', { name: '发送' }) as HTMLButtonElement
const stopButton = () => screen.queryByRole('button', { name: '停止' }) as HTMLButtonElement | null
/** 计划模式开启时输入框里出现「退出计划模式」标记。 */
const planOn = () => screen.queryByRole('button', { name: '退出计划模式' }) !== null
/** 右侧会话信息栏默认收起，交互前先打开（窄窗口时它不再在可访问树里）。 */
const showPanel = async () => {
  const toggle = screen.getByRole('button', { name: '会话信息' })
  if (toggle.getAttribute('aria-expanded') === 'false') await userEvent.click(toggle)
}

describe('ChatPanel', () => {
  it('renders nothing without an active session', () => {
    const store = createSessionStore({
      ready: () => Promise.resolve(),
      request: async () => ({}),
      on: () => () => {},
    } as unknown as MainApi)
    store.setState({ activeSessionId: undefined })
    const { container } = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(container.firstElementChild).toBeNull()
  })

  it('opens the change set review from an entry request (M4-10)', async () => {
    const request = vi.fn(async () => ({}))
    const api = {
      ready: () => Promise.resolve(),
      request,
      on: () => () => {},
    } as unknown as MainApi
    const store = createSessionStore(api)
    store.setState({
      activeSessionId: 's1',
      sessions: [summary('修复登录')],
      views: { s1: createSessionView('s1') },
      awaitingTurn: {},
      projects: [],
      changeSets: { s1: [] },
      changeSetLoading: {},
      changeSetDetails: {},
      changeSetErrors: {},
      loadChangeSet: vi.fn(async () => undefined),
    })
    const opened = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <TooltipProvider>
            <ChatPanel
              initialChangeSetId="cs1"
              initialChangeSetSessionId="s1"
              onInitialChangeSetOpened={opened}
            />
          </TooltipProvider>
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByRole('region', { name: '改动集审阅' })).toBeTruthy()
    expect(opened).toHaveBeenCalled()
  })

  it('shows the new chat page until a session is picked', async () => {
    setup()
    expect(await screen.findByPlaceholderText('有什么可以帮你？')).toBeTruthy()
    expect(screen.queryByText('选择或新建一个会话开始对话')).toBeNull()
  })

  it('opens and closes the session panel from the header on narrow windows', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: '会话信息' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '关闭会话信息' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the home first, then closes tabs one by one back to the home', async () => {
    const { open } = setup({
      history: HISTORY,
      handlers: {
        'run.inspect': () => ({
          tree: { sessionId: 's1', rootRunId: 'r1', generatedAt: 1, runs: [] },
          snapshots: [],
          settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
        }),
      },
    })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })
    await userEvent.click(toggle)
    const tabNames = () =>
      within(screen.getByRole('tablist', { name: '会话页面' }))
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-label'))
    expect(tabNames()).toEqual(['首页'])
    expect(screen.getByRole('tab', { name: '首页' }).getAttribute('aria-selected')).toBe('true')

    // 「+」菜单只列出固定入口；改动、概要、计划都在对话里点开。
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(within(panel).queryByRole('button', { name: '打开改动' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: '打开概要' })).toBeNull()
    await userEvent.click(within(panel).getByRole('button', { name: '打开其他面板' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      '文件',
    ])
    expect(screen.queryByRole('menuitem', { name: '改动' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '概要' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '计划' })).toBeNull()
    await userEvent.click(await screen.findByRole('menuitem', { name: '文件' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(tabNames()).toEqual(['首页', '文件树'])
    expect(screen.getByRole('tab', { name: '文件树' }).getAttribute('aria-selected')).toBe('true')

    // 关掉当前标签，回到首页。
    await userEvent.click(screen.getByRole('button', { name: '关闭文件树' }))
    expect(tabNames()).toEqual(['首页'])
    expect(screen.getByRole('tab', { name: '首页' }).getAttribute('aria-selected')).toBe('true')

    // 从「+」菜单重新打开文件树，再关掉回到首页。
    await userEvent.click(screen.getByRole('button', { name: '打开其他面板' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '文件' }))
    expect(tabNames()).toEqual(['首页', '文件树'])
    expect(screen.getByRole('tab', { name: '文件树' }).getAttribute('aria-selected')).toBe('true')

    await userEvent.click(screen.getByRole('button', { name: '关闭文件树' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(tabNames()).toEqual(['首页'])
    expect(screen.getByRole('tab', { name: '首页' }).getAttribute('aria-selected')).toBe('true')
    expect(within(panel).getByText('工作台')).toBeTruthy()
  })

  it('opens files in their own tabs and keeps the file tree while switching', async () => {
    const rootEntries = [
      { path: 'src', name: 'src', kind: 'dir' as const, hidden: false },
      { path: 'notes.txt', name: 'notes.txt', kind: 'file' as const, hidden: false },
    ]
    const { open, store, request } = setup({
      history: HISTORY,
      handlers: {
        'fs.list': (params: { path?: string }) => ({
          entries:
            params.path === 'src'
              ? [{ path: 'src/inner.ts', name: 'inner.ts', kind: 'file', hidden: false }]
              : rootEntries,
          truncated: false,
        }),
        'fs.read': () => ({ content: { kind: 'text', text: 'notes\n' } }),
      },
    })
    await open()
    installFileBridge(request)
    act(() =>
      store.setState({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
      }),
    )
    await showPanel()
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await userEvent.click(within(panel).getByRole('button', { name: '打开文件树' }))
    await waitFor(() => expect(within(panel).getByText('notes.txt')).toBeTruthy())

    const treeRow = (name: string) =>
      within(panel)
        .getAllByText(name)
        .map((element) => element.closest('li'))
        .find((row) => row !== null) as HTMLElement
    const tabNames = () =>
      within(screen.getByRole('tablist', { name: '会话页面' }))
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-label'))

    await userEvent.click(within(treeRow('notes.txt')!).getByText('notes.txt'))
    expect(tabNames()).toEqual(['首页', '文件树', 'notes.txt'])
    expect(screen.getByRole('tab', { name: 'notes.txt' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('region', { name: '文件预览：notes.txt' }).textContent).toContain(
      'notes',
    )

    await userEvent.click(screen.getByRole('tab', { name: '文件树' }))
    await userEvent.click(within(treeRow('src')).getByRole('button', { name: '展开目录' }))
    await waitFor(() => expect(within(panel).getByText('inner.ts')).toBeTruthy())

    await userEvent.click(within(treeRow('inner.ts')!).getByText('inner.ts'))
    expect(tabNames()).toEqual(['首页', '文件树', 'notes.txt', 'src/inner.ts'])
    await userEvent.click(screen.getByRole('tab', { name: '文件树' }))
    // 树没有卸载：展开过的目录和里面的文件还在。
    expect(
      within(panel)
        .getAllByText('inner.ts')
        .some((element) => element.closest('li') !== null),
    ).toBe(true)

    // 再点同一个文件只激活已有标签，不重复创建。
    await userEvent.click(within(treeRow('notes.txt')!).getByText('notes.txt'))
    expect(tabNames()).toEqual(['首页', '文件树', 'notes.txt', 'src/inner.ts'])
    await userEvent.click(screen.getByRole('button', { name: '关闭notes.txt' }))
    expect(tabNames()).toEqual(['首页', '文件树', 'src/inner.ts'])
  })

  it('renames and deletes open file tabs from the tree', async () => {
    const entries = [{ path: 'notes.txt', name: 'notes.txt', kind: 'file' as const, hidden: false }]
    const { open, store, request } = setup({
      history: HISTORY,
      handlers: {
        'fs.list': () => ({ entries, truncated: false }),
        'fs.read': () => ({ content: { kind: 'text', text: 'notes\n' } }),
        'fs.rename': () => {
          entries[0] = { ...entries[0]!, path: 'renamed.txt', name: 'renamed.txt' }
          return { path: 'renamed.txt' }
        },
        'fs.delete': () => {
          entries.splice(0)
          return {}
        },
      },
    })
    await open()
    installFileBridge(request)
    act(() =>
      store.setState({
        projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
      }),
    )
    await showPanel()
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await userEvent.click(within(panel).getByRole('button', { name: '打开文件树' }))
    await userEvent.click(await within(panel).findByText('notes.txt'))
    expect(screen.getByRole('tab', { name: 'notes.txt' })).toBeTruthy()

    const row = () =>
      within(panel)
        .getAllByText('notes.txt')
        .map((el) => el.closest('li'))
        .find((item) => item !== null)!
    await userEvent.click(row()!.querySelector('button[aria-label="文件操作"]') as HTMLElement)
    await userEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByLabelText('名称')
    await userEvent.clear(input)
    await userEvent.type(input, 'renamed.txt')
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'renamed.txt' })).toBeTruthy())
    expect(screen.queryByRole('tab', { name: 'notes.txt' })).toBeNull()

    const renamed = () =>
      within(panel)
        .getAllByText('renamed.txt')
        .map((el) => el.closest('li'))
        .find((item) => item !== null)!
    await userEvent.click(renamed()!.querySelector('button[aria-label="文件操作"]') as HTMLElement)
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    await userEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'renamed.txt' })).toBeNull())
  })

  it('returns to the home and clears tabs when switching sessions', async () => {
    const { open, store } = setup({ history: HISTORY })
    await open()
    await showPanel()
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    await userEvent.click(within(panel).getByRole('button', { name: '打开其他面板' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '文件' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('tab', { name: '文件树' })).toBeTruthy()

    act(() =>
      store.setState({
        activeSessionId: 's2',
        views: { ...store.getState().views, s2: createSessionView('s2') },
      }),
    )
    const tabs = within(screen.getByRole('tablist', { name: '会话页面' }))
    expect(tabs.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['首页'])
    expect(tabs.getByRole('tab', { name: '首页' }).getAttribute('aria-selected')).toBe('true')
    expect(within(panel).getByRole('button', { name: '打开文件树' })).toBeTruthy()
  })

  it('floats the plan progress above the composer while a plan is being carried out', async () => {
    const planContent = {
      goal: '整理设置页',
      files: [],
      steps: [
        { id: 'a', title: '重排入口' },
        { id: 'b', title: '统一间距' },
      ],
      risks: '',
      verification: '',
      markdown: '',
    }
    const { open, emit } = setup({ history: HISTORY })
    await open()
    expect(screen.queryByRole('region', { name: '计划进度' })).toBeNull()
    const base = HISTORY.length
    emit(
      ev(base + 1, 'plan.proposed', { planId: 'pl1', content: planContent }),
      ev(base + 2, 'plan.approved', { planId: 'pl1' }),
      ev(base + 3, 'plan.step.updated', { planId: 'pl1', stepIndex: 0, status: 'done' }),
    )
    const card = await screen.findByRole('region', { name: '计划进度' })
    expect(within(card).getByText('1 / 2')).toBeTruthy()

    // 点目标在右侧打开完整计划。
    await userEvent.click(within(card).getByRole('button', { name: '整理设置页' }))
    expect(screen.getByRole('tab', { name: '计划' }).getAttribute('aria-selected')).toBe('true')

    // 步骤全部做完后卡片消失。
    emit(ev(base + 4, 'plan.step.updated', { planId: 'pl1', stepIndex: 1, status: 'done' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '计划进度' })).toBeNull())
  })

  it('closes the overlay with the backdrop or Esc and returns focus to the toggle', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })

    await userEvent.click(toggle)
    expect(screen.getByRole('dialog', { name: '会话信息' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('session-panel-overlay'))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)

    await userEvent.click(toggle)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })

  it('leaves Escape to an open menu before closing the overlay', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })
    await userEvent.click(toggle)

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    menu.remove()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('ignores an initial change set for another session', async () => {
    const request = vi.fn(async () => ({}))
    const store = createSessionStore({
      ready: () => Promise.resolve(),
      request,
      on: () => () => {},
    } as unknown as MainApi)
    store.setState({
      activeSessionId: 's1',
      sessions: [summary('修复登录')],
      views: { s1: createSessionView('s1') },
      awaitingTurn: {},
      changes: {},
      changeSets: {},
      changeSetDetails: {},
      changeSetLoading: {},
      changeSetErrors: {},
    })
    const opened = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <TooltipProvider>
            <ChatPanel
              initialChangeSetId="cs1"
              initialChangeSetSessionId="s2"
              onInitialChangeSetOpened={opened}
            />
          </TooltipProvider>
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.queryByRole('region', { name: '改动集审阅' })).toBeNull()
    expect(opened).not.toHaveBeenCalled()
  })

  it('announces waiting approval instead of running while the turn is awaiting', async () => {
    const history = [
      ...HISTORY,
      state(9, 'completed', 'thinking'),
      state(10, 'thinking', 'tooling'),
      state(11, 'tooling', 'awaiting_approval'),
    ]
    const { open, store } = setup({ history })
    await open()
    act(() => store.setState({ awaitingTurn: { s1: true } }))
    expect(screen.getByRole('status').textContent).toBe('等待审批')
  })

  it('resets the panel preference when crossing the 1440px dock breakpoint', async () => {
    let wide = false
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query.includes('min-width') ? wide : false
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }))
    const { open } = setup({ history: HISTORY })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: '会话信息' })).toBeTruthy()

    act(() => {
      wide = true
      listeners.forEach((listener) => listener())
    })
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getByRole('complementary', { name: '会话信息' })).toBeTruthy()

    act(() => {
      wide = false
      listeners.forEach((listener) => listener())
    })
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy()
  })

  it('opens this turn’s changes from the header', async () => {
    const { open } = setup({
      history: HISTORY,
      handlers: {
        'changes.list': () => ({
          changes: [
            {
              changeId: 'c1',
              path: 'src/app.ts',
              kind: 'modify',
              status: 'pending',
              turnId: 't1',
              hunks: [],
              added: 3,
              removed: 1,
              createdAt: 1,
            },
          ],
        }),
      },
    })
    await open()

    await userEvent.click(await screen.findByRole('button', { name: '本轮 1 个文件 +3 −1' }))
    expect(screen.getByRole('dialog', { name: '会话信息' })).toBeTruthy()
  })

  it('starts with the session panel open on wide windows and can collapse it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { open } = setup({ history: HISTORY })
    await open()
    const toggle = screen.getByRole('button', { name: '会话信息' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows a mark when this turn loaded AGENTS.md and drops it on the next turn', async () => {
    const agentsMd = { sha256: 'a'.repeat(64), bytes: 4, truncated: false, lines: 2 }
    const { open, emit } = setup({
      history: HISTORY.map((event) =>
        event.type === 'turn.started' ? { ...event, payload: { context: { agentsMd } } } : event,
      ),
    })
    await open()
    expect(screen.getByLabelText('已加载项目说明 AGENTS.md（2 行）')).toBeTruthy()
    emit(
      ev(9, 'message.user', { messageId: 'm3', content: text('继续') }, 't2'),
      ev(10, 'turn.started', {}, 't2'),
    )
    expect(screen.queryByLabelText(/已加载项目说明/)).toBeNull()
  })

  it('shows a compaction divider that expands to the summary, and the omission note once', async () => {
    const { open } = setup({
      history: [
        ...HISTORY,
        ev(9, 'context.compacted', {
          summary: '只剩目标',
          coversTurns: ['t1', 't1'],
          tokensAfter: 12,
        }),
        ev(10, 'context.compacted', {
          summary: '',
          coversTurns: ['t1', 't1'],
          degraded: true,
          omittedToolCallIds: ['c1'],
        }),
      ],
    })
    await open()
    expect(messages().slice(0, 2)).toEqual(['你你好', '助手你好！fake-1'])
    expect(screen.getByRole('button', { name: /较早的对话已压缩/ })).toBeTruthy()
    expect(screen.getByText('较早的工具输出已省略，以腾出上下文。')).toBeTruthy()
    expect(screen.queryByText('只剩目标')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /较早的对话已压缩/ }))
    expect(screen.getByText('只剩目标')).toBeTruthy()
  })

  it('sends /compact as a compaction, not a user message', async () => {
    const { request, open } = setup({
      history: HISTORY,
      handlers: { 'session.compact': () => ({ compacted: true }) },
    })
    await open()
    await userEvent.type(input(), '/compact{Enter}')
    expect(request).toHaveBeenCalledWith('session.compact', { sessionId: 's1' })
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(input().value).toBe('')
  })

  it('shows the replayed history of the selected session', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    expect(request).toHaveBeenCalledWith('session.subscribe', { sessionId: 's1', afterSeq: 0 })
    expect(screen.getByRole('heading', { level: 2, name: '修复登录' })).toBeTruthy()
    expect(messages()).toEqual(['你你好', '助手你好！fake-1'])
    expect(stopButton()).toBeNull()
  })

  it('shows turn actions with the configured model name, token count and copy (M2-03)', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const provider = {
      id: 'fake',
      kind: 'openai',
      displayName: '测试供应商',
      baseUrl: 'https://example.com',
      models: [{ id: 'fake-1', displayName: '快' }],
    }
    const history = [
      ...HISTORY.slice(0, 6),
      ev(7, 'usage.reported', { model, usage: { inputTokens: 1200, outputTokens: 34 } }),
      ev(8, 'turn.completed', { durationMs: 10 }),
    ]
    const { open } = setup({
      history,
      handlers: { 'settings.get': () => ({ providers: [provider] }) },
    })
    await open()
    const copy = await screen.findByRole('button', { name: '复制本轮回复' })
    expect(within(copy.parentElement!).getByText('测试供应商 · 快')).toBeTruthy()
    expect(screen.getByText(/1,234 tokens/)).toBeTruthy()
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith('你好！')
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy()
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
    // 订阅返回前没有消息：只显示空状态引导，列表里没有消息条目。
    expect(screen.getByText('开始一个新任务')).toBeTruthy()
    expect(messages()).toEqual([])

    await act(async () => replay({ events: [created('新标题')], lastSeq: 1 }))
    expect(store.getState().views.s1?.lastSeq).toBe(1)
    expect(screen.getByRole('heading', { level: 2, name: '新标题' })).toBeTruthy()
  })

  it('streams the live reply and replaces it with the completed message once', async () => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    // 运行中发送按钮仍在（发送会作为引导注入当前轮），只是没有输入时禁用
    expect(sendButton()!.disabled).toBe(true)
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
      '助手你好！fake-1',
      '你再说一次',
      '助手思考过程想想好的，\n你好！[图片]读取{}等待执行fake-1',
    ])
    expect(screen.queryByRole('listitem', { busy: true })).toBeNull()
    expect(stopButton()).toBeNull()
  })

  it('sends with Enter, keeps Shift+Enter and composition for editing', async () => {
    const { request, open, emit } = setup({ history: HISTORY })
    await open()
    expect(sendButton()!.disabled).toBe(true)

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
    await userEvent.click(sendButton()!)
    expect(request).toHaveBeenLastCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('再来'),
    })
  })

  it('suggests files after @, inserts the pick and sends the mentions (ADR-0037)', async () => {
    const search = vi.fn(({ query }: { query: string }) => ({
      entries:
        query === ''
          ? [
              { path: 'src', kind: 'dir' },
              { path: 'README.md', kind: 'file' },
            ]
          : query === 'src/'
            ? [{ path: 'src/app.ts', kind: 'file' }]
            : [],
      truncated: query === 'src/',
    }))
    const { request, open } = setup({ history: HISTORY, handlers: { 'fs.search': search } })
    await open()

    await userEvent.type(input(), '看 @')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    expect(await within(list).findByText('README.md')).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith({ sessionId: 's1', query: '', limit: 50 })
    expect(input().getAttribute('aria-controls')).toBe('composer-mention-list')

    // Tab 进入文件夹，继续选
    await userEvent.keyboard('{Tab}')
    expect(input().value).toBe('看 @src/')
    expect(await within(screen.getByRole('listbox')).findByText('app.ts')).toBeTruthy()
    expect(screen.getByText('结果太多，只显示前面一部分，继续输入可以缩小范围')).toBeTruthy()
    await userEvent.keyboard('{Enter}')
    expect(input().value).toBe('看 @src/app.ts ')
    expect(screen.queryByRole('listbox', { name: '引用文件' })).toBeNull()
    expect(document.querySelector('[data-token="mention"]')?.textContent).toBe('@src/app.ts')

    // 没有匹配；Esc 关闭后 Enter 正常发送
    await userEvent.type(input(), '和 @zz')
    expect(await screen.findByText('没有匹配的文件或文件夹')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '引用文件' })).toBeNull()
    await userEvent.keyboard('{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('看 @src/app.ts 和 @zz'),
      mentions: [{ path: 'src/app.ts' }, { path: 'zz' }],
    })
  })

  it('picks a mention with the mouse and closes the list on an outside click', async () => {
    const search = vi.fn(() => ({
      entries: [
        { path: 'docs/a.md', kind: 'file' },
        { path: 'docs/b.md', kind: 'file' },
      ],
      truncated: false,
    }))
    const { open } = setup({ history: HISTORY, handlers: { 'fs.search': search } })
    await open()
    await userEvent.type(input(), '@do')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('a.md')
    await userEvent.keyboard('{ArrowDown}')
    expect(within(list).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe('composer-mention-1')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(within(list).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseDown(within(list).getByText('a.md'))
    expect(input().value).toBe('@docs/a.md ')

    await userEvent.type(input(), '@')
    await screen.findByRole('listbox', { name: '引用文件' })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox', { name: '引用文件' })).toBeNull()
  })

  it('runs a command picked with the mouse and closes the panel on an outside click', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '/')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
    await userEvent.type(input(), 'pla')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    // 鼠标移过某一行时它成为选中行
    fireEvent.mouseOver(within(list).getAllByRole('option')[0]!)
    expect(within(list).getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseDown(within(list).getAllByRole('option')[0]!)
    expect(planOn()).toBe(true)
    expect(input().value).toBe('')
  })

  it('lists enabled skills after / and sends the chosen one with the task', async () => {
    const skill = {
      name: 'review',
      description: '逐条审查改动',
      sha256: 'a'.repeat(64),
      source: 'user' as const,
      enabled: true,
      pinned: false,
      tokens: { index: 5, pinned: 12 },
      shadowed: false,
      hasScripts: false,
      files: [],
    }
    const { request, store, open } = setup({
      history: HISTORY,
      handlers: {
        'skill.list': () => ({ skills: [skill, { ...skill, name: 'off', enabled: false }] }),
      },
    })
    await open()
    store.setState({
      projects: [{ projectId: 'p1', name: 'demo', path: '/work', createdAt: 1 }],
    })
    await userEvent.type(input(), '/')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    expect(within(list).getByText('指令')).toBeTruthy()
    expect(within(list).getByText('技能')).toBeTruthy()
    expect(within(list).getByRole('option', { name: /\/review/ })).toBeTruthy()
    expect(within(list).queryByRole('option', { name: /\/off/ })).toBeNull()

    // 先补全成 `/review `，再写任务
    fireEvent.mouseDown(within(list).getByRole('option', { name: /\/review/ }))
    expect(input().value).toBe('/review ')
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
    await userEvent.type(input(), '看看改动{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('看看改动'),
      skills: [{ name: 'review' }],
    })
  })

  it('suggests agents first after @ and sends the picked one', async () => {
    const { request, store, open } = setup({
      history: HISTORY,
      handlers: {
        'agent.list': () => ({
          agents: [
            {
              agentId: 'user.review',
              name: { 'zh-CN': '审查员', 'en-US': 'Reviewer' },
              description: { 'zh-CN': '逐条审查改动' },
              source: 'user',
              archived: false,
              status: 'published',
              version: 1,
              hasDraft: false,
              modelMode: 'inherit',
              updatedAt: 1,
            },
            {
              agentId: 'user.helper',
              name: { 'zh-CN': '审查助手' },
              description: {},
              source: 'user',
              archived: false,
              status: 'published',
              version: 1,
              hasDraft: false,
              modelMode: 'inherit',
              updatedAt: 1,
            },
          ],
        }),
      },
    })
    await waitFor(() => expect(store.getState().agents).toHaveLength(2))
    await open()
    // 说明里的字也能搜到
    await userEvent.type(input(), '看 @逐条')
    expect(
      await within(await screen.findByRole('listbox', { name: '引用文件' })).findByText('审查员'),
    ).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await userEvent.clear(input())

    await userEvent.type(input(), '看 @审')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    const options = within(list).getAllByRole('option')
    expect(options[0]?.textContent).toContain('审查员')
    expect(options[1]?.textContent).toBe('审查助手')
    // 鼠标移过某一行时它成为选中行，再移回第一行选它
    fireEvent.mouseOver(options[1]!)
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseDown(options[0]!)
    expect(input().value).toBe('看 @审查员 ')
    await userEvent.type(input(), '看看{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('看 @审查员 看看'),
      agents: [{ agentId: 'user.review', name: '审查员' }],
    })
  })

  it('suggests only agents in the current delegation whitelist', async () => {
    const agentSummary = (agentId: string, name: string) => ({
      agentId,
      name: { 'zh-CN': name },
      description: {},
      source: 'user',
      archived: false,
      status: 'published',
      version: 1,
      hasDraft: false,
      modelMode: 'inherit',
      updatedAt: 1,
    })
    const { store, open } = setup({
      history: HISTORY,
      handlers: {
        'agent.list': () => ({
          agents: [
            agentSummary('builtin.explorer', '探索员'),
            agentSummary('builtin.coder', '编程助手'),
          ],
        }),
        'agent.delegationTargets': () => ({ enabled: true, agentIds: ['builtin.explorer'] }),
      },
    })
    await waitFor(() => expect(store.getState().agents).toHaveLength(2))
    await open()
    await userEvent.type(input(), '看 @探')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('探索员')
    expect(within(list).queryByText('编程助手')).toBeNull()

    // 委派关闭时一个 Agent 都不建议。
    cleanup()
    const off = setup({
      history: HISTORY,
      handlers: {
        'agent.list': () => ({ agents: [agentSummary('builtin.explorer', '探索员')] }),
        'agent.delegationTargets': () => ({ enabled: false, agentIds: [] }),
      },
    })
    await waitFor(() => expect(off.store.getState().agents).toHaveLength(1))
    await off.open()
    await userEvent.type(input(), '看 @探')
    await screen.findByRole('listbox', { name: '引用文件' })
    expect(screen.queryByText('探索员')).toBeNull()
  })

  it('inserts a dragged file as a mention', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '看 ')
    const form = input().closest('form')!
    const dataTransfer = {
      types: [FILE_DRAG_TYPE],
      getData: (type: string) =>
        type === FILE_DRAG_TYPE ? JSON.stringify({ path: 'docs/a.md', kind: 'file' }) : '',
      dropEffect: 'none',
    }
    // 外部拖进来的内容不提示
    fireEvent.dragOver(form, { dataTransfer: { ...dataTransfer, types: [] } })
    expect(form.className.split(' ')).not.toContain('ring-2')

    fireEvent.dragOver(form, { dataTransfer })
    expect(form.className.split(' ')).toContain('ring-2')
    // 拖到输入框里自己的元素上不算离开
    fireEvent(form, new MouseEvent('dragleave', { bubbles: true, relatedTarget: form }))
    expect(form.className.split(' ')).toContain('ring-2')
    fireEvent.dragLeave(form)
    expect(form.className.split(' ')).not.toContain('ring-2')

    // 不是本界面拖出的内容：不插入
    fireEvent.drop(form, { dataTransfer: { ...dataTransfer, types: [], getData: () => '' } })
    expect(input().value).toBe('看 ')

    fireEvent.drop(form, { dataTransfer })
    expect(input().value).toBe('看 @docs/a.md ')
  })

  it('does not start a plan turn while one is running', async () => {
    const { request, open } = setup({ history: RUNNING })
    await open()
    await userEvent.type(input(), '/plan 接着做')
    await userEvent.keyboard('{Enter}')
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    // 草稿保留，运行的这一轮仍可以停下
    expect(input().value).toBe('/plan 接着做')
    expect(stopButton()).not.toBeNull()
  })

  it('ignores a drop while a prompt is being sent', async () => {
    const { open } = setup({
      history: HISTORY,
      // 发送一直不返回：输入框保持“发送中”
      handlers: { 'session.prompt': () => new Promise(() => {}) },
    })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    expect(input().value).toBe('')
    const form = input().closest('form')!
    const dataTransfer = {
      types: [FILE_DRAG_TYPE],
      getData: () => JSON.stringify({ path: 'docs/a.md', kind: 'file' }),
      dropEffect: 'none',
    }
    fireEvent.dragOver(form, { dataTransfer })
    expect(form.className.split(' ')).not.toContain('ring-2')
    fireEvent.drop(form, { dataTransfer })
    expect(input().value).toBe('')
  })

  it('shows the turn as running between sending and turn.started', async () => {
    const { request, store, open, emit } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '你好{Enter}')
    // 排队或宿主启动中：还没有 turn.started
    expect(stopButton()).toBeTruthy()
    await userEvent.type(input(), '下一句')
    // 运行中也能发送（作为引导注入当前轮）
    expect(sendButton()).not.toBeNull()
    expect(store.getState().sessions[0]?.status).toBe('running')
    // 刷新列表时同样保留
    await act(() => store.getState().refreshSessions())
    expect(store.getState().sessions[0]?.status).toBe('running')
    // 中途的其他事件不清除等待
    emit(userMessage(9, 'm3', '你好'))

    emit(ev(10, 'turn.started', {}, 't2'), state(11, 'completed', 'thinking'))
    expect(store.getState().awaitingTurn).toEqual({})
    emit(ev(12, 'turn.completed', { durationMs: 10 }, 't2'), state(13, 'thinking', 'completed'))
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
    expect(sendButton()!.disabled).toBe(false)
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
    expect(stopButton()).toBeNull()
    expect(screen.getByText('已停止')).toBeTruthy()
    // 已输出的部分保留，并注明未完成
    expect(messages().at(-1)).toBe('助手说到（回复未完成）fake-1')
  })

  it.each([
    [
      '达到步数限额',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 50 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '已达到本轮最多 50 步，可以继续执行。',
    ],
    [
      '工具连续失败',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxConsecutiveToolErrors', value: 5 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '工具调用连续失败 5 次，本轮已停止，可以继续执行。',
    ],
    [
      '单轮时长',
      [
        ev(12, 'turn.limit_reached', { limit: 'maxTurnDurationMs', value: 600_000 }, 't2'),
        ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
        state(14, 'thinking', 'failed'),
      ],
      '本轮已运行超过 10 分钟，可以继续执行。',
    ],
    [
      '模型失败',
      [
        ev(12, 'turn.failed', { error: { code: 'model.unknown_error' }, retryable: false }, 't2'),
        state(13, 'thinking', 'failed'),
      ],
      '本轮失败：模型请求失败',
    ],
    [
      '宿主崩溃',
      [ev(12, 'session.crashed', { error: { code: 'host.exited' } })],
      'Agent 进程意外退出，可以从最后保存的位置继续。',
    ],
    [
      '应用退出后中断',
      [
        ev(12, 'turn.aborted', { reason: 'shutdown' }, 't2'),
        ev(13, 'run.state.changed', { from: 'thinking', to: 'interrupted', reason: 'app_restart' }),
      ],
      '本轮已中断，可以继续对话。',
    ],
  ])('explains how the last turn ended: %s', async (_name, events, note) => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    emit(...events)
    expect(screen.getByText(note)).toBeTruthy()
    expect(stopButton()).toBeNull()
    expect(sendButton()!.disabled).toBe(true)
    await userEvent.type(input(), '继续')
    expect(sendButton()!.disabled).toBe(false)
  })

  it('continues with one click after a limit stopped the turn', async () => {
    const { open, emit, request } = setup({ history: RUNNING })
    await open()
    emit(
      ev(12, 'turn.limit_reached', { limit: 'maxStepsPerTurn', value: 50 }, 't2'),
      ev(13, 'turn.failed', { error: { code: 'run.limit_reached' }, retryable: true }, 't2'),
      state(14, 'thinking', 'failed'),
    )
    await userEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(request).toHaveBeenCalledWith(
      'session.prompt',
      expect.objectContaining({ sessionId: 's1', content: [{ type: 'text', text: '继续' }] }),
    )
  })

  it('offers no continue button when a turn failed for another reason', async () => {
    const { open, emit } = setup({ history: RUNNING })
    await open()
    emit(
      ev(12, 'turn.failed', { error: { code: 'model.unknown_error' }, retryable: false }, 't2'),
      state(13, 'thinking', 'failed'),
    )
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull()
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
  })

  it('uses the current language', async () => {
    const { open } = setup({ history: RUNNING, locale: 'en-US' })
    await open()
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
    expect(card().textContent).toBe('运行npm test完成 5ms')
    expect(card().dataset.status).toBe('completed')
    const row = within(card()).getByRole('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(within(card()).queryByText(/line 1/)).toBeNull()
    // 展开后显示参数与完整输出
    await userEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(within(card()).getByText(/line 1/).textContent).toBe(lines(8))
    expect(within(card()).getByText(/"command": "npm test"/)).toBeTruthy()
    expect(within(card()).getByText('（输出过长，交给模型时已截断）')).toBeTruthy()
    await userEvent.click(row)
    expect(within(card()).queryByText(/line 1/)).toBeNull()
  })

  it('shows live output in a terminal card while running and the error when failed', async () => {
    const { open, emit } = setup({ history: toolTurn() })
    await open()
    expect(card().textContent).toContain('执行中')
    expect(within(card()).getByRole('figure', { name: '终端：npm test' })).toBeTruthy()
    emit({
      ...ev(9, 'tool.output.delta', { toolCallId: 'c1', stream: 'stdout', text: lines(7) }),
    })
    const log = within(card()).getByRole('log', { name: '命令输出' })
    expect(log.textContent).toContain('line 1')
    expect(log.textContent).toContain('line 7')
    emit(ev(9, 'tool.failed', { toolCallId: 'c1', error: { code: 'tool.denied' } }))
    expect(within(card()).queryByRole('figure')).toBeNull()
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
  const BEFORE = 'b'.repeat(40)
  const checkpoint = (seq: number, checkpointId = CHECKPOINT, turnId = 't1') =>
    ev(seq, 'checkpoint.created', { checkpointId, reason: 'turn_start' }, turnId)
  const plan = {
    before: BEFORE,
    files: [
      { path: 'src/new.ts', status: 'deleted' },
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/gone.ts', status: 'added' },
    ],
  }
  const dialog = (name: string) => screen.findByRole('dialog', { name })

  it('opens the undo dialog for the last turn with /undo', async () => {
    const { open, request } = setup({
      history: finished(checkpoint(13)),
      handlers: { 'checkpoint.preview': () => plan },
    })
    await open()
    await userEvent.type(input(), '/undo{Enter}')
    const confirm = await dialog('撤销第 1 轮的改动？')
    expect(request).toHaveBeenCalledWith('checkpoint.preview', {
      sessionId: 's1',
      checkpointId: CHECKPOINT,
    })
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('undoes the turn and then the restore', async () => {
    const { open, request, emit } = setup({
      history: finished(checkpoint(13)),
      handlers: {
        'checkpoint.preview': () => plan,
        'checkpoint.restore': () => plan,
      },
    })
    await open()
    // 第一轮不显示检查点分隔线，避免对话开头多一行提示。
    expect(screen.queryByRole('separator', { name: /^第 1 轮前已保存检查点 · / })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    const confirm = await dialog('撤销第 1 轮的改动？')
    expect(within(confirm).getByText(/对话记录保留/)).toBeTruthy()
    expect(
      within(within(confirm).getByRole('list', { name: '受影响的文件' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['src/app.ts恢复原内容', 'src/gone.ts恢复', 'src/new.ts删除'])
    expect(request).not.toHaveBeenCalledWith('checkpoint.restore', expect.anything())
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await userEvent.click(
      within(await dialog('撤销第 1 轮的改动？')).getByRole('button', { name: '撤销 3 个文件' }),
    )
    expect(request).toHaveBeenCalledWith('checkpoint.restore', {
      sessionId: 's1',
      checkpointId: CHECKPOINT,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 主进程写入恢复事件后显示恢复标记，可以撤销这次恢复
    emit(ev(14, 'checkpoint.created', { checkpointId: BEFORE, reason: 'before_restore' }))
    emit(ev(15, 'checkpoint.restored', { checkpointId: CHECKPOINT, truncateConversation: false }))
    expect(await screen.findByText(/^已撤销到第 1 轮开始之前 · /)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '撤销这次恢复' }))
    await userEvent.click(
      within(await dialog('撤销这次恢复？')).getByRole('button', { name: '撤销 3 个文件' }),
    )
    expect(request).toHaveBeenCalledWith('checkpoint.restore', {
      sessionId: 's1',
      checkpointId: BEFORE,
    })
    emit(ev(16, 'checkpoint.created', { checkpointId: 'c'.repeat(40), reason: 'before_restore' }))
    emit(ev(17, 'checkpoint.restored', { checkpointId: BEFORE, truncateConversation: false }))
    expect(await screen.findByText(/^已撤销上一次恢复 · /)).toBeTruthy()
    // 只有最近一次恢复可以撤销
    expect(screen.getAllByRole('button', { name: '撤销这次恢复' })).toHaveLength(1)
  })

  it('does not show a checkpoint divider between turns', async () => {
    const { open } = setup({
      history: [
        ...HISTORY,
        ev(9, 'message.user', { messageId: 'm3', content: text('继续') }, 't2'),
        ev(10, 'turn.started', {}, 't2'),
        ev(11, 'checkpoint.created', { checkpointId: CHECKPOINT, reason: 'turn_start' }, 't2'),
      ],
    })
    await open()
    expect(screen.getAllByRole('separator').filter((s) => s.tabIndex !== 0)).toEqual([])
    // 撤销入口仍在：左侧对话导航条可以回到某一轮之前。
    expect(screen.getByRole('navigation', { name: '对话导航' })).toBeTruthy()
  })

  it('cannot confirm when no file needs restoring', async () => {
    const { open } = setup({
      history: finished(checkpoint(13)),
      handlers: { 'checkpoint.preview': () => ({ before: BEFORE, files: [] }) },
    })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    const confirm = await dialog('撤销第 1 轮的改动？')
    expect(await within(confirm).findByText('文件和检查点时一样，没有需要恢复的。')).toBeTruthy()
    expect(
      (within(confirm).getByRole('button', { name: '撤销 0 个文件' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('reports a failed preview or restore', async () => {
    let failPreview = true
    const { open, store } = setup({
      history: finished(checkpoint(13)),
      handlers: {
        'checkpoint.preview': () => {
          if (failPreview) throw new RpcError('checkpoint.not_found')
          return plan
        },
        'checkpoint.restore': () => {
          throw new RpcError('run.busy')
        },
      },
    })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'checkpoint.not_found' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    failPreview = false
    await userEvent.click(screen.getByRole('button', { name: '撤销本轮' }))
    await userEvent.click(
      within(await dialog('撤销第 1 轮的改动？')).getByRole('button', { name: '撤销 3 个文件' }),
    )
    await waitFor(() => expect(store.getState().error).toEqual({ code: 'run.busy' }))
  })

  it('navigates turns from the rail and goes back to before a turn', async () => {
    const { open, request } = setup({
      history: finished(
        checkpoint(13),
        ev(14, 'message.user', { messageId: 'm4', content: text('再改一次') }, 't2'),
        ev(15, 'turn.started', {}, 't2'),
        checkpoint(16, 'd'.repeat(40), 't2'),
        ev(
          17,
          'message.assistant.completed',
          { messageId: 'm5', content: text('好'), model },
          't2',
        ),
        ev(18, 'turn.completed', { durationMs: 1 }, 't2'),
        ev(19, 'run.state.changed', { from: 'thinking', to: 'completed' }, 't2'),
      ),
      handlers: {
        'checkpoint.preview': () => plan,
        'changes.list': () => ({
          changes: [
            {
              changeId: 'x1',
              sessionId: 's1',
              turnId: 't1',
              path: 'a.ts',
              kind: 'modify',
              status: 'pending',
              added: 1,
              removed: 0,
              createdAt: 1,
            },
          ],
        }),
      },
    })
    await open()
    // 不再显示轮次之间的检查点分隔线；左侧导航条提供同等入口。
    expect(screen.getAllByRole('separator').filter((s) => s.tabIndex !== 0)).toEqual([])
    const rail = screen.getByRole('navigation', { name: '对话导航' })
    const first = within(rail).getByRole('button', { name: '跳到第 1 轮：跑测试' })
    const scrolled = vi.fn()
    const target = document.querySelector<HTMLElement>('[data-turn="t1"]')!
    target.scrollIntoView = scrolled
    await userEvent.click(first)
    expect(scrolled).toHaveBeenCalled()

    await userEvent.hover(first)
    const preview = within(rail).getByRole('group', { name: '第 1 轮' })
    expect(preview.textContent).toContain('改动了 1 个文件')
    expect(preview.textContent).toContain('跑测试')
    expect(preview.textContent).toContain('完成')
    await userEvent.click(within(preview).getByRole('button', { name: '回到这一轮之前' }))
    expect(await dialog('撤销第 1 轮及之后的改动？')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('checkpoint.preview', {
      sessionId: 's1',
      checkpointId: CHECKPOINT,
    })
    await userEvent.keyboard('{Escape}')
    await userEvent.unhover(first)
    expect(within(rail).queryByRole('group')).toBeNull()
  })

  it('has no rail with a single turn and no undo button without checkpoints', async () => {
    const { open } = setup({ history: finished() })
    await open()
    expect(screen.queryByRole('button', { name: '撤销本轮' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: '对话导航' })).toBeNull()
  })

  it('disables undo while the session is running', async () => {
    const { open } = setup({ history: [...finished(checkpoint(13))] })
    await open()
    expect((screen.getByRole('button', { name: '撤销本轮' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    await userEvent.type(screen.getByLabelText('输入消息'), '继续{Enter}')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '撤销本轮' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
  })
})

describe('Composer (M2-04)', () => {
  const capabilities = {
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: false,
  }
  const providers = [
    {
      id: 'fake',
      kind: 'openai',
      displayName: '测试供应商',
      baseUrl: 'https://example.com',
      models: [
        { id: 'fake-1', displayName: '快', ...capabilities },
        { id: 'fake-2', displayName: '强', ...capabilities },
      ],
    },
  ]
  const withModel = [
    ev(1, 'session.created', {
      projectId: 'p1',
      projectPath: '/work',
      workspacePath: '/work',
      title: '修复登录',
      model,
    }),
    ...HISTORY.slice(1, 6),
    ev(7, 'usage.reported', { model, usage: { inputTokens: 20_000, outputTokens: 5_000 } }),
    ev(8, 'turn.completed', { durationMs: 10 }),
    state(9, 'thinking', 'completed'),
  ]

  it('switches the session model for the next turn', async () => {
    let settings: object = { providers, permissionMode: 'ask' }
    const { request, open, emit } = setup({
      history: withModel,
      handlers: {
        'settings.get': () => settings,
        'settings.update': (patch: object) => (settings = { ...settings, ...patch }),
      },
    })
    await open()
    const trigger = await screen.findByRole('button', { name: '模型：测试供应商 · 快' })
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('menuitem', { name: /强/ }))
    expect(request).toHaveBeenCalledWith('session.setModel', {
      sessionId: 's1',
      model: { providerId: 'fake', modelId: 'fake-2' },
    })
    emit(ev(10, 'session.model.changed', { model: { providerId: 'fake', modelId: 'fake-2' } }))
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 强' })).toBeTruthy()
  })

  it('hides disabled models from the menu but keeps the current name (M2-10)', async () => {
    const disabled = [
      {
        ...providers[0]!,
        models: providers[0]!.models.map((m) => ({ ...m, enabled: false })),
      },
    ]
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers: disabled }) },
    })
    await open()
    const trigger = await screen.findByRole('button', { name: '模型：测试供应商 · 快' })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
  })

  it('changes the permission mode and shows the context usage', async () => {
    let settings: object = { providers }
    const { request, open } = setup({
      history: withModel,
      handlers: {
        'settings.get': () => settings,
        'settings.update': (patch: object) => (settings = { ...settings, ...patch }),
      },
    })
    await open()
    expect(
      await screen.findByRole('button', {
        name: '上下文已用 25%（25,000 / 100,000 tokens）',
      }),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /自动/ }))
    expect(request).toHaveBeenCalledWith('settings.update', { permissionMode: 'auto' })
    expect(await screen.findByRole('button', { name: '权限模式：自动' })).toBeTruthy()
  })

  it('opens the context breakdown without listing individual skills', async () => {
    const snapshot = {
      snapshotId: 'snap1',
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'builtin.coder', version: 1 },
      model,
      createdAt: 8,
      tokens: 100,
      systemPrompt: [
        { title: 'Base prompt', text: 'base', tokens: 52 },
        { title: 'Skills', text: '- tdd: 测试驱动', tokens: 30 },
      ],
      skills: [{ name: 'tdd', description: '测试驱动', pinned: false, tokens: 30 }],
      tools: [{ name: 'read_file', description: 'read', tokens: 10 }],
      history: { messages: 1, tokens: 8, preview: [] },
    }
    const { request, open } = setup({
      history: withModel,
      handlers: {
        'settings.get': () => ({ providers }),
        'run.inspect': () => ({
          tree: { sessionId: 's1', rootRunId: 'r1', generatedAt: 1, runs: [] },
          snapshots: [snapshot],
          settings: { projectPath: '.', workspacePath: '.', permissionRules: [] },
        }),
      },
    })
    await open()
    await userEvent.click(
      await screen.findByRole('button', {
        name: '上下文已用 25%（25,000 / 100,000 tokens）',
      }),
    )
    expect(await screen.findByRole('list', { name: '上下文 token 明细' })).toBeTruthy()
    expect(screen.getByText('最近报告的占用')).toBeTruthy()
    expect(screen.getByText('25.0K / 100K tokens')).toBeTruthy()
    expect(screen.getByText('系统提示词')).toBeTruthy()
    expect(screen.getByText('技能')).toBeTruthy()
    expect(screen.getByText('工具定义')).toBeTruthy()
    expect(screen.getByText('历史消息')).toBeTruthy()
    expect(screen.queryByText('tdd')).toBeNull()
    expect(screen.queryByText('测试驱动')).toBeNull()
    expect(request).toHaveBeenCalledWith('run.inspect', { sessionId: 's1' })
  })

  it('stops with Esc while running', async () => {
    const { request, open } = setup({ history: RUNNING })
    await open()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(request).toHaveBeenCalledWith('session.abort', { sessionId: 's1' }))
  })

  it('does not stop on Esc when idle', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(request).not.toHaveBeenCalledWith('session.abort', expect.anything())
  })

  it('toggles plan mode and sends the next turn in plan mode', async () => {
    const { request, open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    expect(planOn()).toBe(false)
    await userEvent.type(input(), '/plan{Enter}')
    expect(planOn()).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: '退出计划模式' }))
    expect(planOn()).toBe(false)
    await userEvent.type(input(), '/plan{Enter}')
    expect(input().placeholder).toBe('描述要做的事。这一轮只会阅读项目并提出计划')
    await userEvent.type(input(), '先看看{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: [{ type: 'text', text: '先看看' }],
      mode: 'plan',
    })
  })

  it('toggles plan mode with Ctrl+Shift+P and leaves Shift+Tab to focus navigation', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    const pressed = () => String(planOn())
    expect(pressed()).toBe('false')

    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })
    expect(pressed()).toBe('false')

    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(pressed()).toBe('true')
    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(pressed()).toBe('false')

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inside = document.createElement('button')
    dialog.append(inside)
    document.body.append(dialog)
    fireEvent.keyDown(inside, { key: 'P', ctrlKey: true, shiftKey: true })
    dialog.remove()
    expect(pressed()).toBe('false')

    const prevented = new KeyboardEvent('keydown', {
      key: 'P',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    })
    prevented.preventDefault()
    window.dispatchEvent(prevented)
    expect(pressed()).toBe('false')
  })

  it('uses warning and danger context tones and falls back to the model id', async () => {
    const unnamed = [
      {
        ...providers[0]!,
        models: [{ ...providers[0]!.models[0]!, displayName: undefined }],
      },
    ]
    const { emit, open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers: unnamed }) },
    })
    await open()
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · fake-1' })).toBeTruthy()
    emit(ev(10, 'usage.reported', { model, usage: { inputTokens: 75_000, outputTokens: 0 } }))
    expect(
      await screen.findByRole('button', { name: '上下文已用 75%（75,000 / 100,000 tokens）' }),
    ).toBeTruthy()
    emit(ev(11, 'usage.reported', { model, usage: { inputTokens: 95_000, outputTokens: 0 } }))
    expect(
      await screen.findByRole('button', { name: '上下文已用 95%（95,000 / 100,000 tokens）' }),
    ).toBeTruthy()
  })

  it('opens the slash command panel and filters commands', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.id),
    ).toEqual(
      [
        'plan',
        'model',
        'compact',
        'undo',
        'new',
        'files',
        'diff',
        'brief',
        'settings',
      ].map((id) => `composer-command-${id}`),
    )
    await userEvent.type(input(), 'mo')
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toContain('/model')
  })

  it('highlights the command, urls and code behind the draft', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    const draft = '/plan 看 https://a.dev 和 `x`'
    await userEvent.type(input(), draft)
    const layer = document.querySelector('[data-composer-highlight]')
    expect(layer?.textContent).toBe(draft)
    expect(
      [...(layer?.querySelectorAll('[data-token]') ?? [])].map((el) =>
        el.getAttribute('data-token'),
      ),
    ).toEqual(['command', 'url', 'code'])
    expect(input().value).toBe(draft)
  })

  it('runs /plan from the command panel', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/plan{Enter}')
    expect(planOn()).toBe(true)
    expect(input().value).toBe('')
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
  })

  it('runs /compact from the command panel', async () => {
    const { request, open } = setup({
      history: HISTORY,
      handlers: { 'session.compact': () => ({ compacted: true }) },
    })
    await open()
    await userEvent.type(input(), '/compact{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.compact', { sessionId: 's1' }),
    )
    expect((await screen.findByText(/已压缩当前会话/)).textContent).toContain('/compact')
    expect(input().value).toBe('')
  })

  it('reports when there is nothing to compact', async () => {
    const { request, open } = setup({
      history: HISTORY,
      handlers: { 'session.compact': () => ({ compacted: false }) },
    })
    await open()
    await userEvent.type(input(), '/compact{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.compact', { sessionId: 's1' }),
    )
    expect((await screen.findByText(/没有可压缩的内容/)).textContent).toContain('/compact')
    expect(input().value).toBe('')
  })

  it('opens the model picker from the command panel', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/model{Enter}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /强/ })).toBeTruthy()
    expect(input().value).toBe('')
  })

  it('sends an unmatched slash draft as a normal message', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '/foo{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '/foo' }],
      }),
    )
  })

  it('completes a command with Tab and closes the panel with Escape', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/mo')
    await userEvent.keyboard('{Tab}')
    // 收参数的指令补全时带一个空格，面板随之收起，可以接着写参数。
    expect(input().value).toBe('/model ')
    await waitFor(() => expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull())
    await userEvent.clear(input())
    await userEvent.type(input(), '/comp')
    await userEvent.keyboard('{Tab}')
    expect(input().value).toBe('/compact')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull())
    expect(input().value).toBe('/compact')
  })

  it('moves the highlight with arrow keys', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/')
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(planOn()).toBe(true)
  })

  it('runs commands with arguments typed after the name', async () => {
    const { request, open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/plan 重构输入框{Enter}')
    expect(request).toHaveBeenCalledWith(
      'session.prompt',
      expect.objectContaining({ sessionId: 's1', content: text('重构输入框'), mode: 'plan' }),
    )
    expect(planOn()).toBe(false)

    await userEvent.type(input(), '/model 强{Enter}')
    expect(request).toHaveBeenCalledWith('session.setModel', {
      sessionId: 's1',
      model: { providerId: 'fake', modelId: 'fake-2' },
    })
    expect(await screen.findByText('已切换到 强')).toBeTruthy()

    await userEvent.type(input(), '/model 不存在{Enter}')
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByText(/没有找到“不存在”/)).toBeTruthy()
    await userEvent.keyboard('{Escape}')
  })

  it('sends a no-argument command followed by text as a normal message', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '/files 在哪{Enter}')
    expect(request).toHaveBeenCalledWith('session.prompt', {
      sessionId: 's1',
      content: text('/files 在哪'),
    })
  })

  it('opens panels, settings and a new chat from commands', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/files{Enter}')
    expect(await screen.findByRole('tab', { name: /文件/, selected: true })).toBeTruthy()

    await userEvent.type(input(), '/settings mcp{Enter}')
    expect(await screen.findByRole('heading', { name: 'MCP 服务' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'MCP 服务' })).toBeNull())

    await userEvent.type(input(), '/settings 权限{Enter}')
    expect(await screen.findByRole('heading', { name: '权限与审批' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByLabelText('输入消息')).toBeTruthy())

    await userEvent.type(input(), '/new{Enter}')
    await waitFor(() => expect(screen.queryByRole('heading', { name: '修复登录' })).toBeNull())
  })

  it('greys out commands that cannot run now and keeps the draft', async () => {
    const { open } = setup({ history: RUNNING })
    await open()
    await userEvent.type(input(), '/')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    const compact = within(list).getByRole('option', { name: /\/compact/ })
    expect(compact.getAttribute('aria-disabled')).toBe('true')
    expect(compact.textContent).toContain('运行中不可用')
    expect(
      within(list)
        .getByRole('option', { name: /\/undo/ })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    expect(
      within(list)
        .getByRole('option', { name: /\/files/ })
        .getAttribute('aria-disabled'),
    ).toBe('false')
    await userEvent.type(input(), 'compact{Enter}')
    expect(input().value).toBe('/compact')
    expect(
      await screen.findByText('运行中不可用', { selector: '[role="status"] *, [role="status"]' }),
    ).toBeTruthy()
  })

  it('keeps an unmatched command draft and focuses the composer from its background', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/zzz')
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Tab}')
    expect(input().value).toBe('/zzz')

    await userEvent.clear(input())
    await userEvent.type(input(), '/p')
    await userEvent.keyboard('{ArrowUp}')
    const form = document.querySelector('form')
    expect(form).toBeTruthy()
    fireEvent.click(form!)
    expect(document.activeElement).toBe(input())
  })

  it('does not open the model picker when no model is available', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers: [] }) },
    })
    await open()
    await userEvent.type(input(), '/model{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('runs the highlighted command from the send button', async () => {
    const { request, open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/plan')
    await userEvent.click(sendButton())
    expect(planOn()).toBe(true)
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())
  })

  it('reopens the panel after the draft leaves the slash form', async () => {
    const { open } = setup({
      history: withModel,
      handlers: { 'settings.get': () => ({ providers }) },
    })
    await open()
    await userEvent.type(input(), '/pl')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
    await userEvent.clear(input())
    await userEvent.type(input(), '/')
    expect(await screen.findByRole('listbox', { name: '输入指令' })).toBeTruthy()
  })

  it('does not run or send on Enter while composing', async () => {
    const { request, open } = setup({ history: HISTORY })
    await open()
    await userEvent.type(input(), '/plan')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(input().value).toBe('/plan')
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(request).not.toHaveBeenCalledWith('session.compact', expect.anything())
  })
})

describe('file changes (M2-07)', () => {
  const change = {
    changeId: 'c1',
    path: 'src/app.ts',
    kind: 'modify',
    status: 'pending',
    turnId: 't1',
    hunks: [],
    added: 3,
    removed: 1,
    createdAt: 1,
  }

  it('shows session changes in the right panel and the turn changes under the last reply', async () => {
    const { open } = setup({
      history: HISTORY,
      handlers: { 'changes.list': () => ({ changes: [change] }) },
    })
    await open()
    const list = screen.getByRole('list', { name: '消息' })
    const turn = within(list).getByRole('region', { name: '本轮变更' })
    expect(within(turn).getByRole('button', { name: /src\/app\.ts/ })).toBeTruthy()
    // 改动入口在对话里：面板收起时点「本轮变更」标题直接在右侧打开改动页面。
    await userEvent.click(within(turn).getByRole('button', { name: '在右侧查看全部改动' }))
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(within(panel).getByRole('tab', { name: '改动' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(await within(panel).findByRole('region', { name: '本会话的改动' })).toBeTruthy()
  })

  it('hides both while the session has no changes', async () => {
    const { open } = setup({ history: HISTORY })
    await open()
    expect(screen.queryByRole('region', { name: '本轮变更' })).toBeNull()
    await showPanel()
    const panel = screen.getByRole('dialog', { name: '会话信息' })
    expect(within(panel).queryByText('还没有文件改动。')).toBeNull()
    await userEvent.click(within(panel).getByRole('button', { name: '打开其他面板' }))
    expect(await screen.findByRole('menuitem', { name: '文件' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '改动' })).toBeNull()
  })
})

describe('delegation cards', () => {
  it('shows child tasks as delegation cards, hides child messages, and keeps child approvals there', async () => {
    const childApproval = {
      approvalId: 'a1',
      toolCallId: 'tc1',
      runId: 'c1',
      parentRunId: 'r1',
      agent: { id: 'builtin.reviewer', version: 1 },
      tool: { name: 'write_file', category: 'write' as const },
      input: { path: 'src/a.ts' },
      targets: { paths: ['src/a.ts'] },
      kind: 'tool' as const,
      preview: { summary: '写入 src/a.ts' },
      reasonCode: 'permission.category_default',
      matchedRuleIds: [],
    }
    const delegated = [
      created('修复登录'),
      runCreated(2),
      userMessage(3, 'm1', '你好'),
      ev(4, 'turn.started', {}),
      state(5, 'idle', 'thinking'),
      completed(6, 'm2', '你好！'),
      ev(7, 'run.delegated', {
        childRunId: 'c1',
        agent: { id: 'builtin.reviewer', version: 1 },
        task: '检查登录流程',
        workspace: 'shared',
      }),
      {
        ...ev(
          8,
          'run.created',
          {
            agent: { id: 'builtin.reviewer', version: 1 },
            model,
            mode: 'unattended',
            limits,
          },
          'ct1',
        ),
        runId: 'c1',
        parentRunId: 'r1',
      } as EventEnvelope,
      {
        ...ev(9, 'message.user', { messageId: 'cm1', content: text('子任务输入') }, 'ct1'),
        runId: 'c1',
        parentRunId: 'r1',
      } as EventEnvelope,
    ]
    const { open } = setup({
      history: delegated,
      handlers: {
        'approval.pending': () => ({ approvals: [childApproval] }),
      },
    })
    await open()
    const card = await screen.findByRole('article', { name: '委派任务：检查登录流程' })
    expect(within(card).getByRole('article', { name: '需要审批：write_file' })).toBeTruthy()
    expect(screen.queryByText('子任务输入')).toBeNull()
    expect(screen.getAllByRole('article', { name: '需要审批：write_file' })).toHaveLength(1)
  })
})
