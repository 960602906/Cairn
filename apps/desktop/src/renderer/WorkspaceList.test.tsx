// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProjectSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { WorkspaceList, sortWorkspaceProjects } from './WorkspaceList.js'

const i18n = createI18n('zh-CN')

const project = (patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'p1',
  name: 'demo',
  path: '/work/demo',
  createdAt: 1,
  sessionCount: 1,
  lastUsedAt: 10,
  ...patch,
})

function setup(
  projects: ProjectSummary[],
  options: {
    withRefresh?: boolean
    onNewConversation?: (project: ProjectSummary) => void
    openedProject?: ProjectSummary | undefined
  } = {},
) {
  const updateProject = vi.fn(async () => undefined)
  const removeProject = vi.fn(async () => true)
  const refreshProjects = vi.fn(async () => undefined)
  const openProject = vi.fn(async () => options.openedProject)
  const store = createStore<Record<string, unknown>>(() => ({
    projects,
    updateProject,
    removeProject,
    openProject,
    ...(options.withRefresh === false ? {} : { refreshProjects }),
  })) as unknown as SessionStore
  const onConfigure = vi.fn()
  const onBrowseInFileTree = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <WorkspaceList
          onConfigure={onConfigure}
          onBrowseInFileTree={onBrowseInFileTree}
          onNewConversation={options.onNewConversation}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return {
    updateProject,
    removeProject,
    refreshProjects,
    openProject,
    onConfigure,
    onBrowseInFileTree,
  }
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('WorkspaceList', () => {
  it('sorts pinned first, archived last, then by activity', () => {
    const ordered = sortWorkspaceProjects([
      project({ projectId: 'old', name: 'old', lastUsedAt: 1 }),
      project({ projectId: 'archived', name: 'archived', archivedAt: 5, lastUsedAt: 99 }),
      project({ projectId: 'pinned', name: 'pinned', isPinned: true, lastUsedAt: 2 }),
      project({ projectId: 'new', name: 'new', lastUsedAt: 50 }),
    ])
    expect(ordered.map((item) => item.projectId)).toEqual(['pinned', 'new', 'old', 'archived'])
  })

  it('breaks activity ties by name and treats missing activity as zero', () => {
    const ordered = sortWorkspaceProjects([
      project({ projectId: 'b', name: 'beta', lastUsedAt: undefined }),
      project({ projectId: 'a', name: 'Alpha', lastUsedAt: undefined }),
    ])
    expect(ordered.map((item) => item.projectId)).toEqual(['a', 'b'])
  })

  it('renders rows and wires pin, configure, archive and browse actions', async () => {
    const { updateProject, onConfigure, onBrowseInFileTree } = setup([project()])
    const section = screen.getByRole('region', { name: '工作空间' })
    expect(within(section).getByText('demo')).toBeTruthy()
    expect(screen.getByRole('button', { name: '工作空间操作' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '置顶工作空间' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { pinned: true })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '配置' }))
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '归档' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { archived: true })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '在文件树浏览' }))
    expect(onBrowseInFileTree).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })

  it('shows archived state and removes a workspace after confirmation', async () => {
    const { removeProject } = setup([project({ archivedAt: 3 })])
    expect(screen.getByText('已归档')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '移除工作空间' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/移除工作空间/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '移除' }))
    expect(removeProject).toHaveBeenCalledWith('p1')
  })

  it('unpins, unarchives and reveals an existing workspace', async () => {
    const request = vi.fn(async () => ({ ok: true, result: {} }))
    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request,
      on: () => () => undefined,
    }
    const { updateProject } = setup([project({ isPinned: true, archivedAt: 3 })])
    expect(screen.getByLabelText('取消置顶')).toBeTruthy()
    expect(screen.getByText('已归档')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { pinned: false })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '取消归档' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { archived: false })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '在资源管理器浏览' }))
    expect(request).toHaveBeenCalledWith('fs.reveal', { projectId: 'p1' }, undefined)
  })

  it('shows the empty state when no projects exist', () => {
    setup([], { withRefresh: false })
    expect(screen.getByText('还没有工作空间')).toBeTruthy()
  })

  it('collapses and expands the workspace section', async () => {
    setup([project()])
    expect(screen.getByText('demo')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '收起工作空间' }))
    expect(screen.queryByText('demo')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '展开工作空间' }))
    expect(screen.getByText('demo')).toBeTruthy()
  })

  it('opens the create dialog and adds a local folder', async () => {
    const opened = project({ projectId: 'p2', name: 'other', path: '/work/other' })
    const { openProject } = setup([project()], { openedProject: opened })
    await userEvent.click(screen.getByRole('button', { name: '新建工作空间' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('新建工作空间')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /打开本地文件夹/ })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /克隆 Git 仓库/ })).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: /打开本地文件夹/ }))
    expect(openProject).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('clones a repository from the create dialog', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'project.pickDirectory') return { ok: true, result: { path: '/parent' } }
      if (method === 'project.clone') {
        return {
          ok: true,
          result: {
            project: project({ projectId: 'p2', name: 'repo', path: '/parent/repo' }),
          },
        }
      }
      return { ok: true, result: {} }
    })
    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request,
      on: () => () => undefined,
    }
    const { refreshProjects } = setup([project()])
    await userEvent.click(screen.getByRole('button', { name: '新建工作空间' }))
    await userEvent.click(screen.getByRole('button', { name: /克隆 Git 仓库/ }))
    await userEvent.type(screen.getByLabelText('仓库地址'), 'https://github.com/owner/repo.git')
    expect((screen.getByLabelText('工作空间名称') as HTMLInputElement).value).toBe('repo')
    await userEvent.click(screen.getByRole('button', { name: '选择' }))
    expect(await screen.findByDisplayValue('/parent')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '克隆' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'project.clone',
        {
          remoteUrl: 'https://github.com/owner/repo.git',
          parentPath: '/parent',
          name: 'repo',
        },
        undefined,
      ),
    )
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('starts a new conversation from the row pencil and hides it for archived workspaces', async () => {
    const onNewConversation = vi.fn()
    setup([project(), project({ projectId: 'archived', name: 'archived', archivedAt: 3 })], {
      onNewConversation,
    })
    const pencils = screen.getAllByRole('button', { name: '新建会话' })
    expect(pencils).toHaveLength(1)
    await userEvent.click(pencils[0]!)
    expect(onNewConversation).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })
})
