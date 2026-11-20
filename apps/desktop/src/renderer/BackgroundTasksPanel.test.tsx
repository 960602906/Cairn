// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationView, SessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { AutoFixStatus, BackgroundCommand, BackgroundCommandOutput } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreContext } from './store-context.js'
import { BackgroundTasksPanel } from './BackgroundTasksPanel.js'

afterEach(cleanup)

const runningCommand: BackgroundCommand = {
  commandId: 'c1',
  sessionId: 's1',
  runId: 'r1',
  command: 'pnpm dev',
  cwd: 'C:\\work\\demo',
  startedAt: 1_000,
  status: 'running',
}

const finishedCommand: BackgroundCommand = {
  ...runningCommand,
  commandId: 'c2',
  command: 'pnpm build',
  startedAt: 1_000,
  endedAt: 66_000,
  exitCode: 0,
  status: 'exited',
}

const delegation: DelegationView = {
  childRunId: 'run-2',
  parentRunId: 'run-1',
  agent: { id: 'builtin.coder', version: 1 },
  task: '检查登录流程',
  workspace: 'shared',
  workspacePath: undefined,
  budget: undefined,
  turnId: undefined,
  createdAt: 1_000,
  completed: undefined,
}

const autofix: AutoFixStatus = {
  paused: false,
  watches: [
    {
      watchId: 'w1',
      repo: 'owner/repo',
      prNumber: 7,
      projectPath: 'C:\\work\\demo',
      triggers: ['ci'],
      maxAttempts: 3,
      enabled: true,
      attempts: 1,
      createdAt: 1_000,
    },
  ],
  jobs: [
    {
      jobId: 'j1',
      watchId: 'w1',
      sessionId: 's1',
      trigger: 'ci',
      signature: 'sig',
      status: 'running',
      attempt: 1,
      createdAt: 1_000,
      updatedAt: 2_000,
    },
  ],
}

const output: BackgroundCommandOutput = {
  command: runningCommand,
  chunks: [{ stream: 'stdout', text: 'bg-tick\n' }],
  omittedChars: 0,
}

function setup({
  view,
  commands = [],
  autoFix,
  outputs = {},
  request = vi.fn(async () => undefined),
}: {
  view?: SessionView
  commands?: readonly BackgroundCommand[]
  autoFix?: AutoFixStatus
  outputs?: Record<string, BackgroundCommandOutput>
  request?: ReturnType<typeof vi.fn>
} = {}) {
  const store = createSessionStore({
    request,
    on: () => () => {},
    ready: async () => {},
  } as unknown as MainApi)
  store.setState({
    commands,
    commandOutputs: outputs,
    ...(autoFix === undefined ? {} : { autofix: autoFix }),
  })
  const onOpenPanel = vi.fn()
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <BackgroundTasksPanel
          sessionId="s1"
          view={view}
          status="idle"
          active
          selectedPlanId={undefined}
          selectedChangeSetId={undefined}
          selectedRunId={undefined}
          onOpenPanel={onOpenPanel}
        />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request, onOpenPanel }
}

describe('BackgroundTasksPanel', () => {
  it('lists running and finished work with durations', () => {
    setup({
      commands: [
        runningCommand,
        { ...runningCommand, commandId: 'c0', status: 'stopping' },
        finishedCommand,
      ],
    })
    const running = screen.getByRole('region', { name: '进行中' })
    expect(running.textContent).toContain('pnpm dev')
    expect(running.textContent).toContain('运行中')
    expect(running.textContent).toContain('正在停止')
    const finished = screen.getByRole('region', { name: '已完成' })
    expect(finished.textContent).toContain('pnpm build')
    expect(finished.textContent).toContain('1 分 5 秒')
  })

  it('shows delegated agents and opens their detail', async () => {
    const { onOpenPanel } = setup({
      view: {
        delegations: [
          delegation,
          {
            ...delegation,
            childRunId: 'run-4',
            task: '检查权限规则',
            agent: { id: 'user.custom', version: 2 },
          },
        ],
      } as unknown as SessionView,
    })
    expect(screen.getByRole('region', { name: '进行中' }).textContent).toContain('user.custom')
    await userEvent.click(screen.getByRole('button', { name: /检查登录流程/ }))
    expect(onOpenPanel).toHaveBeenCalledWith('delegation', { runId: 'run-2' })
  })

  it('shows auto-fix jobs with trigger attempt', () => {
    setup({ autoFix: autofix })
    const running = screen.getByRole('region', { name: '进行中' })
    expect(running.textContent).toContain('owner/repo#7')
    expect(running.textContent).toContain('第 1/3 次')
  })

  it('expands command output and stops a running command', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'command.output' ? output : undefined,
    )
    setup({ commands: [runningCommand], outputs: { c1: output }, request })
    await userEvent.click(screen.getByRole('button', { name: '查看输出' }))
    expect(screen.getByText('bg-tick')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('command.stop', { commandId: 'c1' }))
  })

  it('falls back to the watch id when the PR snapshot is gone', () => {
    setup({
      autoFix: {
        paused: false,
        watches: [],
        jobs: [
          {
            jobId: 'j2',
            watchId: 'gone',
            sessionId: 's1',
            trigger: 'comment',
            signature: 'sig',
            status: 'failed',
            attempt: 2,
            createdAt: 1_000,
            updatedAt: 5_000,
          },
        ],
      },
    })
    const finished = screen.getByRole('region', { name: '已完成' })
    expect(finished.textContent).toContain('gone')
    expect(finished.textContent).toContain('失败')
  })

  it('formats hours and opens completed delegations', async () => {
    const { onOpenPanel } = setup({
      commands: [{ ...finishedCommand, commandId: 'c3', startedAt: 0, endedAt: 3_725_000 }],
      view: {
        delegations: [
          {
            ...delegation,
            childRunId: 'run-3',
            task: '补测试',
            completed: {
              status: 'completed',
              summary: '完成',
              usage: { inputTokens: 1, outputTokens: 2 },
              changeSetId: undefined,
              issues: undefined,
            },
          },
        ],
      } as unknown as SessionView,
    })
    const finished = screen.getByRole('region', { name: '已完成' })
    expect(finished.textContent).toContain('1 小时 2 分')
    expect(finished.textContent).toContain('补测试')
    expect(finished.textContent).toContain('完成')
    await userEvent.click(screen.getByRole('button', { name: /补测试/ }))
    expect(onOpenPanel).toHaveBeenCalledWith('delegation', { runId: 'run-3' })
  })

  it('shows empty output, omitted counts and collapses again', async () => {
    const emptyOutput: BackgroundCommandOutput = {
      command: finishedCommand,
      chunks: [],
      omittedChars: 5,
    }
    setup({
      commands: [finishedCommand],
      outputs: { c2: emptyOutput },
      request: vi.fn(async () => emptyOutput),
    })
    await userEvent.click(screen.getByRole('button', { name: '查看输出' }))
    expect(screen.getByText('还没有输出。')).toBeTruthy()
    expect(screen.getByText(/中间省略了 5 个字符/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '收起输出' }))
    expect(screen.queryByText('还没有输出。')).toBeNull()
  })

  it('shows a loading line while output is fetched', async () => {
    setup({ commands: [finishedCommand] })
    await userEvent.click(screen.getByRole('button', { name: '查看输出' }))
    expect(screen.getByText('正在读取输出…')).toBeTruthy()
  })

  it('explains when there is nothing running', () => {
    setup()
    expect(screen.getByText('没有后台任务')).toBeTruthy()
  })
})
