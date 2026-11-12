// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError } from '@cairn/protocol'
import { WorkspaceGitBar } from './WorkspaceGitBar.js'

const i18n = createI18n('zh-CN')

function installBridge(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(handler)
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request: async (method: string, params: Record<string, unknown>) => {
      try {
        return { ok: true, result: await request(method, params) }
      } catch (error) {
        if (error instanceof RpcError) return { ok: false, error: error.toInfo() }
        return { ok: false, error: { code: 'rpc.internal' } }
      }
    },
    on: () => () => undefined,
  }
  return request
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function view(
  projectPath: string | undefined,
  props: Partial<Parameters<typeof WorkspaceGitBar>[0]> = {},
) {
  return (
    <I18nextProvider i18n={i18n}>
      <WorkspaceGitBar projectPath={projectPath} {...props} />
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('WorkspaceGitBar', () => {
  it('shows the current directory with its material folder icon', () => {
    const { container } = render(view('/work/src'))

    expect(screen.getByLabelText('当前目录：/work/src')).toBeTruthy()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('./folder-src.svg')
  })

  it('shows the workspace name and its current branch', async () => {
    const request = installBridge(async () => ({
      branch: 'main',
      branches: ['main', 'feature/x'],
    }))
    render(view('/work/demo'))

    expect(screen.getByLabelText('当前目录：/work/demo')).toBeTruthy()
    expect(screen.getByText('demo')).toBeTruthy()
    expect(screen.queryByText('本地')).toBeNull()
    expect(await screen.findByText('main')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('project.gitInfo', { path: '/work/demo' })
    expect(screen.getByLabelText('当前分支：main')).toBeTruthy()
  })

  it('renders nothing without a project directory', () => {
    const request = installBridge(async () => ({ branch: 'main' }))
    const { container } = render(view(undefined))

    expect(container.firstChild).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the directory when the branch cannot be read', async () => {
    const request = installBridge(async () => {
      throw new Error('not a repository')
    })
    render(view('/work/demo'))

    expect(screen.getByLabelText('当前目录：/work/demo')).toBeTruthy()
    expect(request).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByLabelText(/^当前分支/)).toBeNull())
    expect(screen.queryByLabelText(/^当前分支/)).toBeNull()
  })

  it('still shows the directory when the main bridge is unavailable', () => {
    render(view('/work/demo'))

    expect(screen.getByLabelText('当前目录：/work/demo')).toBeTruthy()
    expect(screen.queryByLabelText(/^当前分支/)).toBeNull()
  })

  it('refreshes the branch when the window regains focus', async () => {
    const request = installBridge(async () => ({ branch: 'main' }))
    render(view('/work/demo'))
    expect(await screen.findByText('main')).toBeTruthy()

    request.mockResolvedValueOnce({ branch: 'feature/git-bar' })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(await screen.findByText('feature/git-bar')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('ignores a response for a previous directory', async () => {
    const first = deferred<{ branch?: string }>()
    const second = deferred<{ branch?: string }>()
    installBridge((_method, params) =>
      params['path'] === '/work/first' ? first.promise : second.promise,
    )
    const rendered = render(view('/work/first'))
    rendered.rerender(view('/work/other'))

    await act(async () => second.resolve({ branch: 'second' }))
    expect(await screen.findByText('second')).toBeTruthy()

    await act(async () => first.resolve({ branch: 'first' }))
    expect(screen.queryByText('first')).toBeNull()
  })

  it('switches to another local branch from the branch menu', async () => {
    const request = installBridge(async (method, params) => {
      if (method === 'project.gitCheckout') return { branch: params['branch'] }
      return { branch: 'main', branches: ['main', 'feature/x'] }
    })
    render(view('/work/demo'))
    await screen.findByText('main')

    await userEvent.click(screen.getByLabelText('当前分支：main'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'feature/x' }))

    expect(await screen.findByLabelText('当前分支：feature/x')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('project.gitCheckout', {
      path: '/work/demo',
      branch: 'feature/x',
    })
  })

  it('shows the Git reason when switching branches fails', async () => {
    installBridge(async (method) => {
      if (method === 'project.gitCheckout') {
        throw new RpcError('project.checkout_failed', { reason: 'Aborting' })
      }
      return { branch: 'main', branches: ['main', 'dirty'] }
    })
    render(view('/work/demo'))
    await screen.findByText('main')

    await userEvent.click(screen.getByLabelText('当前分支：main'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'dirty' }))

    expect((await screen.findByRole('alert')).textContent).toContain('切换分支失败：Aborting')
    expect(screen.getByLabelText('当前分支：main')).toBeTruthy()
  })

  it('falls back to the current branch when the branch list is missing', async () => {
    installBridge(async () => ({ branch: 'main' }))
    render(view('/work/demo'))
    await screen.findByText('main')

    await userEvent.click(screen.getByLabelText('当前分支：main'))
    expect(await screen.findByRole('menuitem', { name: 'main' })).toBeTruthy()
  })

  it('does nothing when the bridge disappears before switching', async () => {
    const request = installBridge(async () => ({ branch: 'main', branches: ['main', 'dev'] }))
    render(view('/work/demo'))
    await screen.findByText('main')
    delete (window as { cairn?: unknown }).cairn

    await userEvent.click(screen.getByLabelText('当前分支：main'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'dev' }))

    expect(request).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('当前分支：main')).toBeTruthy()
  })

  it('shows a generic message for an unexpected switch failure', async () => {
    installBridge(async () => ({ branch: 'main', branches: ['main', 'dev'] }))
    render(view('/work/demo'))
    await screen.findByText('main')
    ;(window as { cairn?: { request?: unknown } }).cairn!.request = async () => {
      throw new Error('boom')
    }

    await userEvent.click(screen.getByLabelText('当前分支：main'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'dev' }))

    expect((await screen.findByRole('alert')).textContent).toContain('切换分支失败')
    expect(screen.getByLabelText('当前分支：main')).toBeTruthy()
  })

  it('switches the workspace and opens a folder from the directory menu', async () => {
    const onSelectProject = vi.fn()
    const onOpenFolder = vi.fn()
    render(
      view('/work/demo', {
        projects: [
          { projectId: 'p1', name: 'demo', path: '/work/demo', createdAt: 1 },
          { projectId: 'p2', name: 'other', path: '/work/other', createdAt: 2 },
        ],
        onSelectProject,
        onOpenFolder,
      }),
    )

    await userEvent.click(screen.getByLabelText('工作空间：demo'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'other' }))
    expect(onSelectProject).toHaveBeenCalledWith('/work/other')

    await userEvent.click(screen.getByLabelText('工作空间：demo'))
    await userEvent.click(await screen.findByRole('menuitem', { name: '选择文件夹…' }))
    expect(onOpenFolder).toHaveBeenCalledOnce()
  })

  it('offers the folder dialog before a workspace is chosen', async () => {
    const onSelectProject = vi.fn()
    const onOpenFolder = vi.fn()
    render(view(undefined, { projects: [], onSelectProject, onOpenFolder }))

    await userEvent.click(screen.getByRole('button', { name: '选择工作空间' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '选择文件夹…' }))
    expect(onOpenFolder).toHaveBeenCalledOnce()
    expect(onSelectProject).not.toHaveBeenCalled()
  })
})
