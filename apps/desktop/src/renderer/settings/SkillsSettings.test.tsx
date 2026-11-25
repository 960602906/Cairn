// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { clearSettingsData } from './settings-data-cache.js'

afterEach(cleanup)

let clipboardWrite: ReturnType<typeof vi.fn>

beforeEach(() => {
  clearSettingsData()
  clipboardWrite = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWrite },
    configurable: true,
  })
})

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

/** 按来源分组后，组的区域名是「标签 + 数量」（例如「已安装 1」）。 */
const groupFor = (label: RegExp) => screen.getByRole('region', { name: label })
const findGroup = (label: RegExp) => screen.findByRole('region', { name: label })
const cardOf = (name: string) => screen.getByLabelText(name)
const cardIn = (label: RegExp, name: string) => within(groupFor(label)).getByLabelText(name)

async function openCard(name: string) {
  await userEvent.click(cardOf(name))
  return screen.findByRole('dialog')
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

  it('groups skills by source in order and hides empty groups', async () => {
    setup({
      skills: [
        skill({ name: 'built', description: 'Built-in.', source: 'builtin' }),
        skill({ name: 'machine', description: 'Machine.', source: 'agents' }),
        skill({ name: 'demo' }),
      ],
      projectSkills: [skill({ name: 'local', source: 'project', projectId: 'p1' })],
      projectSkillsEnabled: true,
    })
    await openSkills()
    await findGroup(/^示例/)

    const headings = within(screen.getByRole('main'))
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent ?? '')
    expect(headings).toHaveLength(4)
    expect(headings[0]).toMatch(/^内置\s*1$/)
    expect(headings[1]).toMatch(/^\.agents\s*1$/)
    expect(headings[2]).toMatch(/^已安装\s*1$/)
    expect(headings[3]).toMatch(/^示例\s*1$/)

    expect(within(groupFor(/^内置/)).getByText('built')).toBeTruthy()
    expect(within(groupFor(/^\.agents/)).getByText('machine')).toBeTruthy()
    expect(within(groupFor(/^已安装/)).getByText('demo')).toBeTruthy()
    expect(within(groupFor(/^示例/)).getByText('local')).toBeTruthy()
    // 卡片上不再显示来源标签。
    expect(within(cardOf('demo')).queryByText('已安装')).toBeNull()
  })

  it('hides groups that search filters out', async () => {
    setup()
    await openSkills()
    await findGroup(/^内置/)
    const search = screen.getByRole('searchbox', { name: '搜索技能' })

    await userEvent.type(search, 'demo')
    await waitFor(() => expect(screen.queryByRole('region', { name: /^内置/ })).toBeNull())
    expect(screen.getByRole('region', { name: /^已安装/ })).toBeTruthy()
    expect(screen.getByLabelText('demo')).toBeTruthy()
    expect(screen.queryByLabelText('example')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'missing')
    expect(await screen.findByText('没有匹配的技能。')).toBeTruthy()
  })

  it('lists built-in and installed skills and saves the enable switch', async () => {
    const { request } = setup()
    await openSkills()
    await findGroup(/^内置/)
    expect(within(groupFor(/^内置/)).getByText('example')).toBeTruthy()
    expect(within(groupFor(/^已安装/)).getByText('demo')).toBeTruthy()
    const demoCard = cardOf('demo')
    expect(within(demoCard).getByText('约 12 tokens')).toBeTruthy()
    // 始终加载开关已经去掉，只剩启用。
    expect(within(demoCard).queryByRole('switch', { name: '始终加载 demo' })).toBeNull()
    expect(within(demoCard).getAllByRole('switch')).toHaveLength(1)

    await userEvent.click(within(demoCard).getByRole('switch', { name: '启用 demo' }))
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      enabled: false,
    })
    await waitFor(() =>
      expect(
        within(demoCard).getByRole('switch', { name: '启用 demo' }).getAttribute('aria-checked'),
      ).toBe('false'),
    )
    await waitFor(() => expect(within(demoCard).getByText('约 0 tokens')).toBeTruthy())
  })

  it('filters installed skills and applies enable state in batch', async () => {
    const { request } = setup({
      skills: [
        skill({ name: 'alpha', description: 'Alpha skill.', source: 'builtin' }),
        skill({ name: 'beta', description: 'Beta skill.' }),
        skill({ name: 'gamma', description: 'Gamma skill.', source: 'agents' }),
      ],
    })
    await openSkills()
    await findGroup(/^已安装/)
    const search = screen.getByRole('searchbox', { name: '搜索技能' })

    await userEvent.type(search, 'beta')
    await waitFor(() => expect(screen.queryByLabelText('alpha')).toBeNull())
    expect(screen.getByLabelText('beta')).toBeTruthy()

    await userEvent.clear(search)
    await userEvent.type(search, '内置')
    await waitFor(() => expect(screen.getByLabelText('alpha')).toBeTruthy())
    expect(screen.queryByLabelText('beta')).toBeNull()

    await userEvent.clear(search)
    await waitFor(() => expect(screen.getByLabelText('alpha')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(cardOf('alpha')).getByRole('checkbox', { name: '选择 alpha' }))
    await userEvent.click(within(cardOf('gamma')).getByRole('checkbox', { name: '选择 gamma' }))
    expect(screen.getByText('已选 2 个')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '启用' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.setEnabled', {
        name: 'alpha',
        source: 'builtin',
        enabled: true,
      }),
    )
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'gamma',
      source: 'agents',
      enabled: true,
    })
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).toBeNull())
  })

  it('clears a legacy pinned flag when toggling the card or the drawer', async () => {
    const { request } = setup({ skills: [skill({ name: 'demo', pinned: true })] })
    await openSkills()
    await findGroup(/^已安装/)

    await userEvent.click(within(cardOf('demo')).getByRole('switch', { name: '启用 demo' }))
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      enabled: false,
      pinned: false,
    })
    await waitFor(() =>
      expect(
        within(cardOf('demo'))
          .getByRole('switch', { name: '启用 demo' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    )

    cleanup()
    const second = setup({ skills: [skill({ name: 'demo', pinned: true })] })
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('demo')
    await waitFor(() => expect(within(dialog).getByText('Demo body.')).toBeTruthy())
    await userEvent.click(within(dialog).getByRole('switch', { name: '启用 demo' }))
    expect(second.request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      enabled: false,
      pinned: false,
    })
  })

  it('clears a legacy pinned flag for batch actions', async () => {
    const { request } = setup({
      skills: [
        skill({ name: 'demo', pinned: true }),
        skill({ name: 'beta', source: 'builtin', pinned: true }),
      ],
    })
    await openSkills()
    await findGroup(/^已安装/)
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(cardOf('demo')).getByRole('checkbox', { name: '选择 demo' }))
    await userEvent.click(within(cardOf('beta')).getByRole('checkbox', { name: '选择 beta' }))

    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.setEnabled', {
        name: 'demo',
        source: 'user',
        enabled: false,
        pinned: false,
      }),
    )
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'beta',
      source: 'builtin',
      enabled: false,
      pinned: false,
    })
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
    await findGroup(/^已安装/)
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(cardOf('one')).getByRole('checkbox', { name: '选择 one' }))
    await userEvent.click(within(cardOf('two')).getByRole('checkbox', { name: '选择 two' }))
    await userEvent.click(within(cardOf('keep')).getByRole('checkbox', { name: '选择 keep' }))
    expect(
      screen.getByText('内置、.agents 与项目技能不能卸载；已选 3 项中有 2 项可卸载。'),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '卸载' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '卸载选中的 2 个技能？' })).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '卸载技能' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'one' }))
    expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'two' })
    await waitFor(() => expect(screen.queryByLabelText('one')).toBeNull())
  })

  it('opens the drawer, switches skills without closing it, and hides uninstall for built-ins', async () => {
    setup()
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('demo')
    await waitFor(() => expect(within(dialog).getByText('Demo body.')).toBeTruthy())
    expect(within(dialog).getByRole('button', { name: '卸载 demo' })).toBeTruthy()

    // 左侧列表仍然可点：点另一张卡片直接在抽屉里切换。
    await userEvent.click(cardOf('example'))
    await waitFor(() => expect(within(dialog).getByText('example body.')).toBeTruthy())
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: '卸载 example' })).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves focus into the drawer and returns it to the card on Escape', async () => {
    setup()
    await openSkills()
    await findGroup(/^已安装/)
    const card = cardOf('demo')
    await userEvent.click(card)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(card))
  })

  it('closes the drawer when entering batch mode', async () => {
    setup()
    await openSkills()
    await findGroup(/^已安装/)
    await openCard('demo')
    expect(screen.getByRole('dialog')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(cardOf('demo')).getByRole('checkbox', { name: '选择 demo' })).toBeTruthy()
  })

  it('shows usage and copies /name for an enabled skill', async () => {
    setup()
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('demo')
    const usage = await waitFor(() => {
      const node = dialog.querySelector('[data-skill-usage]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(usage.textContent).toContain('在输入框输入 /demo，这一轮就会加载它')
    await userEvent.click(within(usage).getByRole('button', { name: '复制' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('/demo '))
  })

  it('shows the disabled hint and updates immediately after enabling', async () => {
    const { request } = setup({ skills: [skill({ name: 'demo', enabled: false })] })
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('demo')
    const usage = await waitFor(() => {
      const node = dialog.querySelector('[data-skill-usage]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(usage.textContent).toContain('启用后，可在输入框用 /demo 调用')
    expect(within(usage).queryByRole('button', { name: '复制' })).toBeNull()

    await userEvent.click(within(dialog).getByRole('switch', { name: '启用 demo' }))
    expect(request).toHaveBeenCalledWith('skill.setEnabled', {
      name: 'demo',
      source: 'user',
      enabled: true,
    })
    await waitFor(() => expect(usage.textContent).toContain('在输入框输入 /demo，这一轮就会加载它'))
    expect(within(usage).getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('names the winning source when a skill is overridden', async () => {
    setup({
      skills: [
        skill({ name: 'dup', source: 'builtin' }),
        skill({ name: 'dup', source: 'user', shadowed: true }),
      ],
    })
    await openSkills()
    await findGroup(/^已安装/)
    await userEvent.click(cardIn(/^已安装/, 'dup'))
    const dialog = await screen.findByRole('dialog')
    const usage = await waitFor(() => {
      const node = dialog.querySelector('[data-skill-usage]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(usage.textContent).toContain('已被「内置」里的同名技能覆盖，/dup 调用的是那一份')
    expect(within(usage).queryByRole('button', { name: '复制' })).toBeNull()
  })

  it('falls back to a generic overridden message when no winner is listed', async () => {
    setup({ skills: [skill({ name: 'dup', shadowed: true })] })
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('dup')
    const usage = await waitFor(() => {
      const node = dialog.querySelector('[data-skill-usage]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(usage.textContent).toContain('已被同名技能覆盖')
  })

  it('shows a script tip that expands the file list without promising approval', async () => {
    setup({
      skills: [
        skill({
          name: 'scripts',
          hasScripts: true,
          files: [
            { path: 'run.sh', bytes: 10, script: true },
            { path: 'build.sh', bytes: 12, script: true },
            { path: 'doc.md', bytes: 5, script: false },
          ],
        }),
      ],
    })
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('scripts')
    await waitFor(() => expect(within(dialog).getByText('scripts body.')).toBeTruthy())

    const tip = within(dialog).getByRole('button', { name: /包含 2 个脚本/ })
    const text = tip.textContent ?? ''
    expect(text).toContain('取决于当前的权限设置')
    expect(text).not.toContain('一定')
    expect(text).not.toContain('会走命令审批')
    // 附带文件默认收起。
    expect(within(dialog).queryByText('run.sh')).toBeNull()

    await userEvent.click(tip)
    await waitFor(() => expect(within(dialog).getByText('run.sh')).toBeTruthy())
    expect(within(dialog).getByText('build.sh')).toBeTruthy()
  })

  it('navigates to permission settings from the script tip without expanding files', async () => {
    setup({
      skills: [
        skill({
          name: 'scripts',
          hasScripts: true,
          files: [{ path: 'run.sh', bytes: 10, script: true }],
        }),
      ],
    })
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('scripts')
    await waitFor(() => expect(within(dialog).getByText('scripts body.')).toBeTruthy())

    await userEvent.click(within(dialog).getByRole('button', { name: '查看权限设置' }))
    expect(await screen.findByRole('heading', { name: '权限与审批' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the body and files in the detail drawer, collapsed by default', async () => {
    const { request } = setup()
    await openSkills()
    await findGroup(/^已安装/)
    const dialog = await openCard('demo')
    await waitFor(() => expect(within(dialog).getByText('Demo body.')).toBeTruthy())
    expect(within(dialog).getByText(/版本 aaaaaaaa/)).toBeTruthy()
    expect(request).toHaveBeenCalledWith('skill.get', { name: 'demo', source: 'user' })
    expect(within(dialog).queryByText('没有附带文件。')).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: /附带文件/ }))
    expect(within(dialog).getByText('没有附带文件。')).toBeTruthy()

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
    await findGroup(/^\.agents/)
    const dialog = await openCard('machine')
    await waitFor(() => expect(within(dialog).getByText('machine body.')).toBeTruthy())
    expect(within(dialog).getByText(/\.agents/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '卸载' })).toBeNull()
  })

  it('uninstalls an installed skill after a danger confirmation', async () => {
    const { request } = setup()
    await openSkills()
    await findGroup(/^已安装/)
    expect(within(groupFor(/^内置/)).queryByRole('button', { name: '卸载 example' })).toBeNull()

    await userEvent.click(within(cardOf('demo')).getByRole('button', { name: '卸载 demo' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/会从本机删除/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '卸载技能' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'demo' })
    await waitFor(() => expect(screen.queryByLabelText('demo')).toBeNull())
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
    const { request } = setup({
      skills: [shadowed, skill({ name: 'removable' })],
      projectSkillsEnabled: true,
      projectReturn: [orphan],
      detailUndefined: ['orphan'],
      pick: { kind: 'zip', path: '/tmp/again.zip' },
    })
    await openSkills()
    await findGroup(/^已安装/)
    await waitFor(() => expect(screen.getByLabelText('orphan')).toBeTruthy())
    expect(within(cardOf('shadowed')).getByText('被覆盖')).toBeTruthy()
    expect(screen.getByRole('region', { name: /^p9/ })).toBeTruthy()
    expect(within(cardOf('shadowed')).getByText('含脚本')).toBeTruthy()

    await userEvent.click(within(cardOf('orphan')).getByRole('switch', { name: '启用 orphan' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.setEnabled', {
        name: 'orphan',
        source: 'project',
        projectId: 'p9',
        enabled: true,
      }),
    )

    const detail = await openCard('shadowed')
    await waitFor(() => expect(within(detail).getByText('shadowed body.')).toBeTruthy())
    await userEvent.click(within(detail).getByRole('button', { name: /附带文件/ }))
    await waitFor(() => expect(within(detail).getByText('2.0 KB')).toBeTruthy())
    expect(within(detail).getByText('2.0 MB')).toBeTruthy()
    expect(within(detail).getByText('文件太多，只显示一部分。')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const loading = await openCard('orphan')
    await waitFor(() => expect(within(loading).getByText('正在读取…')).toBeTruthy())
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

    await userEvent.click(
      within(cardOf('removable')).getByRole('button', { name: '卸载 removable' }),
    )
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    const group = await findGroup(/^示例/)
    await waitFor(() => expect(within(group).getByText('local')).toBeTruthy())
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
    expect(
      within(dialog).getByText(/脚本不会自动运行；执行时是否请求审批取决于当前的权限设置/),
    ).toBeTruthy()
    expect(within(dialog).getByText('run.sh')).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).toHaveBeenCalledWith('skill.install', { source: folder, confirm: true })
    await waitFor(() => expect(screen.getByLabelText('marker')).toBeTruthy())
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

  it('enables batch uninstall only when an installed skill is selected', async () => {
    setup({
      skills: [skill({ name: 'one' }), skill({ name: 'keep', source: 'builtin' })],
    })
    await openSkills()
    await findGroup(/^已安装/)
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    const uninstall = screen.getByRole('button', { name: '卸载' })
    expect(uninstall).toHaveProperty('disabled', true)

    await userEvent.click(within(cardOf('keep')).getByText('keep'))
    expect(uninstall).toHaveProperty('disabled', true)
    expect(
      screen.getByText('内置、.agents 与项目技能不能卸载；已选 1 项中有 0 项可卸载。'),
    ).toBeTruthy()

    await userEvent.click(within(cardOf('one')).getByText('one'))
    expect(uninstall).toHaveProperty('disabled', false)
  })

  it('keeps the base list when a project or base skill request fails', async () => {
    setup({ failBaseList: true })
    await openSkills()
    expect(await screen.findByText(/还没有技能/)).toBeTruthy()
    cleanup()

    setup({ projectSkillsEnabled: true, failProjectList: true })
    await openSkills()
    await findGroup(/^已安装/)
    expect(cardOf('demo')).toBeTruthy()
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
    await findGroup(/^已安装/)
    await userEvent.click(
      within(cardOf('removable')).getByRole('button', { name: '卸载 removable' }),
    )
    const confirm = await screen.findByRole('dialog')
    await userEvent.click(within(confirm).getByRole('button', { name: '卸载技能' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('skill.uninstall', { name: 'removable' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(cardOf('removable')).toBeTruthy()

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
