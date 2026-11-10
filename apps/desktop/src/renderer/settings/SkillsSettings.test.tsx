// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  type HubSkillCard,
  RpcError,
  type ProjectSummary,
  type SkillDetail,
  type SkillInstallSource,
  type SkillSource,
  type SkillSummary,
} from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(cleanup)

const project = (patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'p1',
  name: '示例',
  path: '/work/demo',
  createdAt: 1_700_000_000_000,
  sessionCount: 1,
  readAgentsMd: true,
  enableProjectSkills: false,
  ...patch,
})

const skill = (patch: Partial<SkillSummary> = {}): SkillSummary => ({
  name: 'demo',
  description: 'Demo skill.',
  sha256: 'a'.repeat(64),
  source: 'user',
  enabled: true,
  pinned: false,
  tokens: { index: 12, pinned: 48 },
  shadowed: false,
  hasScripts: false,
  files: [],
  ...patch,
})

const detailOf = (value: SkillSummary, body = 'Skill body.'): SkillDetail => ({
  ...value,
  markdown: `---\nname: ${value.name}\n---\n${body}\n`,
  body: `${body}\n`,
})

interface SetupOptions {
  readonly skills?: SkillSummary[]
  readonly projectSkills?: SkillSummary[]
  readonly projectSkillsEnabled?: boolean
  readonly pick?: SkillInstallSource
  readonly duplicate?: boolean
  readonly projectReturn?: SkillSummary[]
  readonly projects?: ProjectSummary[]
  readonly failBaseList?: boolean
  readonly failProjectList?: boolean
  readonly detailUndefined?: readonly string[]
  readonly hubItems?: readonly HubSkillCard[]
  readonly failHub?: boolean
  readonly failInstallUrl?: boolean
  readonly failPreviewInstall?: boolean
  readonly failUninstall?: boolean
}

function setup(options: SetupOptions = {}) {
  let skills = options.skills ?? [
    skill({ name: 'example', description: 'Example skill.', source: 'builtin' }),
    skill(),
  ]
  let projectSkills = options.projectSkills ?? []
  let pick = options.pick
  const projects = options.projects ?? [
    project({ enableProjectSkills: options.projectSkillsEnabled ?? false }),
  ]
  const incoming = skill({
    name: 'marker',
    description: 'Marker skill.',
    hasScripts: true,
    files: [{ path: 'run.sh', bytes: 10, script: true }],
  })
  const all = () => [...skills, ...projectSkills]
  const find = (input: { name: string; source: SkillSource; projectId?: string }) =>
    all().find(
      (item) =>
        item.name === input.name &&
        item.source === input.source &&
        item.projectId === input.projectId,
    )
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'settings.get':
        return { locale: 'zh-CN', providers: [] }
      case 'settings.shell':
        return { detected: 'bash', options: ['auto'] }
      case 'session.list':
        return { sessions: [] }
      case 'project.list':
        return { projects }
      case 'skill.list': {
        const { projectId } = params as { projectId?: string }
        if (projectId === undefined && options.failBaseList) throw new RpcError('skills.failed')
        if (projectId !== undefined && options.failProjectList) throw new RpcError('skills.failed')
        return {
          skills: projectId
            ? [
                ...skills,
                ...(options.projectReturn ??
                  projectSkills.filter((item) => item.projectId === projectId)),
              ]
            : skills,
        }
      }
      case 'skill.pickSource':
        return pick ? { source: pick } : {}
      case 'skill.install': {
        const input = params as { source: SkillInstallSource; confirm?: boolean }
        if (input.confirm === true) {
          if (options.duplicate) throw new RpcError('skills.duplicate', { name: incoming.name })
          skills = [incoming, ...skills]
          return { installed: true, skill: detailOf(incoming, 'Marker body.') }
        }
        if (options.failPreviewInstall) throw new RpcError('skills.install_failed')
        return { installed: false, skill: detailOf(incoming, 'Marker body.') }
      }
      case 'skill.get': {
        const input = params as { name: string; source: SkillSource; projectId?: string }
        if (options.detailUndefined?.includes(input.name)) return undefined
        const found = find(input)
        if (!found) throw new RpcError('skills.not_found', { name: input.name })
        return detailOf(found, found.name === 'demo' ? 'Demo body.' : `${found.name} body.`)
      }
      case 'skill.setEnabled': {
        const input = params as {
          name: string
          source: SkillSource
          projectId?: string
          enabled?: boolean
          pinned?: boolean
        }
        const update = (list: SkillSummary[]) =>
          list.map((item) =>
            item.name === input.name &&
            item.source === input.source &&
            item.projectId === input.projectId
              ? {
                  ...item,
                  ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                  ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
                }
              : item,
          )
        skills = update(skills)
        projectSkills = update(projectSkills)
        return find(input)
      }
      case 'skill.uninstall': {
        const { name } = params as { name: string }
        if (options.failUninstall) throw new RpcError('skills.failed')
        if (!skills.some((item) => item.name === name)) {
          throw new RpcError('skills.not_found', { name })
        }
        skills = skills.filter((item) => item.name !== name)
        return {}
      }
      case 'hub.skills':
        if (options.failHub) throw new RpcError('hub.failed')
        return {
          items: options.hubItems ?? [
            {
              slug: 'pdf-tools',
              displayName: 'PDF Tools',
              summary: 'Read and annotate PDF files.',
              ownerHandle: 'acme',
              version: '2.0.0',
              downloads: 42,
              stars: 7,
              downloadUrl: 'https://clawhub.ai/api/v1/download?slug=pdf-tools',
            },
          ],
        }
      case 'skill.installUrl':
        if (options.failInstallUrl) throw new RpcError('skills.install_failed')
        return { installed: true, skill: detailOf(incoming) }
      default:
        return {}
    }
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
  return {
    request,
    setPick: (source: SkillInstallSource | undefined) => {
      pick = source
    },
  }
}

async function openSkills() {
  await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
  const nav = await screen.findByRole('navigation', { name: '设置分类' })
  await userEvent.click(within(nav).getByRole('button', { name: '技能' }))
  return screen.findByRole('heading', { name: '技能' })
}

describe('SkillsSettings', () => {
  it('browses the market and installs a skill', async () => {
    const { request } = setup()
    await openSkills()
    await userEvent.click(screen.getByRole('tab', { name: '市场' }))

    const market = await screen.findByRole('list', { name: '技能市场' })
    expect(within(market).getByText('PDF Tools')).toBeTruthy()
    expect(within(market).getByText('@acme · v2.0.0')).toBeTruthy()
    await userEvent.click(within(market).getByRole('button', { name: '下载并安装' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.installUrl', {
        url: 'https://clawhub.ai/api/v1/download?slug=pdf-tools',
      }),
    )
    expect(screen.getByRole('tab', { name: '已安装' }).getAttribute('aria-selected')).toBe('true')
  })

  it('lists built-in and installed skills, and saves the switches', async () => {
    const { request } = setup()
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    expect(within(list).getByText('example')).toBeTruthy()
    expect(within(list).getByText('内置')).toBeTruthy()
    expect(within(list).getByText('已安装')).toBeTruthy()
    const demoCard = within(list).getByLabelText('demo')
    expect(within(demoCard).getByText('约 12 tokens')).toBeTruthy()

    await userEvent.click(within(list).getByRole('switch', { name: '始终加载 demo' }))
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      pinned: true,
    })
    await waitFor(() => expect(within(demoCard).getByText('约 48 tokens')).toBeTruthy())

    await userEvent.click(within(list).getByRole('switch', { name: '启用 demo' }))
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      enabled: false,
    })
    await waitFor(() =>
      expect(
        within(list).getByRole('switch', { name: '启用 demo' }).getAttribute('aria-checked'),
      ).toBe('false'),
    )
    await waitFor(() => expect(within(demoCard).getByText('约 0 tokens')).toBeTruthy())
  })

  it('filters installed skills and applies pinned state in batch', async () => {
    const { request } = setup({
      skills: [
        skill({ name: 'alpha', description: 'Alpha skill.', source: 'builtin' }),
        skill({ name: 'beta', description: 'Beta skill.' }),
        skill({ name: 'gamma', description: 'Gamma skill.', source: 'agents' }),
      ],
    })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    const search = screen.getByRole('searchbox', { name: '搜索技能' })

    await userEvent.type(search, 'beta')
    await waitFor(() => expect(within(list).queryByText('alpha')).toBeNull())
    expect(within(list).getByText('beta')).toBeTruthy()

    await userEvent.clear(search)
    await userEvent.type(search, '内置')
    await waitFor(() => expect(within(list).getByText('alpha')).toBeTruthy())
    expect(within(list).queryByText('beta')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'missing')
    expect(await screen.findByText('没有匹配的技能。')).toBeTruthy()

    await userEvent.clear(search)
    const restored = await screen.findByRole('list', { name: '技能' })
    await waitFor(() => expect(within(restored).getByText('alpha')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(restored).getByRole('checkbox', { name: '选择 alpha' }))
    await userEvent.click(within(restored).getByRole('checkbox', { name: '选择 gamma' }))
    expect(screen.getByText('已选 2 个')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '始终加载' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.setEnabled', {
        name: 'alpha',
        source: 'builtin',
        pinned: true,
      }),
    )
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'gamma',
      source: 'agents',
      pinned: true,
    })
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).toBeNull())
  })

  it('uninstalls several installed skills from batch mode', async () => {
    const { request } = setup({
      skills: [
        skill({ name: 'one' }),
        skill({ name: 'two' }),
        skill({ name: 'keep', source: 'builtin' }),
      ],
    })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(list).getByRole('checkbox', { name: '选择 one' }))
    await userEvent.click(within(list).getByRole('checkbox', { name: '选择 two' }))
    await userEvent.click(within(list).getByRole('checkbox', { name: '选择 keep' }))
    expect(
      screen.getByText('内置、.agents 与项目技能不能卸载；已选 3 项中有 2 项可卸载。'),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '卸载' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '卸载选中的 2 个技能？' })).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '卸载技能' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'one' }))
    expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'two' })
    await waitFor(() => expect(within(list).queryByText('one')).toBeNull())
  })

  it('uninstalls an installed skill from its detail dialog', async () => {
    setup()
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 demo 的详情' }))
    let dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('Demo body.')).toBeTruthy())

    await userEvent.click(within(dialog).getByRole('button', { name: '卸载' }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '卸载“demo”？' })).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '卸载技能' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(within(list).queryByText('demo')).toBeNull())
  })

  it('enables batch uninstall only when an installed skill is selected', async () => {
    setup({
      skills: [skill({ name: 'one' }), skill({ name: 'keep', source: 'builtin' })],
    })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    const uninstall = screen.getByRole('button', { name: '卸载' })
    expect(uninstall).toHaveProperty('disabled', true)

    await userEvent.click(within(list).getByText('keep'))
    expect(uninstall).toHaveProperty('disabled', true)
    expect(
      screen.getByText('内置、.agents 与项目技能不能卸载；已选 1 项中有 0 项可卸载。'),
    ).toBeTruthy()

    await userEvent.click(within(list).getByText('one'))
    expect(uninstall).toHaveProperty('disabled', false)
  })

  it('merges skills from projects with the project switch on', async () => {
    const local = skill({
      name: 'local',
      description: 'Local skill.',
      source: 'project',
      projectId: 'p1',
    })
    const { request } = setup({ projectSkills: [local], projectSkillsEnabled: true })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await waitFor(() => expect(within(list).getByText('local')).toBeTruthy())
    expect(within(list).getByText('项目 · 示例')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('skill.list', { projectId: 'p1' })
  })

  it('previews a folder install and installs after confirmation', async () => {
    const folder: SkillInstallSource = { kind: 'directory', path: '/tmp/marker' }
    const { request } = setup({ pick: folder })
    await openSkills()
    await userEvent.click(screen.getByRole('button', { name: '安装技能' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '从文件夹安装' }))

    const dialog = await screen.findByRole('dialog')
    expect(request).toHaveBeenCalledWith('skill.pickSource', { kind: 'directory' })
    expect(request).toHaveBeenCalledWith('skill.install', { source: folder })
    expect(within(dialog).getByRole('heading', { name: '安装“marker”？' })).toBeTruthy()
    expect(within(dialog).getByText('Marker body.')).toBeTruthy()
    expect(within(dialog).getByText('将安装 1 个附带文件。')).toBeTruthy()
    expect(within(dialog).getByText(/脚本执行时仍会请求审批/)).toBeTruthy()
    expect(within(dialog).getByText('run.sh')).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).toHaveBeenCalledWith('skill.install', { source: folder, confirm: true })
    const list = await screen.findByRole('list', { name: '技能' })
    expect(within(list).getByText('marker')).toBeTruthy()
  })

  it('does nothing when the folder picker is cancelled, and offers a zip entry', async () => {
    const { request } = setup()
    await openSkills()
    await userEvent.click(screen.getByRole('button', { name: '安装技能' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '从 zip 安装' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.pickSource', { kind: 'zip' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(request.mock.calls.some(([method]) => method === 'skill.install')).toBe(false)
  })

  it('shows the body and files in the detail dialog', async () => {
    const { request } = setup()
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 demo 的详情' }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('Demo body.')).toBeTruthy())
    expect(within(dialog).getByText(/版本 aaaaaaaa/)).toBeTruthy()
    expect(within(dialog).getByText('没有附带文件。')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('skill.get', { name: 'demo', source: 'user' })

    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens details by clicking the card and labels machine-level .agents skills', async () => {
    setup({
      skills: [
        skill({
          name: 'machine',
          description: 'Machine skill.',
          source: 'agents',
        }),
      ],
    })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    expect(within(list).getByText('.agents')).toBeTruthy()

    await userEvent.click(within(list).getByText('machine'))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('machine body.')).toBeTruthy())
    expect(within(dialog).getByText(/本机|\.agents/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '卸载' })).toBeNull()
  })

  it('uninstalls an installed skill after a danger confirmation', async () => {
    const { request } = setup()
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    expect(within(list).queryByRole('button', { name: '卸载 example' })).toBeNull()

    await userEvent.click(within(list).getByRole('button', { name: '卸载 demo' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/会从本机删除/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '卸载技能' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'demo' })
    await waitFor(() => expect(within(list).queryByText('demo')).toBeNull())
  })

  it('shows the empty state and reports a duplicate install', async () => {
    setup({ skills: [] })
    await openSkills()
    expect(await screen.findByText(/还没有技能/)).toBeTruthy()
    cleanup()

    setup({
      pick: { kind: 'zip', path: '/tmp/demo.zip' },
      duplicate: true,
    })
    await openSkills()
    await userEvent.click(screen.getByRole('button', { name: '安装技能' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '从 zip 安装' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '安装' }))

    expect((await screen.findByText(/已经安装了同名技能/)).textContent).toContain(
      '已经安装了同名技能',
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('renders badges, file sizes and project fallbacks, and closes dialogs with Escape', async () => {
    const files = [
      { path: 'run.sh', bytes: 2048, script: true },
      { path: 'data.bin', bytes: 2 * 1024 * 1024, script: false },
    ]
    const shadowed = skill({
      name: 'shadowed',
      source: 'builtin',
      shadowed: true,
      hasScripts: true,
      files,
      filesTruncated: true,
    })
    const orphan = skill({
      name: 'orphan',
      source: 'project',
      projectId: 'p9',
      enabled: false,
      pinned: false,
    })
    const unknown = skill({ name: 'unknown', source: 'project', projectId: undefined })
    const { request } = setup({
      skills: [shadowed, skill({ name: 'removable' })],
      projectSkillsEnabled: true,
      projectReturn: [orphan, unknown],
      detailUndefined: ['orphan'],
      pick: { kind: 'zip', path: '/tmp/again.zip' },
    })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    await waitFor(() => expect(within(list).getByText('orphan')).toBeTruthy())
    expect(within(list).getByText('被覆盖')).toBeTruthy()
    expect(within(list).getByText('项目 · p9')).toBeTruthy()
    expect(within(list).getAllByText(/项目 ·/).length).toBe(2)

    await userEvent.click(within(list).getByRole('switch', { name: '启用 orphan' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.setEnabled', {
        name: 'orphan',
        source: 'project',
        projectId: 'p9',
        enabled: true,
      }),
    )

    await userEvent.click(within(list).getByRole('button', { name: '查看 shadowed 的详情' }))
    const detail = await screen.findByRole('dialog')
    await waitFor(() => expect(within(detail).getByText('2.0 KB')).toBeTruthy())
    expect(within(detail).getByText('2.0 MB')).toBeTruthy()
    expect(within(detail).getByText('文件太多，只显示一部分。')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(within(list).getByRole('button', { name: '查看 orphan 的详情' }))
    const loading = await screen.findByRole('dialog')
    expect(within(loading).getByText('正在读取…')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('skill.get', {
      name: 'orphan',
      source: 'project',
      projectId: 'p9',
    })
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByRole('button', { name: '安装技能' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '从 zip 安装' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(within(list).getByRole('button', { name: '卸载 removable' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the base list when a project or base skill request fails', async () => {
    setup({ failBaseList: true })
    await openSkills()
    expect(await screen.findByText(/还没有技能/)).toBeTruthy()
    cleanup()

    setup({ projectSkillsEnabled: true, failProjectList: true })
    await openSkills()
    const list = await screen.findByRole('list', { name: '技能' })
    expect(within(list).getByText('demo')).toBeTruthy()
  })

  it('searches the market and handles fallback cards, failures and empty results', async () => {
    const options = {
      skills: [] as SkillSummary[],
      hubItems: [
        {
          slug: 'bare',
          displayName: 'Bare Skill',
          summary: '',
          downloads: 0,
          stars: 0,
        },
      ] as HubSkillCard[],
      failHub: false,
    }
    const { request } = setup(options)
    await openSkills()
    await userEvent.click(screen.getByRole('tab', { name: '市场' }))
    const market = await screen.findByRole('list', { name: '技能市场' })
    expect(within(market).getByText('ClawHub')).toBeTruthy()
    expect(within(market).getByText('这个技能还没有简介。')).toBeTruthy()
    expect(within(market).queryByRole('link')).toBeNull()
    expect(within(market).getByRole('button', { name: '下载并安装' })).toHaveProperty(
      'disabled',
      true,
    )

    options.failHub = true
    const search = screen.getByRole('searchbox', { name: '搜索技能' })
    await userEvent.type(search, 'git')
    await userEvent.click(within(search.closest('form')!).getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('hub.skills', { query: 'git' }))
    expect(await screen.findByText(/市场暂时不可用/)).toBeTruthy()
    cleanup()

    setup({ skills: [], hubItems: [] })
    await openSkills()
    await userEvent.click(screen.getByRole('tab', { name: '市场' }))
    expect(await screen.findByText('没有找到匹配的技能。')).toBeTruthy()
  })

  it('keeps the market open when install fails, and keeps skills after failed actions', async () => {
    const options = {
      skills: [skill({ name: 'removable', description: 'Removable.' })],
      pick: { kind: 'directory' as const, path: '/tmp/broken' },
      hubItems: [
        {
          slug: 'broken',
          displayName: 'Broken Skill',
          summary: 'Will fail.',
          ownerHandle: 'acme',
          version: '1.0.0',
          downloads: 1,
          stars: 0,
          webUrl: 'https://clawhub.ai/acme/skills/broken',
          downloadUrl: 'https://clawhub.ai/api/v1/download?slug=broken',
        },
      ],
      failInstallUrl: true,
      failPreviewInstall: true,
      failUninstall: true,
    }
    const { request } = setup(options)
    await openSkills()
    await userEvent.click(screen.getByRole('tab', { name: '市场' }))
    const market = await screen.findByRole('list', { name: '技能市场' })
    expect(within(market).getByRole('link')).toBeTruthy()
    await userEvent.click(within(market).getByRole('button', { name: '下载并安装' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.installUrl', {
        url: 'https://clawhub.ai/api/v1/download?slug=broken',
      }),
    )
    expect(screen.getByRole('list', { name: '技能市场' })).toBeTruthy()

    await userEvent.click(screen.getByRole('tab', { name: '已安装' }))
    const list = await screen.findByRole('list', { name: '技能' })
    await userEvent.click(within(list).getByRole('button', { name: '卸载 removable' }))
    const confirm = await screen.findByRole('dialog')
    await userEvent.click(within(confirm).getByRole('button', { name: '卸载技能' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'removable' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(list).getByText('removable')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '安装技能' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '从文件夹安装' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.install', {
        source: { kind: 'directory', path: '/tmp/broken' },
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
