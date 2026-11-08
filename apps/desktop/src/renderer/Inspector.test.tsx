// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary, RunInspectResult, RunTreeNode, RunUsage } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { Inspector } from './Inspector.js'
import { inspectionKey, type SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')
const model = { providerId: 'fake', modelId: 'fake-1' }

const usage = (inputTokens: number, outputTokens: number): RunUsage => ({
  inputTokens,
  outputTokens,
  modelCalls: 1,
  toolCalls: 2,
  durationMs: 1200,
})

const node = (
  runId: string,
  agentId: string,
  parentRunId: string | undefined,
  turnId: string,
): RunTreeNode => ({
  runId,
  ...(parentRunId === undefined ? {} : { parentRunId }),
  agent: { id: agentId, version: 1 },
  model,
  mode: 'interactive',
  state: 'completed',
  createdAt: 1,
  updatedAt: 2,
  durationMs: 1,
  limits: { maxStepsPerTurn: 10, maxTokensPerTurn: 1000 },
  usage: usage(10, 5),
  turns: [
    {
      turnId,
      startedAt: 1,
      endedAt: 2,
      status: 'completed',
      usage: usage(10, 5),
      steps: [
        {
          stepId: `${runId}-step`,
          model,
          startedAt: 1,
          endedAt: 2,
          finishReason: 'stop',
          usage: usage(10, 5),
          toolCalls: [
            {
              toolCallId: `${runId}-tool`,
              name: 'read_file',
              status: 'completed',
              requestedAt: 1,
              startedAt: 1,
              endedAt: 2,
              durationMs: 1,
            },
          ],
        },
      ],
    },
  ],
})

const result: RunInspectResult = {
  tree: {
    sessionId: 's1',
    rootRunId: 'r1',
    generatedAt: 10,
    runs: [
      node('r1', 'builtin.coder', undefined, 't1'),
      node('c1', 'builtin.reviewer', 'r1', 'ct1'),
    ],
  },
  snapshots: [
    {
      snapshotId: 'snap1',
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'builtin.coder', version: 1 },
      model,
      createdAt: 9,
      tokens: 100,
      systemPrompt: [{ title: '基础指令', text: '你是编程助手', tokens: 40 }],
      skills: [{ name: 'tdd', description: '测试驱动', pinned: true, tokens: 10 }],
      tools: [{ name: 'read_file', description: '读取文件', tokens: 20 }],
      history: {
        messages: 2,
        tokens: 25,
        preview: [{ role: 'user', text: '你好', tokens: 5, ts: 8 }],
      },
      compaction: { summary: '之前的目标', coversTurns: ['t0', 't1'] },
    },
  ],
  settings: {
    projectPath: '.',
    workspacePath: '.',
    permissionRules: [
      {
        id: 'rule1',
        scope: 'project',
        effect: 'ask',
        match: { category: ['execute'], command: ['npm test'] },
        source: 'user',
      },
    ],
  },
}

function setup(
  entry: {
    result?: RunInspectResult
    error?: { code: string }
    loading?: boolean
    noData?: boolean
    agents?: readonly AgentSummary[]
    delegations?: readonly DelegationView[]
  } = {},
) {
  const key = inspectionKey('s1')
  const childKey = inspectionKey('s1', 'c1')
  const inspectRun = vi.fn(async () => entry.result ?? result)
  const childResult: RunInspectResult = {
    ...result,
    tree: {
      ...result.tree,
      rootRunId: 'c1',
      runs: [result.tree.runs[1]!],
    },
  }
  const store = createStore<Record<string, unknown>>(() => ({
    agents: entry.agents,
    inspections: {
      [key]: entry.noData
        ? { loading: false, result: undefined, error: undefined }
        : entry.loading
          ? { loading: true, result: undefined, error: undefined }
          : entry.error
            ? { loading: false, result: undefined, error: entry.error }
            : { loading: false, result: entry.result ?? result, error: undefined },
      [childKey]: { loading: false, result: childResult, error: undefined },
    },
    inspectRun,
  })) as unknown as SessionStore
  const onLocate = vi.fn()
  const onOpenChanges = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <Inspector
          sessionId="s1"
          onLocate={onLocate}
          delegations={entry.delegations ?? []}
          onOpenChanges={onOpenChanges}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { inspectRun, onLocate, onOpenChanges }
}

afterEach(cleanup)

describe('Inspector', () => {
  it('renders the four inspector tabs', () => {
    setup()
    const panel = screen.getByRole('tabpanel', { name: '时间线' })
    expect(within(panel).getByRole('list', { name: '运行树' })).toBeTruthy()
    for (const name of ['时间线', '上下文', '用量', '设置']) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
  })

  it('expands and collapses a run, then locates a turn in the conversation', async () => {
    const user = userEvent.setup()
    const { onLocate } = setup()
    const collapse = screen.getByRole('button', { name: '收起运行：编程助手' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '打开子运行' })).toBeTruthy()

    await user.click(collapse)
    expect(collapse.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '打开子运行' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '展开运行：编程助手' }))
    expect(screen.getByRole('button', { name: '打开子运行' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '定位到第 1 轮' }))
    expect(onLocate).toHaveBeenCalledWith('r1', 't1')
  })

  it('opens a child run read-only and returns to the parent', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: '打开子运行' }))
    expect(await screen.findByRole('button', { name: '返回父运行' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起运行：builtin.reviewer' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回父运行' }))
    expect(screen.getByRole('button', { name: '收起运行：编程助手' })).toBeTruthy()
  })

  it('opens the change set from a child run node (M4-10)', async () => {
    const user = userEvent.setup()
    const { onOpenChanges } = setup({
      delegations: [
        {
          childRunId: 'c1',
          parentRunId: 'r1',
          agent: { id: 'builtin.reviewer', version: 1 },
          task: '检查登录流程',
          workspace: 'isolated',
          workspacePath: undefined,
          budget: undefined,
          turnId: 't1',
          createdAt: 1,
          completed: {
            status: 'completed',
            summary: undefined,
            usage: undefined,
            changeSetId: 'cs1',
            issues: undefined,
          },
        },
      ],
    })
    await user.click(screen.getByRole('button', { name: '查看改动' }))
    expect(onOpenChanges).toHaveBeenCalledWith('cs1')
  })

  it('does not offer locating turns for child runs outside the main conversation', async () => {
    const user = userEvent.setup()
    setup()
    const expand = screen.getByRole('button', { name: '展开运行：builtin.reviewer' })
    const child = expand.closest('li')
    expect(child).not.toBeNull()
    await user.click(expand)
    expect(
      within(child as HTMLElement).queryByRole('button', { name: /^定位到第 1 轮/ }),
    ).toBeNull()
  })

  it('shows the latest context snapshot and its token breakdown', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('tab', { name: '上下文' }))
    expect(screen.getByText('系统提示词各部分')).toBeTruthy()
    expect(screen.getByText('基础指令')).toBeTruthy()
    expect(screen.getByText('tdd')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByRole('list', { name: '上下文 token 明细' })).toBeTruthy()
    expect(screen.getByText('之前的目标')).toBeTruthy()
  })

  it('shows context empty states and the latest snapshot with no content', async () => {
    const user = userEvent.setup()
    const { inspectRun } = setup({
      result: { ...result, snapshots: [] },
    })
    await user.click(screen.getByRole('tab', { name: '上下文' }))
    expect(screen.getByText('还没有上下文快照。')).toBeTruthy()
    expect(screen.getByText('下一次模型调用前会保存实际发送的上下文。')).toBeTruthy()
    expect(inspectRun).toHaveBeenCalledWith('s1')
    cleanup()

    const { compaction: _compaction, ...previous } = result.snapshots[0]!
    const latest = {
      ...previous,
      snapshotId: 'snap2',
      createdAt: 20,
      tokens: 0,
      systemPrompt: [],
      skills: [],
      tools: [],
      history: { messages: 0, tokens: 0, preview: [] },
    }
    setup({ result: { ...result, snapshots: [latest, result.snapshots[0]!] } })
    await user.click(screen.getByRole('tab', { name: '上下文' }))
    expect(screen.getByText('历史消息（0 条）')).toBeTruthy()
    expect(screen.getAllByText('无')).toHaveLength(4)
    expect(screen.queryByText('之前的目标')).toBeNull()
  })

  it('opens a turn to show steps and tool calls', async () => {
    const user = userEvent.setup()
    setup()
    const turn = screen.getByRole('button', { name: /^第 1 轮/ })
    expect(turn.getAttribute('aria-expanded')).toBe('false')
    await user.click(turn)
    expect(turn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('步骤 1')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getAllByText('完成').length).toBeGreaterThan(1)
    await user.click(turn)
    expect(screen.queryByText('步骤 1')).toBeNull()
  })

  it('falls back to the first run, shows failed states and runs without turns or steps', async () => {
    const user = userEvent.setup()
    const root = result.tree.runs[0]!
    setup({
      result: {
        ...result,
        tree: {
          ...result.tree,
          rootRunId: 'missing',
          runs: [{ ...root, state: 'failed', turns: [] }],
        },
      },
    })
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('还没有轮次')).toBeTruthy()

    cleanup()
    const noSteps = {
      ...root,
      turns: [{ ...root.turns[0]!, steps: [] }],
    }
    setup({ result: { ...result, tree: { ...result.tree, runs: [noSteps] } } })
    await user.click(screen.getByRole('button', { name: /^第 1 轮/ }))
    expect(screen.getByText('还没有步骤')).toBeTruthy()
  })

  it('groups usage by agent and shows settings and permission rules', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('tab', { name: '用量' }))
    expect(screen.getByText('按 Agent 分组')).toBeTruthy()
    expect(screen.getByText('builtin.reviewer')).toBeTruthy()
    expect(screen.getAllByText('v1 · 1 个运行')).toHaveLength(2)

    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByText('生效的权限规则')).toBeTruthy()
    expect(screen.getByText('询问')).toBeTruthy()
    expect(screen.getByText('category: execute · command: npm test')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
  })

  it('shows session usage and selected child usage', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('tab', { name: '用量' }))
    expect(screen.getByText('本会话')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: '时间线' }))
    await user.click(screen.getByRole('button', { name: '打开子运行' }))
    await user.click(await screen.findByRole('tab', { name: '用量' }))
    expect(screen.getByText('本运行')).toBeTruthy()
  })

  it('uses configured agent names and adds cache token usage', async () => {
    const user = userEvent.setup()
    const agents = [
      {
        agentId: 'builtin.coder',
        name: { 'zh-CN': '主助手', 'en-US': 'Main assistant' },
        description: { 'zh-CN': '', 'en-US': '' },
        source: 'builtin',
        archived: false,
        status: 'published',
        version: 1,
        hasDraft: false,
        modelMode: 'inherit',
        updatedAt: 1,
      },
      {
        agentId: 'builtin.reviewer',
        name: { 'zh-CN': '审核员', 'en-US': 'Reviewer' },
        description: { 'zh-CN': '', 'en-US': '' },
        source: 'builtin',
        archived: false,
        status: 'published',
        version: 1,
        hasDraft: false,
        modelMode: 'inherit',
        updatedAt: 1,
      },
    ] as readonly AgentSummary[]
    const withCache = (node: RunTreeNode): RunTreeNode => ({
      ...node,
      usage: { ...node.usage, cacheReadTokens: 4 },
      turns: node.turns.map((turn) => ({
        ...turn,
        usage: { ...turn.usage, cacheReadTokens: 4 },
        steps: turn.steps.map((step) => ({
          ...step,
          usage: { ...step.usage, cacheReadTokens: 4 },
        })),
      })),
    })
    setup({
      agents,
      result: {
        ...result,
        tree: { ...result.tree, runs: result.tree.runs.map(withCache) },
      },
    })
    expect(screen.getByText('主助手')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '用量' }))
    expect(screen.getByText('审核员')).toBeTruthy()
    expect(screen.getByText('本会话')).toBeTruthy()
  })

  it('renders every permission effect, empty matches and a run awaiting approval', async () => {
    const user = userEvent.setup()
    const root = result.tree.runs[0]!
    setup({
      result: {
        ...result,
        settings: {
          ...result.settings,
          permissionRules: [
            { ...result.settings.permissionRules[0]!, id: 'allow', effect: 'allow' },
            { ...result.settings.permissionRules[0]!, id: 'deny', effect: 'deny' },
            {
              ...result.settings.permissionRules[0]!,
              id: 'all',
              effect: 'ask',
              match: {},
            },
          ],
        },
        tree: {
          ...result.tree,
          runs: [{ ...root, state: 'awaiting_approval' }],
        },
      },
    })
    expect(screen.getByText('等待审批')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByText('允许')).toBeTruthy()
    expect(screen.getByText('拒绝')).toBeTruthy()
    expect(screen.getByText('匹配所有调用')).toBeTruthy()
  })

  it('shows a running step without a finish reason and without a tool duration', async () => {
    const user = userEvent.setup()
    const root = result.tree.runs[0]!
    const step = root.turns[0]!.steps[0]!
    const { finishReason: _finishReason, ...runningStep } = step
    const { durationMs: _durationMs, ...runningTool } = step.toolCalls[0]!
    setup({
      result: {
        ...result,
        tree: {
          ...result.tree,
          runs: [
            {
              ...root,
              turns: [
                {
                  ...root.turns[0]!,
                  steps: [
                    {
                      ...runningStep,
                      toolCalls: [runningTool],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    })
    await user.click(screen.getByRole('button', { name: /^第 1 轮/ }))
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
  })

  it('shows unlimited limits and no permission rules', async () => {
    const user = userEvent.setup()
    setup({
      result: {
        ...result,
        settings: { ...result.settings, permissionRules: [] },
        tree: {
          ...result.tree,
          runs: [{ ...result.tree.runs[0]!, limits: {} }, result.tree.runs[1]!],
        },
      },
    })
    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByText('没有额外权限规则。')).toBeTruthy()
    expect(screen.getAllByText('不限')).toHaveLength(5)
  })

  it('formats a finite turn duration limit', async () => {
    const user = userEvent.setup()
    const root = result.tree.runs[0]!
    setup({
      result: {
        ...result,
        tree: {
          ...result.tree,
          runs: [{ ...root, limits: { ...root.limits, maxTurnDurationMs: 5_000 } }],
        },
      },
    })
    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByText('5.0s')).toBeTruthy()
  })

  it('shows loading state while the first inspection is pending', () => {
    setup({ loading: true })
    expect(screen.getByRole('status').textContent).toBe('正在读取运行检查器…')
    expect(screen.getByRole('tabpanel', { name: '时间线' })).toBeTruthy()
  })

  it('shows an empty inspector when the inspection has no data', () => {
    setup({ noData: true })
    expect(screen.getByText('没有运行记录。')).toBeTruthy()
  })

  it('shows empty and error states with retry', async () => {
    const user = userEvent.setup()
    const empty: RunInspectResult = {
      ...result,
      tree: { ...result.tree, runs: [], rootRunId: '' },
    }
    const { inspectRun } = setup({ result: empty })
    expect(screen.getByText('没有运行记录。')).toBeTruthy()
    expect(inspectRun).toHaveBeenCalledWith('s1')
    cleanup()

    const retry = setup({ error: { code: 'run.not_found' } })
    expect(screen.getByRole('alert').textContent).toContain('run.not_found')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(retry.inspectRun).toHaveBeenCalledWith('s1', undefined)
  })
})
