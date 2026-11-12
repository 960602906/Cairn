// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary, ChangeSetInfo } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { ChangeSetReview } from './ChangeSetReview.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')
afterEach(cleanup)

const PATCH = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '',
].join('\n')

const changeSet = (over: Partial<ChangeSetInfo> = {}): ChangeSetInfo => ({
  changeSetId: 'cs1',
  sessionId: 's1',
  runId: 'child1',
  parentRunId: 'r1',
  baseCommit: 'abcdef0123456789abcdef0123456789abcdef01',
  baseCreatedAt: 1_700_000_000_000,
  status: 'pending',
  createdAt: 1_700_000_100_000,
  conflicts: 0,
  files: [
    {
      path: 'src/a.ts',
      status: 'pending',
      kind: 'modified',
      added: 1,
      removed: 1,
      patch: PATCH,
      binary: false,
      large: false,
    },
    {
      path: 'src/new.ts',
      status: 'pending',
      kind: 'added',
      added: 2,
      removed: 0,
      patch: '@@ -0,0 +1,2 @@\n+x\n+y\n',
      binary: false,
      large: false,
    },
  ],
  ...over,
})

const delegation: DelegationView = {
  childRunId: 'child1',
  parentRunId: 'r1',
  agent: { id: 'builtin.coder', version: 2 },
  task: '重构登录流程',
  workspace: 'isolated',
  workspacePath: '/tmp/ws',
  budget: undefined,
  turnId: 't1',
  createdAt: 1_700_000_000_000,
  completed: {
    status: 'completed',
    summary: '完成',
    usage: undefined,
    changeSetId: 'cs1',
    issues: undefined,
  },
}

interface SetupOptions {
  readonly detail?: ChangeSetInfo | undefined
  readonly loading?: boolean
  readonly error?: { code: string } | undefined
  readonly agents?: readonly AgentSummary[]
}

function setup({
  detail: initialDetail = changeSet(),
  loading = false,
  error,
  agents = [],
}: SetupOptions = {}) {
  const state = {
    detail: initialDetail,
  }
  const ref: { store?: SessionStore } = {}
  const loadChangeSet = vi.fn(async () => state.detail)
  const applyChangeSet = vi.fn(
    async (_sessionId: string, _id: string, paths?: readonly string[]) => {
      const target = state.detail
      if (!target) return undefined
      const wanted = paths === undefined ? undefined : new Set(paths)
      const next: ChangeSetInfo = {
        ...target,
        files: target.files.map((file) =>
          wanted === undefined || wanted.has(file.path) ? { ...file, status: 'accepted' } : file,
        ),
      }
      const pending = next.files.some(
        (file) =>
          file.status === 'pending' || file.status === 'conflict' || file.status === 'manual',
      )
      state.detail = {
        ...next,
        status: pending ? 'pending' : 'applied',
        ...(pending ? {} : { mergedAt: 1_700_000_200_000, checkpointCommit: 'merge-commit' }),
      }
      ref.store!.setState({ changeSetDetails: { cs1: state.detail } } as never)
      return state.detail
    },
  )
  const rejectChangeSet = vi.fn(
    async (_sessionId: string, _id: string, paths?: readonly string[]) => {
      const target = state.detail!
      const wanted = paths === undefined ? undefined : new Set(paths)
      state.detail = {
        ...target,
        files: target.files.map((file) =>
          wanted === undefined || wanted.has(file.path) ? { ...file, status: 'rejected' } : file,
        ),
        status: paths === undefined ? 'rejected' : 'pending',
      }
      ref.store!.setState({ changeSetDetails: { cs1: state.detail } } as never)
      return state.detail
    },
  )
  const resolveChangeSetConflict = vi.fn(
    async (
      _sessionId: string,
      _id: string,
      path: string,
      resolution: 'keep-main' | 'take-child' | 'manual',
    ) => {
      const target = state.detail!
      state.detail = {
        ...target,
        files: target.files.map((file) =>
          file.path === path
            ? { ...file, status: resolution === 'keep-main' ? 'rejected' : 'accepted' }
            : file,
        ),
      }
      ref.store!.setState({ changeSetDetails: { cs1: state.detail } } as never)
      return state.detail
    },
  )
  const restoreCheckpoint = vi.fn(async () => ({
    checkpointId: 'merge-commit',
    files: [],
  }))
  ref.store = createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    agents,
    inspections: {},
    changeSetDetails: state.detail ? { cs1: state.detail } : {},
    changeSetLoading: { cs1: loading },
    changeSetErrors: error ? { cs1: error } : {},
    changeSets: {},
    changeSetsLoading: { s1: false },
    loadChangeSet,
    applyChangeSet,
    rejectChangeSet,
    resolveChangeSetConflict,
    restoreCheckpoint,
  })) as unknown as SessionStore
  const store = ref.store
  const getDetail = () => state.detail
  const wrap = (ui: ReactNode) =>
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
      </I18nextProvider>,
    )
  return {
    wrap,
    store,
    getDetail,
    loadChangeSet,
    applyChangeSet,
    rejectChangeSet,
    resolveChangeSetConflict,
    restoreCheckpoint,
  }
}

describe('ChangeSetReview', () => {
  it('shows the source agent, task, baseline snapshot and file summary', async () => {
    const { wrap } = setup()
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" delegation={delegation} />)
    const region = screen.getByRole('region', { name: '改动集审阅' })
    expect(within(region).getByText('编程助手')).toBeTruthy()
    expect(within(region).getByText('重构登录流程')).toBeTruthy()
    expect(within(region).getByText('待审阅')).toBeTruthy()
    expect(within(region).getByText('2 个文件')).toBeTruthy()
    expect(region.textContent).toContain('+3 −1')
    expect(within(region).getByText(/· abcdef01/)).toBeTruthy()
    // 基线时间优先于改动集创建时间
    expect(
      within(region).getByText(new Date(1_700_000_000_000).toLocaleString('zh-CN')),
    ).toBeTruthy()
  })

  it('renders loading, empty, binary/large and error states', async () => {
    const loading = setup({ loading: true })
    const { unmount } = loading.wrap(
      <ChangeSetReview sessionId="s1" changeSetId="cs1" delegation={delegation} />,
    )
    expect(screen.getByRole('status').textContent).toContain('正在读取改动集')
    unmount()

    const empty = setup({ detail: changeSet({ files: [] }) })
    empty.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    expect(screen.getByText('这个改动集没有文件改动。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /全部接受/ }))
    expect(empty.applyChangeSet).toHaveBeenCalledWith('s1', 'cs1', undefined)
    cleanup()

    const binary = setup({
      detail: changeSet({
        files: [
          {
            path: 'logo.png',
            status: 'pending',
            kind: 'modified',
            added: 0,
            removed: 0,
            binary: true,
            large: false,
          },
          {
            path: 'huge.log',
            status: 'manual',
            kind: 'modified',
            added: 0,
            removed: 0,
            binary: false,
            large: true,
          },
        ],
      }),
    })
    binary.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /logo\.png/ }))
    expect(
      screen
        .getByRole('button', { name: /logo\.png/ })
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('./image.svg')
    expect(screen.getByText('二进制文件，只记录元数据，不显示内容差异。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /huge\.log/ }))
    expect(screen.getByText('文件较大，只记录元数据，不显示内容差异。')).toBeTruthy()
    expect(screen.getByText(/文件超过读取上限/)).toBeTruthy()
    cleanup()

    const failed = setup({ detail: undefined, error: { code: 'changeset.failed' } })
    failed.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    expect(screen.getByRole('alert').textContent).toContain('无法读取改动集')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.loadChangeSet).toHaveBeenCalledWith('s1', 'cs1')
  })

  it('expands a file and accepts it individually', async () => {
    const { wrap, applyChangeSet, getDetail } = setup()
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" delegation={delegation} />)
    const row = screen.getByRole('button', { name: /src\/a\.ts/ })
    await userEvent.click(row)
    const figure = await screen.findByRole('figure', { name: '差异：src/a.ts' })
    await waitFor(() => expect(figure.querySelectorAll('[data-type="add"]')).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: '接受此文件' }))
    expect(applyChangeSet).toHaveBeenCalledWith('s1', 'cs1', ['src/a.ts'])
    await waitFor(() => expect(screen.getByText('已接受')).toBeTruthy())
    expect(getDetail()!.files[0]!.status).toBe('accepted')
  })

  it('applies all actionable files', async () => {
    const { wrap, applyChangeSet, rejectChangeSet, getDetail } = setup()
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /全部接受/ }))
    expect(applyChangeSet).toHaveBeenCalledWith('s1', 'cs1', ['src/a.ts', 'src/new.ts'])
    await waitFor(() => expect(getDetail()!.status).toBe('applied'))
    expect(screen.getByText('已合并')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '全部拒绝' })).toBeNull()
    expect(rejectChangeSet).not.toHaveBeenCalled()
  })

  it('rejects the whole change set', async () => {
    const second = setup()
    second.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /全部拒绝/ }))
    expect(second.rejectChangeSet).toHaveBeenCalledWith('s1', 'cs1')
    await waitFor(() => expect(second.getDetail()!.status).toBe('rejected'))
    expect(screen.getAllByText('已拒绝').length).toBeGreaterThan(0)
  })

  it('offers the three conflict resolutions and reports the count', async () => {
    const conflicting = changeSet({
      conflicts: 1,
      files: [
        {
          path: 'src/a.ts',
          status: 'conflict',
          kind: 'modified',
          added: 1,
          removed: 1,
          patch: PATCH,
          binary: false,
          large: false,
        },
      ],
    })
    const { wrap, resolveChangeSetConflict } = setup({ detail: conflicting })
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    expect(screen.getByText('1 个冲突')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(screen.getByText('主工作区在基线之后改过这个文件')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '采用子运行' }))
    expect(resolveChangeSetConflict).toHaveBeenCalledWith('s1', 'cs1', 'src/a.ts', 'take-child')
    cleanup()

    const manual = setup({
      detail: changeSet({
        files: [
          {
            path: 'src/a.ts',
            status: 'conflict',
            kind: 'modified',
            added: 1,
            removed: 1,
            patch: PATCH,
            binary: false,
            large: false,
          },
        ],
      }),
    })
    manual.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: '保留主工作区' }))
    expect(manual.resolveChangeSetConflict).toHaveBeenCalledWith(
      's1',
      'cs1',
      'src/a.ts',
      'keep-main',
    )
  })

  it('rejects one file and hands a conflict to manual resolution', async () => {
    const single = setup()
    single.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: '拒绝此文件' }))
    expect(single.rejectChangeSet).toHaveBeenCalledWith('s1', 'cs1', ['src/a.ts'])
    await waitFor(() => expect(single.getDetail()!.files[0]!.status).toBe('rejected'))
    cleanup()

    const manual = setup({
      detail: changeSet({
        conflicts: 1,
        files: [{ ...changeSet().files[0]!, status: 'conflict' }],
      }),
    })
    manual.wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: '手动处理' }))
    expect(manual.resolveChangeSetConflict).toHaveBeenCalledWith('s1', 'cs1', 'src/a.ts', 'manual')
  })

  it('falls back to the agent id when the agent definition is unavailable', () => {
    const { wrap } = setup()
    wrap(
      <ChangeSetReview
        sessionId="s1"
        changeSetId="cs1"
        delegation={{ ...delegation, agent: { id: 'custom.reviewer', version: 1 } }}
      />,
    )
    expect(screen.getByText('custom.reviewer')).toBeTruthy()
  })

  it('uses the localized name when the agent definition is available', () => {
    const { wrap } = setup({
      agents: [
        {
          agentId: 'builtin.coder',
          name: { 'zh-CN': '代码助手', 'en-US': 'Coder' },
          description: { 'zh-CN': '写代码', 'en-US': 'Writes code' },
          source: 'builtin',
          archived: false,
          status: 'published',
          version: 2,
          hasDraft: false,
          modelMode: 'inherit',
          updatedAt: 1,
        },
      ],
    })
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" delegation={delegation} />)
    expect(screen.getByText('代码助手')).toBeTruthy()
  })

  it('undoes a merge through the recorded checkpoint', async () => {
    const applied = changeSet({
      status: 'applied',
      mergedAt: 1_700_000_200_000,
      checkpointCommit: '0123456789abcdef0123456789abcdef01234567',
      files: [{ ...changeSet().files[0]!, status: 'accepted' }],
    })
    const { wrap, restoreCheckpoint } = setup({ detail: applied })
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" />)
    expect(screen.getByText(/01234567/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /撤销这次合并/ }))
    const dialog = screen.getByRole('dialog', { name: '撤销这次合并？' })
    await userEvent.click(within(dialog).getByRole('button', { name: '撤销这次合并' }))
    expect(restoreCheckpoint).toHaveBeenCalledWith('s1', '0123456789abcdef0123456789abcdef01234567')
    expect(await screen.findByText('已恢复到合并前的检查点。')).toBeTruthy()
  })

  it('shows a back button and loads the change set', async () => {
    const { wrap, loadChangeSet } = setup()
    const onBack = vi.fn()
    wrap(<ChangeSetReview sessionId="s1" changeSetId="cs1" onBack={onBack} />)
    await userEvent.click(screen.getByRole('button', { name: '返回改动集列表' }))
    expect(onBack).toHaveBeenCalled()
    expect(loadChangeSet).toHaveBeenCalledWith('s1', 'cs1')
  })
})
