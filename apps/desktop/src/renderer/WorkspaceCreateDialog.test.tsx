// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type ProjectSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog.js'

const i18n = createI18n('zh-CN')

const project: ProjectSummary = {
  projectId: 'p1',
  name: 'repo',
  path: '/work/repo',
  createdAt: 1,
}

function installBridge(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(handler)
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request: async (method: string, params: Record<string, unknown>) => {
      try {
        return { ok: true, result: await request(method, params) }
      } catch (error) {
        if (error instanceof RpcError) return { ok: false, error: error.toInfo() }
        throw error
      }
    },
    on: () => () => undefined,
  }
  return request
}

function setup(
  options: {
    openProject?: () => Promise<ProjectSummary | undefined>
    onOpenChange?: (open: boolean) => void
    onCreated?: (project: ProjectSummary) => void
  } = {},
) {
  const openProject = vi.fn(options.openProject ?? (async () => project))
  const refreshProjects = vi.fn(async () => undefined)
  const store = createStore<Record<string, unknown>>(() => ({
    openProject,
    refreshProjects,
  })) as unknown as SessionStore
  const onOpenChange = vi.fn(options.onOpenChange ?? (() => undefined))
  const onCreated = vi.fn(options.onCreated ?? (() => undefined))
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <WorkspaceCreateDialog open onOpenChange={onOpenChange} onCreated={onCreated} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { openProject, refreshProjects, onOpenChange, onCreated }
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('WorkspaceCreateDialog', () => {
  it('opens an existing folder and reports the created workspace', async () => {
    installBridge(async () => ({}))
    const { openProject, onOpenChange, onCreated } = setup()

    await userEvent.click(screen.getByRole('button', { name: /打开本地文件夹/ }))

    expect(openProject).toHaveBeenCalledOnce()
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('clones a repository with an automatic name and an optional branch', async () => {
    const request = installBridge(async (method) => {
      if (method === 'project.pickDirectory') return { path: '/work' }
      if (method === 'project.clone') return { project }
      return {}
    })
    const { refreshProjects, onCreated, onOpenChange } = setup()

    await userEvent.click(screen.getByRole('button', { name: /克隆 Git 仓库/ }))
    await userEvent.type(screen.getByLabelText('仓库地址'), 'https://github.com/team/repo.git')
    expect((screen.getByLabelText('工作空间名称') as HTMLInputElement).value).toBe('repo')

    await userEvent.click(screen.getByRole('button', { name: /选择/ }))
    await waitFor(() =>
      expect((screen.getByLabelText('保存位置') as HTMLInputElement).value).toBe('/work'),
    )

    await userEvent.type(screen.getByLabelText('分支（可选）'), 'develop')
    await userEvent.click(screen.getByRole('button', { name: '克隆' }))

    expect(request).toHaveBeenCalledWith('project.clone', {
      remoteUrl: 'https://github.com/team/repo.git',
      parentPath: '/work',
      name: 'repo',
      branch: 'develop',
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project))
    expect(refreshProjects).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a translated clone error and keeps the form open', async () => {
    installBridge(async (method) => {
      if (method === 'project.pickDirectory') return { path: '/work' }
      throw new RpcError('project.clone_failed', { reason: 'repository not found' })
    })
    const { onOpenChange } = setup()

    await userEvent.click(screen.getByRole('button', { name: /克隆 Git 仓库/ }))
    await userEvent.type(screen.getByLabelText('仓库地址'), 'https://github.com/team/missing.git')
    await userEvent.click(screen.getByRole('button', { name: /选择/ }))
    await waitFor(() =>
      expect((screen.getByLabelText('保存位置') as HTMLInputElement).value).toBe('/work'),
    )
    await userEvent.click(screen.getByRole('button', { name: '克隆' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      '克隆仓库失败：repository not found',
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('uses the generic message for unexpected failures', async () => {
    installBridge(async (method) => {
      if (method === 'project.pickDirectory') {
        throw new Error('dialog crashed')
      }
      return {}
    })
    setup()

    await userEvent.click(screen.getByRole('button', { name: /克隆 Git 仓库/ }))
    await userEvent.click(screen.getByRole('button', { name: /选择/ }))

    expect((await screen.findByRole('alert')).textContent).toContain('工作空间创建失败')
  })

  it('closes the clone step and resets it when reopened', async () => {
    installBridge(async () => ({}))
    const { onOpenChange } = setup()

    await userEvent.click(screen.getByRole('button', { name: /克隆 Git 仓库/ }))
    await userEvent.click(screen.getByRole('button', { name: /返回/ }))
    expect(screen.getByRole('button', { name: /打开本地文件夹/ })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
