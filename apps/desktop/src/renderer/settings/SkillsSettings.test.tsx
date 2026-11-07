// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
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
}

function setup(options: SetupOptions = {}) {
  let skills = options.skills ?? [
    skill({ name: 'example', description: 'Example skill.', source: 'builtin' }),
    skill(),
  ]
  let projectSkills = options.projectSkills ?? []
  let pick = options.pick
  const projects = [project({ enableProjectSkills: options.projectSkillsEnabled ?? false })]
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
        return {
          skills: projectId
            ? [...skills, ...projectSkills.filter((item) => item.projectId === projectId)]
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
        return { installed: false, skill: detailOf(incoming, 'Marker body.') }
      }
      case 'skill.get': {
        const input = params as { name: string; source: SkillSource; projectId?: string }
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
        if (!skills.some((item) => item.name === name)) {
          throw new RpcError('skills.not_found', { name })
        }
        skills = skills.filter((item) => item.name !== name)
        return {}
      }
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
})
