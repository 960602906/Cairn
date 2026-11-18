// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  RpcError,
  type AutoFixJob,
  type AutoFixStatus,
  type GithubPullRequest,
  type GithubStatus,
  type PullRequestWatch,
  type Settings,
} from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore, type SessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { AutofixSettings } from './AutofixSettings.js'

afterEach(cleanup)

const SETTINGS: Settings = { locale: 'zh-CN', providers: [] }

const pull: GithubPullRequest = {
  repo: '960602906/Cairn',
  number: 202,
  title: '准备 v0.1.1 beta',
  url: 'https://github.com/960602906/Cairn/pull/202',
  state: 'open',
  draft: false,
  headRef: 'release/v0.1.1-beta',
  headSha: '5b9b4ae0000000000000000000000000000000ab',
  baseRef: 'main',
  checks: [
    {
      id: 7,
      name: 'check (windows-latest)',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
    },
  ],
}

type Handlers = Record<string, ((params: unknown) => unknown) | undefined>

const EMPTY_AUTOFIX: AutoFixStatus = { paused: false, watches: [], jobs: [] }

const WATCH: PullRequestWatch = {
  watchId: 'w1',
  repo: '960602906/Cairn',
  prNumber: 202,
  projectPath: '/work/cairn',
  triggers: ['ci', 'conflict'],
  maxAttempts: 3,
  enabled: true,
  attempts: 1,
  createdAt: 1,
}

const JOB: AutoFixJob = {
  jobId: 'j1',
  watchId: 'w1',
  trigger: 'ci',
  signature: 'sha:test',
  status: 'ready',
  attempt: 1,
  createdAt: 2,
  updatedAt: 3,
}

function setup(handlers: Handlers = {}): {
  readonly store: SessionStore
  readonly request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method]
    if (handler) return handler(params)
    if (method === 'github.status') return { connected: false } satisfies GithubStatus
    if (method === 'autofix.status') return EMPTY_AUTOFIX satisfies AutoFixStatus
    if (method === 'settings.get') return SETTINGS
    return {}
  })
  const api = {
    ready: async () => {},
    request,
    on: () => () => {},
  } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({ settings: SETTINGS })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <AutofixSettings />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { store, request }
}

describe('AutofixSettings', () => {
  it('connects with a token and shows the login', async () => {
    const { request } = setup({
      'github.connect': () => ({ connected: true, login: 'mrqin' }),
    })
    expect(await screen.findByText('未连接')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('GitHub 令牌'), ' ghp_example ')
    await userEvent.click(screen.getByRole('button', { name: '连接' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('github.connect', { token: 'ghp_example' }),
    )
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    // 连接后令牌输入框收起，不再保留明文。
    expect(screen.queryByLabelText('GitHub 令牌')).toBeNull()
  })

  it('shows why the token was rejected', async () => {
    setup({
      'github.connect': () => {
        throw new RpcError('github.auth_failed')
      },
    })
    await userEvent.type(screen.getByLabelText('GitHub 令牌'), 'bad')
    await userEvent.click(screen.getByRole('button', { name: '连接' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('令牌无效')
  })

  it('reads a pull request, its checks and the failing log', async () => {
    const { request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => pull,
      'github.checkLog': () => ({ text: 'Error: test failed', truncated: true }),
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))

    expect(await screen.findByText('准备 v0.1.1 beta')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('github.pullRequest', {
      repo: '960602906/Cairn',
      number: 202,
    })
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText(/release\/v0\.1\.1-beta/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '查看日志' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('github.checkLog', {
        repo: '960602906/Cairn',
        checkRunId: 7,
      }),
    )
    expect(await screen.findByText('Error: test failed')).toBeTruthy()
    expect(screen.getByText(/只显示最后一部分/)).toBeTruthy()
  })

  it('disconnects and clears the pull request', async () => {
    const { request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => pull,
      'github.disconnect': () => ({ connected: false }),
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('准备 v0.1.1 beta')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '断开' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('github.disconnect', {}))
    expect(await screen.findByText('未连接')).toBeTruthy()
    expect(screen.queryByText('准备 v0.1.1 beta')).toBeNull()
  })

  it('connects with Enter and ignores an empty token', async () => {
    const { request } = setup({
      'github.connect': () => ({ connected: true, login: 'mrqin' }),
    })
    const input = await screen.findByLabelText('GitHub 令牌')
    await userEvent.type(input, '{Enter}')
    expect(request).not.toHaveBeenCalledWith('github.connect', expect.anything())
    await userEvent.type(input, 'ghp_example{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('github.connect', { token: 'ghp_example' }),
    )
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
  })

  it('shows a saved connection without a login name', async () => {
    setup({ 'github.status': () => ({ connected: true }) })
    expect(await screen.findByText('已连接')).toBeTruthy()
  })

  it('labels every check state and reads a short log', async () => {
    const { request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => ({
        ...pull,
        checks: [
          { id: 11, name: 'build', status: 'completed', conclusion: 'success' },
          { id: 12, name: 'e2e', status: 'in_progress' },
          { id: 13, name: 'lint', status: 'completed', conclusion: 'timed_out' },
          { id: 14, name: 'manual', status: 'completed', conclusion: 'action_required' },
        ],
      }),
      'github.checkLog': () => ({ text: 'clean run', truncated: false }),
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))

    expect(await screen.findByText('通过')).toBeTruthy()
    expect(screen.getByText('in_progress')).toBeTruthy()
    expect(screen.getByText('超时')).toBeTruthy()
    expect(screen.getByText('需要操作')).toBeTruthy()

    await userEvent.click(screen.getAllByRole('button', { name: '查看日志' })[0]!)
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('github.checkLog', {
        repo: '960602906/Cairn',
        checkRunId: 13,
      }),
    )
    expect(await screen.findByText('clean run')).toBeTruthy()
    expect(screen.queryByText(/只显示最后一部分/)).toBeNull()
  })

  it('shows a closed draft without checks', async () => {
    setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => ({ ...pull, state: 'closed', draft: true, checks: [] }),
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))

    expect(await screen.findByText(/已关闭/)).toBeTruthy()
    expect(screen.getByText(/草稿/)).toBeTruthy()
    expect(screen.getByText('这个 PR 还没有检查项。')).toBeTruthy()
  })

  it('shows why a pull request could not be read', async () => {
    setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => {
        throw new RpcError('github.not_found')
      },
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))
    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
    expect(screen.queryByRole('list', { name: '检查项' })).toBeNull()
  })

  it('lists watches, toggles one and removes it', async () => {
    const { request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'autofix.status': () => ({ paused: false, watches: [WATCH], jobs: [JOB] }),
      'autofix.watch.update': () => ({
        paused: false,
        watches: [{ ...WATCH, enabled: false }],
        jobs: [JOB],
      }),
      'autofix.watch.remove': () => EMPTY_AUTOFIX,
      'autofix.pause': () => ({ paused: true, watches: [WATCH], jobs: [JOB] }),
    })
    expect(await screen.findByText('960602906/Cairn#202')).toBeTruthy()
    expect(screen.getByText(/CI 失败 · 合并冲突/)).toBeTruthy()
    expect(screen.getByText(/待检查/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '暂停监视' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('autofix.watch.update', {
        watchId: 'w1',
        enabled: false,
      }),
    )
    expect(await screen.findByRole('button', { name: '恢复监视' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '暂停全部' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('autofix.pause', { paused: true }))
    expect(await screen.findByText('监视已暂停')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '移除' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('autofix.watch.remove', { watchId: 'w1' }),
    )
    expect(screen.queryByText('960602906/Cairn#202')).toBeNull()
  })

  it('adds a watch for an open project', async () => {
    const { store, request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'autofix.status': () => EMPTY_AUTOFIX,
      'autofix.watch.add': () => ({ paused: false, watches: [WATCH], jobs: [] }),
    })
    store.setState({
      projects: [{ projectId: 'p1', name: 'Cairn', path: '/work/cairn', createdAt: 1 }],
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('监视仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('监视 PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '添加监视' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('autofix.watch.add', {
        repo: '960602906/Cairn',
        prNumber: 202,
        projectPath: '/work/cairn',
        triggers: ['ci', 'conflict'],
      }),
    )
    expect(await screen.findByText('960602906/Cairn#202')).toBeTruthy()
  })

  it('lets a new watch react to new review comments too', async () => {
    const { store, request } = setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'autofix.status': () => EMPTY_AUTOFIX,
      'autofix.watch.add': () => ({ paused: false, watches: [WATCH], jobs: [] }),
    })
    store.setState({
      projects: [{ projectId: 'p1', name: 'Cairn', path: '/work/cairn', createdAt: 1 }],
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('监视仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('监视 PR 编号'), '202')
    await userEvent.click(screen.getByLabelText('新评审意见'))
    await userEvent.click(screen.getByRole('button', { name: '添加监视' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('autofix.watch.add', {
        repo: '960602906/Cairn',
        prNumber: 202,
        projectPath: '/work/cairn',
        triggers: ['ci', 'conflict', 'comment'],
      }),
    )
  })

  it('keeps the pull request when the log cannot be read', async () => {
    setup({
      'github.status': () => ({ connected: true, login: 'mrqin' }),
      'github.pullRequest': () => pull,
      'github.checkLog': () => {
        throw new RpcError('github.log_unavailable')
      },
    })
    expect(await screen.findByText('已连接 mrqin')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('仓库'), '960602906/Cairn')
    await userEvent.type(screen.getByLabelText('PR 编号'), '202')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('准备 v0.1.1 beta')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '查看日志' }))
    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
    expect(screen.getByText('准备 v0.1.1 beta')).toBeTruthy()
  })
})
