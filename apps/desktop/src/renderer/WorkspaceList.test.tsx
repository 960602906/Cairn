// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { DEFAULT_PROJECT_ID, type ProjectSummary, type SessionSummary } from '@cairn/protocol'
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

const session = (sessionId: string, title: string, projectPath = '/work/demo'): SessionSummary => ({
  sessionId,
  title,
  projectPath,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})

function setup(
  projects: ProjectSummary[],
  options: {
    withRefresh?: boolean
    onNewConversation?: (project: ProjectSummary) => void
    openedProject?: ProjectSummary | undefined
    sessions?: SessionSummary[]
    onSelectSession?: () => void
    showArchivedSessions?: boolean
  } = {},
) {
  const updateProject = vi.fn(async (_projectId: string, patch: Partial<ProjectSummary> = {}) =>
    project(patch),
  )
  const removeProject = vi.fn(async () => true)
  const refreshProjects = vi.fn(async () => undefined)
  const openProject = vi.fn(async () => options.openedProject)
  const selectSession = vi.fn(async () => undefined)
  const setShowArchivedSessions = vi.fn(async () => undefined)
  const store = createStore<Record<string, unknown>>(() => ({
    projects,
    sessions: options.sessions ?? [],
    activeSessionId: undefined,
    showArchivedSessions: options.showArchivedSessions ?? false,
    setShowArchivedSessions,
    updateProject,
    removeProject,
    openProject,
    selectSession,
    ...(options.withRefresh === false ? {} : { refreshProjects }),
  })) as unknown as SessionStore
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <WorkspaceList
          onNewConversation={options.onNewConversation}
          onSelectSession={options.onSelectSession}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return {
    container: rendered.container,
    setShowArchivedSessions,
    updateProject,
    removeProject,
    refreshProjects,
    openProject,
    selectSession,
  }
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('WorkspaceList', () => {
  it('uses the material folder icon and its open variant', async () => {
    const { container } = setup([project({ path: '/work/src' })])
    const section = screen.getByRole('region', { name: '工作空间' })
    expect(section.querySelector('img')?.getAttribute('src')).toBe('./folder-src-open.svg')

    await userEvent.click(within(section).getByRole('button', { name: 'demo 的会话' }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('./folder-src.svg')
  })

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

  it('renders rows and wires pin, rename, archive and browse actions', async () => {
    const { updateProject } = setup([project()])
    const section = screen.getByRole('region', { name: '工作空间' })
    expect(within(section).getByText('demo')).toBeTruthy()
    expect(screen.getByRole('button', { name: '工作空间操作' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '置顶工作空间' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { pinned: true })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const rename = screen.getByRole('dialog')
    expect(within(rename).getByText('重命名工作空间')).toBeTruthy()
    const name = within(rename).getByLabelText('名称')
    await userEvent.clear(name)
    await userEvent.type(name, 'renamed')
    await userEvent.click(within(rename).getByRole('button', { name: '保存' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { name: 'renamed' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '归档' }))
    expect(updateProject).toHaveBeenCalledWith('p1', { archived: true })

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    expect(screen.queryByRole('menuitem', { name: '在文件树浏览' })).toBeNull()
  })

  it('shows the localized default name and hides archive and remove actions', async () => {
    const { updateProject } = setup([
      project({
        projectId: DEFAULT_PROJECT_ID,
        name: 'Default Project',
        path: '/app/default-project',
        isDefault: true,
      }),
    ])
    expect(screen.getByText('默认项目')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '工作空间操作' }))
    expect(screen.getByRole('menuitem', { name: '置顶工作空间' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '重命名' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '归档' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '移除工作空间' })).toBeNull()

    await userEvent.click(screen.getByRole('menuitem', { name: '置顶工作空间' }))
    expect(updateProject).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, { pinned: true })
  })

  it('shows archived state and removes a workspace after confirmation', async () => {
    const { removeProject } = setup([project({ archivedAt: 3 })], { showArchivedSessions: true })
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
    const { updateProject } = setup([project({ isPinned: true, archivedAt: 3 })], {
      showArchivedSessions: true,
    })
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

  it('hides archived workspaces until the archive toggle is on', async () => {
    const { setShowArchivedSessions } = setup([
      project(),
      project({ projectId: 'archived', name: 'archived', archivedAt: 3 }),
    ])
    expect(screen.queryByText('archived')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: '显示已归档内容' }))
    expect(setShowArchivedSessions).toHaveBeenCalledWith(true)
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

  it('nests a workspace session list and toggles it with the row', async () => {
    setup([project()], {
      sessions: [session('s1', '第一项'), session('s2', '第二项')],
    })
    expect(screen.getByText('第一项')).toBeTruthy()
    expect(screen.getByText('第二项')).toBeTruthy()

    const toggle = screen.getByRole('button', { name: 'demo 的会话' })
    expect(within(toggle).queryByText('2')).toBeNull()
    await userEvent.click(toggle)
    expect(screen.queryByText('第一项')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(toggle)
    expect(screen.getByText('第一项')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('previews long workspace session lists and selects a session', async () => {
    const onSelectSession = vi.fn()
    const { selectSession } = setup([project()], {
      sessions: Array.from({ length: 10 }, (_, index) => session(`s${index}`, `会话 ${index}`)),
      onSelectSession,
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(9)

    await userEvent.click(screen.getByRole('button', { name: '展开剩余 2 个' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(11)

    await userEvent.click(screen.getByRole('button', { name: /^会话 3/ }))
    expect(selectSession).toHaveBeenCalledWith('s3')
    expect(onSelectSession).toHaveBeenCalledOnce()
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
