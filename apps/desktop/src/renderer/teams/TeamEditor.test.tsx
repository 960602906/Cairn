// @vitest-environment jsdom
import {
  BUILTIN_CODER,
  BUILTIN_EXPLORER,
  BUILTIN_REVIEWER,
  BUILTIN_TEAMS,
  BUILTIN_TESTER,
} from '@cairn/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  RpcError,
  type AgentDefinition,
  type AgentDetail,
  type AgentSummary,
  type AgentTeamDetail,
  type AgentTeamVersionSummary,
  type TeamDraftFields,
} from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { TeamEditor } from './TeamEditor.js'

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

const detailOf = (agent: AgentDefinition): AgentDetail => ({
  agentId: agent.id,
  source: 'builtin',
  archived: false,
  published: agent,
  validation: { ok: true, errors: [], warnings: [] },
})

const fields = (overrides: Partial<TeamDraftFields> = {}): TeamDraftFields => ({
  name: { 'zh-CN': '发布团队' },
  description: { 'zh-CN': '主控分派与审查' },
  coordinator: BUILTIN_CODER.id,
  members: [BUILTIN_EXPLORER.id, BUILTIN_REVIEWER.id],
  pattern: 'delegate',
  ...overrides,
})

const draft = (overrides: Partial<TeamDraftFields> = {}) => ({
  id: 'user.team-1',
  ...fields(overrides),
})

const published = (overrides: Partial<TeamDraftFields> = {}, version = 2) => ({
  id: 'user.team-1',
  version,
  ...fields(overrides),
  createdAt: 1,
  updatedAt: 2,
  schemaVersion: 1 as const,
})

function setup(
  options: {
    readonly team?: AgentTeamDetail | undefined
    readonly versions?: readonly AgentTeamVersionSummary[]
    readonly versionDetail?: (version: number) => AgentTeamDetail
    readonly versionGetFails?: boolean
    readonly saveFails?: boolean
    readonly publishFails?: boolean
    readonly archiveFails?: boolean
    readonly unarchiveFails?: boolean
    /** 额外的 Agent（例如已归档的用户 Agent），用于验证编辑器的成员列表。 */
    readonly extraAgents?: readonly { summary: AgentSummary; detail: AgentDetail }[]
  } = {},
) {
  const calls: { method: string; params: unknown }[] = []
  let latest: TeamDraftFields | undefined
  const teamDetail = options.team
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'agent.list') {
        return {
          agents: [...builtin.map(summary), ...(options.extraAgents ?? []).map((e) => e.summary)],
        }
      }
      if (method === 'agent.get') {
        const { agentId } = params as { agentId: string }
        const extra = options.extraAgents?.find((entry) => entry.summary.agentId === agentId)
        if (extra) return extra.detail
        const agent = builtin.find((candidate) => candidate.id === agentId)
        return agent ? detailOf(agent) : { agentId, source: 'user', archived: false }
      }
      if (method === 'team.get') {
        const { version } = params as { version?: number }
        if (version !== undefined) {
          if (options.versionGetFails)
            throw new RpcError('team.not_found', { teamId: 'user.team-1' })
          if (options.versionDetail) return options.versionDetail(version)
        }
        return teamDetail
      }
      if (method === 'team.versions') return { versions: options.versions ?? [] }
      if (method === 'team.saveDraft') {
        if (options.saveFails) throw new RpcError('team.invalid', { teamId: 'user.team-1' })
        const definition = (params as { definition: TeamDraftFields }).definition
        latest = definition
        const teamId = (definition as { id?: string }).id ?? 'user.team-new'
        return {
          teamId,
          source: 'user',
          archived: false,
          draft: { id: teamId, ...definition },
          validation: { ok: true, errors: [], warnings: [] },
        } satisfies AgentTeamDetail
      }
      if (method === 'team.publish') {
        if (options.publishFails) throw new RpcError('team.invalid', { teamId: 'user.team-1' })
        const { teamId } = params as { teamId: string }
        return {
          teamId,
          source: 'user',
          archived: false,
          published: published(latest ?? fields(), 3),
          validation: { ok: true, errors: [], warnings: [] },
        } satisfies AgentTeamDetail
      }
      if (method === 'team.archive' || method === 'team.unarchive') {
        const archive = method === 'team.archive'
        if (archive ? options.archiveFails : options.unarchiveFails) {
          throw new RpcError('team.not_found', { teamId: 'user.team-1' })
        }
        return {
          ...(teamDetail ?? {}),
          teamId: 'user.team-1',
          source: 'user',
          archived: archive,
          validation: teamDetail?.validation ?? { ok: true, errors: [], warnings: [] },
        } satisfies AgentTeamDetail
      }
      if (method === 'project.list')
        return { projects: [{ projectId: 'p1', name: '项目', path: '/work' }] }
      if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
      if (method === 'approval.pending') return { approvals: [] }
      if (method === 'question.pending') return { questions: [] }
      return {}
    },
    on: () => () => {},
  }
  return { store: createSessionStore(api as unknown as MainApi), calls }
}

async function renderEditor(
  store: ReturnType<typeof createSessionStore>,
  props: {
    teamId?: string
    onBack?: () => void
    onChanged?: () => void
    onOpenTeam?: (teamId: string) => void
  } = {},
) {
  const onBack = props.onBack ?? vi.fn()
  const onChanged = props.onChanged ?? vi.fn()
  const onOpenTeam = props.onOpenTeam ?? vi.fn()
  await store.getState().refreshAgents({ includeArchived: true })
  await store.getState().refreshProjects()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <TeamEditor
          teamId={props.teamId}
          onBack={onBack}
          onChanged={onChanged}
          onOpenTeam={onOpenTeam}
        />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { onBack, onChanged, onOpenTeam }
}

describe('TeamEditor', () => {
  it('creates, saves, and publishes a new team', async () => {
    const { store, calls } = setup()
    const { onChanged } = await renderEditor(store)

    const name = screen.getByLabelText('中文名称')
    fireEvent.change(name, { target: { value: '发布团队' } })
    fireEvent.change(screen.getByLabelText('中文描述'), { target: { value: '主控分派与审查' } })

    // 默认引用内置编程助手与三名成员，校验通过后可以保存。
    expect((screen.getByLabelText('主控 Agent') as HTMLSelectElement).value).toBe(BUILTIN_CODER.id)
    const saveButton = screen.getByRole('button', { name: '保存草稿' })
    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(saveButton)

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.saveDraft',
        params: {
          definition: {
            name: { 'zh-CN': '发布团队' },
            description: { 'zh-CN': '主控分派与审查' },
            coordinator: BUILTIN_CODER.id,
            members: [BUILTIN_EXPLORER.id, BUILTIN_REVIEWER.id, BUILTIN_TESTER.id],
            pattern: 'delegate',
          },
        },
      }),
    )
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('已保存')).toBeDefined())

    // 发布：保存后的草稿直接发布。
    fireEvent.click(screen.getByRole('button', { name: '发布 v1' }))
    expect(screen.getByText('发布 v1？')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.publish',
        params: { teamId: 'user.team-new' },
      }),
    )
    await waitFor(() => expect(screen.getByText('v3')).toBeDefined())
  })

  it('edits pipeline stages and dependencies, and warns about unused config', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({
        pattern: 'pipeline',
        pipeline: [
          { stage: 'stage-1', agent: BUILTIN_CODER.id },
          { stage: 'stage-2', agent: BUILTIN_EXPLORER.id, dependsOn: ['stage-1'] },
        ],
      }),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })

    await waitFor(() => expect(screen.getAllByText('阶段 1').length).toBeGreaterThan(0))
    expect(screen.getAllByText('阶段 2').length).toBeGreaterThan(0)
    expect((screen.getAllByLabelText('执行 Agent')[1] as HTMLSelectElement).value).toBe(
      BUILTIN_EXPLORER.id,
    )

    // 新增阶段默认依赖上一阶段。
    fireEvent.click(screen.getByRole('button', { name: '添加阶段' }))
    await waitFor(() => expect(screen.getAllByText('阶段 3').length).toBeGreaterThan(0))
    const dependency = screen.getByRole('checkbox', { name: '阶段 2' })
    expect((dependency as HTMLInputElement).checked).toBe(true)
    fireEvent.click(dependency)
    expect((dependency as HTMLInputElement).checked).toBe(false)
    fireEvent.click(dependency)
    expect((dependency as HTMLInputElement).checked).toBe(true)

    // 修改阶段 Agent，删除阶段。
    fireEvent.change(screen.getAllByLabelText('执行 Agent')[2]!, {
      target: { value: BUILTIN_REVIEWER.id },
    })
    fireEvent.click(screen.getByRole('button', { name: '删除阶段 3' }))
    expect(screen.queryAllByText('阶段 3')).toHaveLength(0)

    // 切到自由委派：流水线配置保留，但给出提醒，发布仍然可用。
    fireEvent.click(screen.getByRole('radio', { name: '自由委派' }))
    await waitFor(() => expect(screen.getByText('自由委派模式不会使用流水线配置')).toBeDefined())
    expect((screen.getByRole('button', { name: '发布 v3' }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'team.saveDraft' &&
            (call.params as { definition: TeamDraftFields }).definition.pattern === 'delegate' &&
            (call.params as { definition: TeamDraftFields }).definition.pipeline?.length === 2,
        ),
      ).toBe(true),
    )
  })

  it('seeds a review loop and clamps rounds', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })

    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.click(screen.getByRole('radio', { name: '审查循环' }))
    await waitFor(() => expect(screen.getByLabelText('执行者（maker）')).toBeDefined())
    expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe(
      BUILTIN_CODER.id,
    )
    expect((screen.getByLabelText('审查者（checker）') as HTMLSelectElement).value).toBe(
      BUILTIN_EXPLORER.id,
    )

    const rounds = screen.getByLabelText('最多轮次')
    fireEvent.change(rounds, { target: { value: '99' } })
    expect((rounds as HTMLInputElement).value).toBe('10')
    fireEvent.change(rounds, { target: { value: '0' } })
    expect((rounds as HTMLInputElement).value).toBe('1')

    // 选择另一个审查者：保存后配置带上 reviewLoop。
    fireEvent.change(screen.getByLabelText('审查者（checker）'), {
      target: { value: BUILTIN_REVIEWER.id },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(screen.getByLabelText('已保存')).toBeDefined())
  })

  it('confirms before leaving with unsaved changes and can save first', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const first = setup({ team })
    const back = vi.fn()
    await renderEditor(first.store, { teamId: 'user.team-1', onBack: back })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '返回团队列表' }))
    expect(screen.getByText('保存更改？')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '不保存离开' }))
    expect(back).toHaveBeenCalled()
    expect(first.calls.some((call) => call.method === 'team.saveDraft')).toBe(false)

    // 有改动时 ⌘S 保存；保存并离开会先写草稿。
    cleanup()
    const second = setup({ team })
    const back2 = vi.fn()
    await renderEditor(second.store, { teamId: 'user.team-1', onBack: back2 })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '再改名' } })
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() =>
      expect(second.calls.some((call) => call.method === 'team.saveDraft')).toBe(true),
    )

    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '第三次改名' } })
    fireEvent.click(screen.getByRole('button', { name: '返回团队列表' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并离开' }))
    await waitFor(() => expect(back2).toHaveBeenCalled())
  })

  it('shows a review loop that references agents outside the team', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({
        pattern: 'review-loop',
        reviewLoop: { maker: 'user.gone', checker: 'user.other', maxRounds: 5 },
      }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByLabelText('执行者（maker）')).toBeDefined())
    // 引用的 Agent 已被删除时，仍把旧值显示出来，避免静默改配置。
    expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe('user.gone')
    expect((screen.getByLabelText('审查者（checker）') as HTMLSelectElement).value).toBe(
      'user.other',
    )
    expect(screen.getByRole('option', { name: 'user.gone' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'user.other' })).toBeDefined()
    expect((screen.getByLabelText('最多轮次') as HTMLInputElement).value).toBe('5')
  })

  it('repairs a review loop without maker and checker on the first selection', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ pattern: 'review-loop' }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByLabelText('执行者（maker）')).toBeDefined())
    expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('最多轮次') as HTMLInputElement).value).toBe('3')

    // 第一次选人时补齐 maker / checker，checker 用另一个引用 Agent。
    fireEvent.change(screen.getByLabelText('执行者（maker）'), {
      target: { value: BUILTIN_REVIEWER.id },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe(
        BUILTIN_REVIEWER.id,
      ),
    )
    expect((screen.getByLabelText('审查者（checker）') as HTMLSelectElement).value).toBe(
      BUILTIN_CODER.id,
    )
    // 选择占位项不会改动配置。
    fireEvent.change(screen.getByLabelText('审查者（checker）'), { target: { value: '' } })
    expect((screen.getByLabelText('审查者（checker）') as HTMLSelectElement).value).toBe(
      BUILTIN_CODER.id,
    )
  })

  it('seeds a review loop when only the coordinator is referenced and the checker is picked first', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ pattern: 'review-loop', members: [] }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByLabelText('执行者（maker）')).toBeDefined())

    fireEvent.change(screen.getByLabelText('审查者（checker）'), {
      target: { value: BUILTIN_CODER.id },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('审查者（checker）') as HTMLSelectElement).value).toBe(
        BUILTIN_CODER.id,
      ),
    )
    // 没有第二个引用 Agent 时 maker 也退回同一个人。
    expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe(
      BUILTIN_CODER.id,
    )
  })

  it('adds the first pipeline stage from the first member when there is no coordinator', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({
        coordinator: '',
        members: [BUILTIN_EXPLORER.id],
        pattern: 'pipeline',
        pipeline: [],
      }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText(/还没有阶段/)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '添加阶段' }))
    await waitFor(() => expect(screen.getAllByText('阶段 1').length).toBeGreaterThan(0))
    expect((screen.getAllByLabelText('执行 Agent')[0] as HTMLSelectElement).value).toBe(
      BUILTIN_EXPLORER.id,
    )
  })

  it('shows a pipeline stage whose agent is no longer available', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({
        pattern: 'pipeline',
        pipeline: [
          { stage: 'stage-1', agent: 'user.gone' },
          { stage: 'stage-2', agent: BUILTIN_CODER.id, dependsOn: ['stage-1'] },
        ],
      }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getAllByText('阶段 1').length).toBeGreaterThan(0))
    expect((screen.getAllByLabelText('执行 Agent')[0] as HTMLSelectElement).value).toBe('user.gone')
    expect(screen.getByRole('option', { name: 'user.gone' })).toBeDefined()
  })

  it('shows an empty pipeline and refills it from the members', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ pattern: 'pipeline', pipeline: [] }),
      published: published({}, 2),
      validation: { ok: false, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText(/还没有阶段/)).toBeDefined())
    // 先添加一个阶段，再用成员把整条流水线补齐。
    fireEvent.click(screen.getByRole('button', { name: '添加阶段' }))
    await waitFor(() => expect(screen.getAllByText('阶段 1').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: '按成员补全阶段' }))
    await waitFor(() => expect(screen.getAllByText('阶段 3').length).toBeGreaterThan(0))
  })

  it('shows validation errors, disables publish, and handles load failure', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ name: {}, description: {}, coordinator: 'user.missing' }),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('至少填写一种语言的名称')).toBeDefined())
    expect(screen.getByText('找不到 Agent user.missing')).toBeDefined()
    expect((screen.getByRole('button', { name: '发布 v3' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    cleanup()
    const failed = setup({ team: undefined })
    const back = vi.fn()
    await renderEditor(failed.store, { teamId: 'user.team-1', onBack: back })
    await waitFor(() =>
      expect(screen.getByText('读不到这个团队模板，返回团队列表再试一次。')).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('button', { name: '返回团队列表' }))
    expect(back).toHaveBeenCalled()
  })

  it('edits bilingual fields, members, coordinator, and refills pipeline stages', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'Release team' } })
    fireEvent.change(screen.getByLabelText('English description'), {
      target: { value: 'Coordinator and reviewer' },
    })

    // 换主控会把它从成员里去掉；换回来再手动增删成员。
    fireEvent.change(screen.getByLabelText('主控 Agent'), {
      target: { value: BUILTIN_REVIEWER.id },
    })
    expect((screen.getByLabelText('主控 Agent') as HTMLSelectElement).value).toBe(
      BUILTIN_REVIEWER.id,
    )
    expect(screen.queryByRole('checkbox', { name: '代码审查员' })).toBeNull()
    fireEvent.change(screen.getByLabelText('主控 Agent'), {
      target: { value: BUILTIN_CODER.id },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: '代码探索员' }))
    expect((screen.getByRole('checkbox', { name: '代码探索员' }) as HTMLInputElement).checked).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '代码探索员' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码审查员' }))

    // 流水线按引用自动生成；删掉一个后可以按成员补全。
    fireEvent.click(screen.getByRole('radio', { name: '流水线' }))
    await waitFor(() => expect(screen.getAllByText('阶段 3').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: '删除阶段 3' }))
    fireEvent.click(screen.getByRole('button', { name: '按成员补全阶段' }))
    expect(screen.getAllByText('阶段 3').length).toBeGreaterThan(0)

    // 审查循环的 maker / checker 可以换人。
    fireEvent.click(screen.getByRole('radio', { name: '审查循环' }))
    await waitFor(() => expect(screen.getByLabelText('执行者（maker）')).toBeDefined())
    fireEvent.change(screen.getByLabelText('执行者（maker）'), {
      target: { value: BUILTIN_REVIEWER.id },
    })
    expect((screen.getByLabelText('执行者（maker）') as HTMLSelectElement).value).toBe(
      BUILTIN_REVIEWER.id,
    )

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(screen.getByLabelText('已保存')).toBeDefined())
    const saved = calls.find((call) => call.method === 'team.saveDraft')
    expect(saved).toBeDefined()
    const definition = (saved!.params as { definition: TeamDraftFields }).definition
    expect(definition.name['en-US']).toBe('Release team')
    expect(definition.description['en-US']).toBe('Coordinator and reviewer')
    expect(definition.pattern).toBe('review-loop')
    expect(definition.reviewLoop?.maker).toBe(BUILTIN_REVIEWER.id)
  })

  it('lists archived referenced members so they can be unchecked', async () => {
    const retiredDefinition: AgentDefinition = {
      ...BUILTIN_TESTER,
      id: 'user.retired',
      source: 'user',
      name: { 'zh-CN': '退役助手', 'en-US': 'Retired helper' },
    }
    const retired: { summary: AgentSummary; detail: AgentDetail } = {
      summary: {
        agentId: 'user.retired',
        name: retiredDefinition.name,
        description: {},
        source: 'user',
        archived: true,
        status: 'published',
        version: 1,
        hasDraft: false,
        modelMode: 'inherit',
        updatedAt: 1,
      },
      detail: {
        agentId: 'user.retired',
        source: 'user',
        archived: true,
        published: retiredDefinition,
        validation: { ok: true, errors: [], warnings: [] },
      },
    }
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ members: [BUILTIN_EXPLORER.id, 'user.retired'] }),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team, extraAgents: [retired] })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    // 已归档的成员仍在列表里，带「已归档或不可用」，取消勾选后可以保存。
    expect(screen.getByText('已归档或不可用')).toBeDefined()
    const checkbox = screen.getByRole('checkbox', { name: /退役助手/ }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(screen.queryByText('已归档或不可用')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.saveDraft',
        params: {
          definition: expect.objectContaining({ members: [BUILTIN_EXPLORER.id] }),
        },
      }),
    )
  })

  it('handles Esc, publishes dirty changes, and reports save / publish failures', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }

    // 没有改动时 Esc 直接返回；其它按键与无 ⌘ 的 S 不触发。
    const clean = setup({ team })
    const back = vi.fn()
    await renderEditor(clean.store, { teamId: 'user.team-1', onBack: back })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(back).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(back).toHaveBeenCalled()

    // 有改动时发布先保存再发布。
    cleanup()
    const dirty = setup({ team })
    await renderEditor(dirty.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '改名后发布' } })
    fireEvent.click(screen.getByRole('button', { name: '发布 v3' }))
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() =>
      expect(dirty.calls.some((call) => call.method === 'team.publish')).toBe(true),
    )
    expect(dirty.calls.some((call) => call.method === 'team.saveDraft')).toBe(true)

    // 保存失败：停在编辑器里，错误进入 store。
    cleanup()
    const saveFails = setup({ team, saveFails: true })
    await renderEditor(saveFails.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '保存失败' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(saveFails.store.getState().error?.code).toBe('team.invalid'))
    expect(screen.queryByLabelText('已保存')).toBeNull()

    // 发布失败：保存成功、发布失败，对话框关闭。
    cleanup()
    const publishFails = setup({ team, publishFails: true })
    await renderEditor(publishFails.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '发布失败' } })
    fireEvent.click(screen.getByRole('button', { name: '发布 v3' }))
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() => expect(publishFails.store.getState().error?.code).toBe('team.invalid'))
    expect(publishFails.calls.some((call) => call.method === 'team.publish')).toBe(true)
  })

  it('publishes an existing clean team without saving again', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    // 已有草稿且没有改动时，发布不再保存。
    fireEvent.click(screen.getByRole('button', { name: '发布 v3' }))
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.publish',
        params: { teamId: 'user.team-1' },
      }),
    )
    expect(calls.some((call) => call.method === 'team.saveDraft')).toBe(false)
  })

  it('publishes a new team by saving it first', async () => {
    const { store, calls } = setup()
    await renderEditor(store)
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '新团队' } })
    fireEvent.change(screen.getByLabelText('中文描述'), { target: { value: '说明' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '发布 v1' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '发布 v1' }))
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.publish',
        params: { teamId: 'user.team-new' },
      }),
    )
    const save = calls.find((call) => call.method === 'team.saveDraft')
    expect((save!.params as { definition: TeamDraftFields }).definition).not.toHaveProperty('id')
  })

  it('restores a published version as the draft', async () => {
    const oldFields = fields({
      name: { 'zh-CN': '旧版' },
      description: { 'zh-CN': '旧说明' },
    })
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const versionSummary = (
      version: number,
      name: TeamDraftFields['name'],
    ): AgentTeamVersionSummary => ({
      version,
      publishedAt: 1_700_000_000_000 + version,
      name,
      description: oldFields.description,
      pattern: oldFields.pattern,
      memberCount: oldFields.members.length,
    })
    const { store, calls } = setup({
      team,
      versions: [versionSummary(1, oldFields.name), versionSummary(2, fields().name)],
      versionDetail: (version) => ({
        teamId: 'user.team-1',
        source: 'user',
        archived: false,
        published: published(oldFields, version),
        validation: { ok: true, errors: [], warnings: [] },
      }),
    })
    const { onChanged } = await renderEditor(store, { teamId: 'user.team-1' })

    const list = await screen.findByRole('list', { name: '版本历史' })
    const row = within(list)
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText('v1') !== null)!
    fireEvent.click(within(row).getByRole('button', { name: '恢复为草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'team.saveDraft',
        params: { definition: { id: 'user.team-1', ...oldFields } },
      }),
    )
    await waitFor(() =>
      expect((screen.getByLabelText('中文名称') as HTMLInputElement).value).toBe('旧版'),
    )
    expect(screen.getByLabelText('已保存')).toBeDefined()
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps the draft unchanged when a version cannot be restored', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const summary: AgentTeamVersionSummary = {
      version: 1,
      publishedAt: 1,
      name: fields().name,
      description: fields().description,
      pattern: fields().pattern,
      memberCount: fields().members.length,
    }

    // 读取旧版本失败：不写草稿，错误进入 store。
    cleanup()
    const getFails = setup({ team, versions: [summary], versionGetFails: true })
    await renderEditor(getFails.store, { teamId: 'user.team-1' })
    const list = await screen.findByRole('list', { name: '版本历史' })
    fireEvent.click(within(list).getByRole('button', { name: '恢复为草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(getFails.store.getState().error?.code).toBe('team.not_found'))
    expect(getFails.calls.some((call) => call.method === 'team.saveDraft')).toBe(false)
    expect((screen.getByLabelText('中文名称') as HTMLInputElement).value).toBe('发布团队')

    // 保存成草稿失败：字段保持当前值，也不标记已保存。
    cleanup()
    const saveFails = setup({
      team,
      versions: [summary],
      versionDetail: () => ({ ...team, published: published({}, 1) }),
      saveFails: true,
    })
    await renderEditor(saveFails.store, { teamId: 'user.team-1' })
    const failList = await screen.findByRole('list', { name: '版本历史' })
    fireEvent.click(within(failList).getByRole('button', { name: '恢复为草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(saveFails.store.getState().error?.code).toBe('team.invalid'))
    expect(saveFails.calls.some((call) => call.method === 'team.saveDraft')).toBe(true)
    expect((screen.getByLabelText('中文名称') as HTMLInputElement).value).toBe('发布团队')
    expect(screen.queryByLabelText('已保存')).toBeNull()
  })

  it('archives a team and unarchives it again', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const versions: AgentTeamVersionSummary[] = [
      {
        version: 2,
        publishedAt: 1,
        name: fields().name,
        description: fields().description,
        pattern: fields().pattern,
        memberCount: fields().members.length,
      },
    ]
    const { store, calls } = setup({ team, versions })
    const { onBack, onChanged } = await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '归档' }))
    const archiveDialog = await screen.findByRole('dialog')
    expect(within(archiveDialog).getByText('归档这个模板？')).toBeDefined()
    await userEvent.click(within(archiveDialog).getByRole('button', { name: '归档' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'team.archive', params: { teamId: 'user.team-1' } }),
    )
    expect(onBack).toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()

    // 归档后只读：没有保存 / 发布与归档菜单，也不能恢复旧版本。
    cleanup()
    const archived = setup({ team: { ...team, archived: true }, versions })
    const archivedResult = await renderEditor(archived.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText(/已归档的模板只读/)).toBeDefined())
    expect(screen.getByLabelText('中文名称').closest('fieldset')?.disabled).toBe(true)
    await screen.findByRole('list', { name: '版本历史' })
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^发布 v/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复为草稿' })).toBeNull()

    // 归档的模板仍可复制为副本：保存成不带 id 的新模板并打开它。
    fireEvent.click(screen.getByRole('button', { name: '复制为副本' }))
    await waitFor(() =>
      expect(archived.calls).toContainEqual({
        method: 'team.saveDraft',
        params: {
          definition: expect.objectContaining({
            name: { 'zh-CN': '发布团队 副本', 'en-US': '发布团队 copy' },
          }),
        },
      }),
    )
    await waitFor(() => expect(archivedResult.onOpenTeam).toHaveBeenCalledWith('user.team-new'))

    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await waitFor(() =>
      expect(archived.calls).toContainEqual({
        method: 'team.unarchive',
        params: { teamId: 'user.team-1' },
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '保存草稿' })).toBeDefined())
    expect(archivedResult.onChanged).toHaveBeenCalled()
  })

  it('duplicates the current team as a new draft', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team })
    const { onChanged, onOpenTeam } = await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '复制为副本' }))
    await waitFor(() => expect(onOpenTeam).toHaveBeenCalledWith('user.team-new'))
    expect(onChanged).toHaveBeenCalled()
    const save = calls.find((call) => call.method === 'team.saveDraft')
    expect(save?.params).toMatchObject({
      definition: {
        name: { 'zh-CN': '发布团队 副本', 'en-US': '发布团队 copy' },
        description: fields().description,
        coordinator: fields().coordinator,
        members: fields().members,
        pattern: fields().pattern,
      },
    })
    expect((save?.params as { definition: { id?: string } }).definition.id).toBeUndefined()

    // 保存失败时留在原模板，不打开副本。
    cleanup()
    const failing = setup({ team, saveFails: true })
    const failed = await renderEditor(failing.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '复制为副本' }))
    await waitFor(() => expect(failing.store.getState().error?.code).toBe('team.invalid'))
    expect(failed.onOpenTeam).not.toHaveBeenCalled()
    expect(screen.getByText('发布团队')).toBeDefined()
  })

  it('stops publishing when the draft cannot be saved first', async () => {
    const { store, calls } = setup({ team: undefined, saveFails: true })
    await renderEditor(store)
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '新团队' } })
    fireEvent.change(screen.getByLabelText('中文描述'), { target: { value: '说明' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '发布 v1' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '发布 v1' }))
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }))
    await waitFor(() => expect(store.getState().error?.code).toBe('team.invalid'))
    expect(calls.some((call) => call.method === 'team.publish')).toBe(false)
    // 保存失败时发布对话框不关闭，等用户处理。
    expect(screen.getByText('发布 v1？')).toBeDefined()
  })

  it('duplicates with a fallback name when the draft has no localized name', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft({ name: {} }),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store, calls } = setup({ team })
    const { onOpenTeam } = await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('未命名团队')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '复制为副本' }))
    await waitFor(() => expect(onOpenTeam).toHaveBeenCalled())
    const save = calls.find((call) => call.method === 'team.saveDraft')
    expect((save?.params as { definition: TeamDraftFields }).definition.name).toEqual({
      'zh-CN': '未命名团队 副本',
      'en-US': 'Team copy',
    })
  })

  it('opens the more menu from the keyboard and lets Escape close it', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())

    const trigger = screen.getByRole('button', { name: '更多操作' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: '复制为副本' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: '归档' })).toBeDefined()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
  })

  it('warns about unsaved changes before archiving', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }
    const { store } = setup({ team })
    const { onBack } = await renderEditor(store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    fireEvent.change(screen.getByLabelText('中文名称'), { target: { value: '未保存的改名' } })

    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '归档' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/当前未保存的修改会丢失/)).toBeDefined()
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onBack).not.toHaveBeenCalled()
  })

  it('keeps the team state when archiving or unarchiving fails', async () => {
    const team: AgentTeamDetail = {
      teamId: 'user.team-1',
      source: 'user',
      archived: false,
      draft: draft(),
      published: published({}, 2),
      validation: { ok: true, errors: [], warnings: [] },
    }

    const failing = setup({ team, archiveFails: true })
    const result = await renderEditor(failing.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByText('发布团队')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '归档' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '归档' }),
    )
    await waitFor(() => expect(failing.store.getState().error?.code).toBe('team.not_found'))
    expect(result.onBack).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDefined()

    cleanup()
    const unarchiveFails = setup({ team: { ...team, archived: true }, unarchiveFails: true })
    await renderEditor(unarchiveFails.store, { teamId: 'user.team-1' })
    await waitFor(() => expect(screen.getByRole('button', { name: '取消归档' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await waitFor(() => expect(unarchiveFails.store.getState().error?.code).toBe('team.not_found'))
    expect(screen.getByText(/已归档的模板只读/)).toBeDefined()
  })

  it('内置模板只读：只提供复制副本', async () => {
    const template = BUILTIN_TEAMS[0]!
    const { store, calls } = setup({
      team: {
        teamId: template.id,
        source: 'builtin',
        archived: false,
        published: template,
        validation: { ok: true, errors: [], warnings: [] },
      },
      versions: [
        {
          version: 1,
          publishedAt: 0,
          name: template.name,
          description: template.description,
          pattern: template.pattern,
          memberCount: template.members.length,
        },
      ],
    })
    await renderEditor(store, { teamId: template.id })
    await waitFor(() => expect(screen.getByText(/内置模板只读/)).toBeDefined())
    // 标题区标出来源；只读模板没有保存、发布与归档入口，只留复制副本；表单本身也不可编辑。
    expect(screen.getByText('内置')).toBeDefined()
    expect(screen.getByLabelText('中文名称').closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByLabelText('主控 Agent').closest('fieldset')?.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^发布 v/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()

    // 复制副本另存为用户模板，不修改内置模板本身。
    const savesBefore = calls.filter((call) => call.method === 'team.saveDraft').length
    fireEvent.click(screen.getByRole('button', { name: '复制为副本' }))
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'team.saveDraft')).toHaveLength(
        savesBefore + 1,
      ),
    )
    expect(calls.filter((call) => call.method === 'team.archive')).toHaveLength(0)
    expect(calls.filter((call) => call.method === 'team.saveDraft')).toHaveLength(savesBefore + 1)
  })

  it('handles a new team without any published agents', async () => {
    const api = {
      request: async (method: string) => {
        if (method === 'agent.list') return { agents: [] }
        return {}
      },
      on: () => () => {},
    }
    const store = createSessionStore(api as unknown as MainApi)
    await renderEditor(store)
    expect(
      screen.getByText('还没有已发布的 Agent。先在 Agents 设置里创建并发布一个 Agent。'),
    ).toBeDefined()
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '发布 v1' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
