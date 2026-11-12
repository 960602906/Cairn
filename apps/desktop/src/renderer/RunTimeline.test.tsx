// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { RunTree, RunTreeNode, RunUsage } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { RunTimeline } from './RunTimeline.js'
import type { SessionStore } from './session-store.js'
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

const tree: RunTree = {
  sessionId: 's1',
  rootRunId: 'r1',
  generatedAt: 10,
  runs: [node('r1', 'builtin.coder', undefined, 't1'), node('c1', 'builtin.reviewer', 'r1', 'ct1')],
}

function setup(options: { tree?: RunTree; delegations?: readonly DelegationView[] } = {}) {
  const store = createStore<Record<string, unknown>>(() => ({
    agents: [],
    inspections: {},
    inspectRun: vi.fn(),
  })) as unknown as SessionStore
  const onLocate = vi.fn()
  const onOpenChanges = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <RunTimeline
          tree={options.tree ?? tree}
          {...(options.delegations === undefined ? {} : { delegations: options.delegations })}
          onLocate={onLocate}
          onOpenChanges={onOpenChanges}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { onLocate, onOpenChanges }
}

afterEach(cleanup)

describe('RunTimeline', () => {
  it('expands and collapses a run, then locates a turn in the conversation', async () => {
    const user = userEvent.setup()
    const { onLocate } = setup()
    expect(screen.getByRole('list', { name: '运行树' })).toBeTruthy()
    const collapse = screen.getByRole('button', { name: '收起运行：编程助手' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    await user.click(collapse)
    expect(collapse.getAttribute('aria-expanded')).toBe('false')
    await user.click(screen.getByRole('button', { name: '展开运行：编程助手' }))
    await user.click(screen.getByRole('button', { name: '定位到第 1 轮' }))
    expect(onLocate).toHaveBeenCalledWith('r1', 't1')
  })

  it('opens the change set from a child run node', async () => {
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
      within(child!).queryByRole('button', { name: /^定位到第 1 轮/ }),
    ).toBeNull()
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
    await user.click(turn)
    expect(screen.queryByText('步骤 1')).toBeNull()
  })

  it('falls back to the first run and shows runs without turns or steps', async () => {
    const user = userEvent.setup()
    const root = tree.runs[0]!
    setup({
      tree: {
        ...tree,
        rootRunId: 'missing',
        runs: [{ ...root, state: 'failed', turns: [] }],
      },
    })
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('还没有轮次')).toBeTruthy()

    cleanup()
    setup({
      tree: {
        ...tree,
        runs: [{ ...root, turns: [{ ...root.turns[0]!, steps: [] }] }],
      },
    })
    await user.click(screen.getByRole('button', { name: /^第 1 轮/ }))
    expect(screen.getByText('还没有步骤')).toBeTruthy()
  })

  it('shows a running step without a finish reason and without a tool duration', async () => {
    const user = userEvent.setup()
    const root = tree.runs[0]!
    const step = root.turns[0]!.steps[0]!
    const { finishReason: _finishReason, ...runningStep } = step
    const { durationMs: _durationMs, ...runningTool } = step.toolCalls[0]!
    setup({
      tree: {
        ...tree,
        runs: [
          {
            ...root,
            turns: [
              {
                ...root.turns[0]!,
                steps: [{ ...runningStep, toolCalls: [runningTool] }],
              },
            ],
          },
        ],
      },
    })
    await user.click(screen.getByRole('button', { name: /^第 1 轮/ }))
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
  })

  it('shows an empty state when the tree has no runs', () => {
    setup({ tree: { ...tree, runs: [], rootRunId: '' } })
    expect(screen.getByText('没有运行记录。')).toBeTruthy()
  })
})
