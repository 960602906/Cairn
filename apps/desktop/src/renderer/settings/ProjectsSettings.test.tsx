// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProjectSummary, Settings } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(cleanup)

const project = (patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'p1',
  name: '示例',
  path: '/work/demo',
  createdAt: 1_700_000_000_000,
  sessionCount: 2,
  lastUsedAt: 1_700_000_100_000,
  readAgentsMd: true,
  enableProjectSkills: false,
  ...patch,
})

function setup(initial: ProjectSummary[] = [project()]) {
  let projects = initial
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'settings.get') return { locale: 'zh-CN', providers: [] } satisfies Settings
    if (method === 'settings.shell') return { detected: 'bash', options: ['auto'] }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') return { projects }
    if (method === 'project.update') {
      const patch = params as {
        projectId: string
        name?: string
        readAgentsMd?: boolean
        enableProjectSkills?: boolean
      }
      projects = projects.map((item) =>
        item.projectId === patch.projectId
          ? {
              ...item,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.readAgentsMd !== undefined ? { readAgentsMd: patch.readAgentsMd } : {}),
              ...(patch.enableProjectSkills !== undefined
                ? { enableProjectSkills: patch.enableProjectSkills }
                : {}),
            }
          : item,
      )
      return projects.find((item) => item.projectId === (params as { projectId: string }).projectId)
    }
    if (method === 'project.remove') {
      const { projectId } = params as { projectId: string }
      projects = projects.filter((item) => item.projectId !== projectId)
      return {}
    }
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
  return { request }
}

async function openProjects() {
  await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
  const nav = await screen.findByRole('navigation', { name: '设置分类' })
  await userEvent.click(within(nav).getByRole('button', { name: '项目' }))
  return screen.findByRole('heading', { name: '项目' })
}

describe('ProjectsSettings', () => {
  it('lists a project and saves a rename and the switches', async () => {
    const { request } = setup()
    await openProjects()
    const card = screen.getByRole('list', { name: '已打开的项目' })
    expect(within(card).getByText('/work/demo')).toBeTruthy()
    expect(within(card).getByText(/2 个会话/)).toBeTruthy()

    const name = within(card).getByLabelText('项目名称')
    await userEvent.clear(name)
    await userEvent.type(name, '新名字')
    name.blur()
    expect(request).toHaveBeenCalledWith('project.update', { projectId: 'p1', name: '新名字' })

    await userEvent.click(within(card).getByRole('switch', { name: '读取 AGENTS.md' }))
    expect(request).toHaveBeenCalledWith('project.update', { projectId: 'p1', readAgentsMd: false })
    await userEvent.click(within(card).getByRole('switch', { name: '启用项目内技能' }))
    expect(request).toHaveBeenCalledWith('project.update', {
      projectId: 'p1',
      enableProjectSkills: true,
    })
  })

  it('confirms removal and explains that files stay', async () => {
    setup()
    await openProjects()
    await userEvent.click(screen.getByRole('button', { name: '从列表移除' }))
    expect(screen.getByText(/不删除磁盘上的文件/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(await screen.findByText(/还没有打开过项目/)).toBeTruthy()
  })
})
