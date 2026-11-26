// @vitest-environment jsdom
import { BUILTIN_CODER, BUILTIN_EXPLORER, BUILTIN_REVIEWER, BUILTIN_TESTER } from '@cairn/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  RpcError,
  type AgentDefinition,
  type AgentSummary,
  type AgentTeamVersionSummary,
  type TeamDraftFields,
} from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { TeamVersions } from './TeamVersions.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const builtin = [BUILTIN_CODER, BUILTIN_EXPLORER, BUILTIN_REVIEWER, BUILTIN_TESTER]

const summary = (agent: AgentDefinition): AgentSummary => ({
  agentId: agent.id,
  name: agent.name,
  description: agent.description,
  source: 'builtin',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
})

const current: TeamDraftFields = {
  name: { 'zh-CN': '新团队' },
  description: { 'zh-CN': '新说明' },
  coordinator: BUILTIN_REVIEWER.id,
  members: [],
  pattern: 'review-loop',
  reviewLoop: { maker: BUILTIN_REVIEWER.id, checker: BUILTIN_TESTER.id, maxRounds: 5 },
}

const versionFields = (version: number): TeamDraftFields =>
  version === 1
    ? {
        name: { 'zh-CN': '旧团队' },
        description: {},
        // 已不存在的 Agent 直接显示 id。
        coordinator: 'user.gone',
        members: [BUILTIN_EXPLORER.id, BUILTIN_REVIEWER.id],
        pattern: 'pipeline',
        pipeline: [],
        delegation: { maxDepth: 2 },
      }
    : {
        name: { 'zh-CN': '第二版', 'en-US': 'Second' },
        description: {},
        coordinator: BUILTIN_CODER.id,
        members: [BUILTIN_EXPLORER.id],
        pattern: 'delegate',
        pipeline: [
          { stage: 'stage-1', agent: BUILTIN_CODER.id },
          { stage: 'stage-2', agent: BUILTIN_EXPLORER.id, dependsOn: ['stage-1'] },
        ],
        reviewLoop: { maker: BUILTIN_CODER.id, checker: BUILTIN_EXPLORER.id, maxRounds: 2 },
      }

const versionSummary = (
  version: number,
  overrides: Partial<AgentTeamVersionSummary> = {},
): AgentTeamVersionSummary => ({
  version,
  publishedAt: 1_700_000_000_000 + version,
  name: versionFields(version).name,
  description: versionFields(version).description,
  pattern: versionFields(version).pattern,
  memberCount: versionFields(version).members.length,
  ...overrides,
})

function setup(
  options: {
    versions?: readonly AgentTeamVersionSummary[]
    fields?: (version: number) => TeamDraftFields | undefined
    failList?: boolean
    failGet?: boolean
  } = {},
) {
  const calls: [string, unknown][] = []
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params])
      if (method === 'agent.list') return { agents: builtin.map(summary) }
      if (method === 'team.versions') {
        if (options.failList) throw new RpcError('team.not_found', { teamId: 'user.team-1' })
        return { versions: options.versions ?? [versionSummary(1), versionSummary(2)] }
      }
      if (method === 'team.get') {
        if (options.failGet) throw new RpcError('team.not_found', { teamId: 'user.team-1' })
        const { version } = params as { version: number }
        const fields = options.fields?.(version) ?? versionFields(version)
        return {
          teamId: 'user.team-1',
          archived: false,
          published: {
            id: 'user.team-1',
            version,
            ...fields,
            createdAt: 1,
            updatedAt: 1,
            schemaVersion: 1,
          },
          validation: { ok: true, errors: [], warnings: [] },
        }
      }
      return {}
    },
    on: () => () => {},
  }
  return { store: createSessionStore(api as unknown as MainApi), calls }
}

async function renderVersions(
  store: ReturnType<typeof createSessionStore>,
  onRestore: (version: number) => Promise<boolean> = vi.fn(async () => true),
  readonly = false,
) {
  await store.getState().refreshAgents({ includeArchived: true })
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <TeamVersions
          teamId="user.team-1"
          current={current}
          readonly={readonly}
          onRestore={onRestore}
        />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return onRestore
}

const list = () => screen.getByRole('list', { name: '版本历史' })
const rowOf = (version: number) =>
  within(list())
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(`v${version}`) !== null)!

describe('TeamVersions', () => {
  it('lists versions newest first and compares them with the current draft', async () => {
    const { store } = setup()
    await renderVersions(store)
    expect(screen.getByText('正在读取版本…')).toBeDefined()
    await waitFor(() => expect(list()).toBeDefined())

    // 新版本排在最前，并标记当前版本。
    expect(
      within(list())
        .getAllByRole('listitem')
        .map((row) => row.textContent?.slice(0, 2)),
    ).toEqual(['v2', 'v1'])
    expect(within(rowOf(2)).getByText('当前')).toBeDefined()
    expect(within(rowOf(2)).getByText(/自由委派 · 1 名成员/)).toBeDefined()

    // 对比 v2：显示名称、成员、模式、审查循环与流水线。
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '对比' }))
    await waitFor(() => expect(screen.getByText('v2 与当前草稿')).toBeDefined())
    expect(screen.getByText('第二版')).toBeDefined()
    expect(screen.getByText('新团队')).toBeDefined()
    expect(screen.getByText('Second')).toBeDefined()
    expect(screen.getByText('代码探索员')).toBeDefined()
    expect(screen.getByText('自由委派')).toBeDefined()
    expect(screen.getAllByText('审查循环').length).toBeGreaterThan(0)
    expect(screen.getByText('编程助手 → 代码探索员 · 2 轮')).toBeDefined()
    expect(screen.getByText('1. 编程助手；2. 代码探索员')).toBeDefined()
    expect(screen.getByText('代码审查员 → 测试补全员 · 5 轮')).toBeDefined()
    expect(screen.getByText('成员')).toBeDefined()

    // 对比 v1：空流水线、两个成员与委派覆盖。
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: '对比' }))
    await waitFor(() => expect(screen.getByText('v1 与当前草稿')).toBeDefined())
    expect(screen.getByText('代码探索员、代码审查员')).toBeDefined()
    expect(screen.getByText('user.gone')).toBeDefined()
    expect(screen.getAllByText('流水线').length).toBeGreaterThan(0)
    expect(screen.getByText('{"maxDepth":2}')).toBeDefined()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('shows no diff when the version matches the draft', async () => {
    const { store } = setup({
      versions: [versionSummary(3, { name: current.name, description: current.description })],
      fields: () => current,
    })
    await renderVersions(store)
    await waitFor(() => expect(list()).toBeDefined())
    fireEvent.click(within(rowOf(3)).getByRole('button', { name: '对比' }))
    await waitFor(() => expect(screen.getByText('这个版本与当前草稿一致。')).toBeDefined())
  })

  it('reports a failed comparison and an empty history', async () => {
    const failing = setup({ failGet: true })
    await renderVersions(failing.store)
    await waitFor(() => expect(list()).toBeDefined())
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '对比' }))
    await waitFor(() => expect(screen.getByText('读取版本内容失败，请稍后再试。')).toBeDefined())

    cleanup()
    const empty = setup({ failList: true })
    await renderVersions(empty.store)
    await waitFor(() => expect(screen.getByText(/还没有发布过版本/)).toBeDefined())
  })

  it('restores a version after confirmation', async () => {
    const { store } = setup()
    const onRestore = await renderVersions(store)
    await waitFor(() => expect(list()).toBeDefined())

    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '恢复为草稿' }))
    expect(screen.getByText('恢复 v2 为草稿？')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.getByText('已把 v2 恢复为草稿。')).toBeDefined())
  })

  it('hides restore for archived templates but still compares', async () => {
    const { store } = setup()
    await renderVersions(store, undefined, true)
    await waitFor(() => expect(list()).toBeDefined())
    expect(within(list()).queryByRole('button', { name: '恢复为草稿' })).toBeNull()

    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '对比' }))
    await waitFor(() => expect(screen.getByText('v2 与当前草稿')).toBeDefined())
  })

  it('cancels or reports a failed restore', async () => {
    const { store } = setup()
    const onRestore = await renderVersions(store)
    await waitFor(() => expect(list()).toBeDefined())

    fireEvent.click(within(rowOf(1)).getByRole('button', { name: '恢复为草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('恢复 v1 为草稿？')).toBeNull())
    expect(onRestore).not.toHaveBeenCalled()

    cleanup()
    const failing = setup()
    const failingRestore = await renderVersions(
      failing.store,
      vi.fn(async () => false),
    )
    await waitFor(() => expect(list()).toBeDefined())
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '恢复为草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(failingRestore).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.queryByText(/已把 v2 恢复为草稿/)).toBeNull())
  })
})
