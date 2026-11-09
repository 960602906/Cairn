// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProjectSummary } from '@cairn/protocol'
import { FileTreeDialog } from './FileTreeDialog.js'

const i18n = createI18n('zh-CN')

const project: ProjectSummary = {
  projectId: 'p1',
  name: 'demo',
  path: 'C:\\work\\demo',
  createdAt: 1,
}

type Entry = { path: string; name: string; kind: 'file' | 'dir'; hidden: boolean }

function setup(
  initial: Entry[],
  options: {
    project?: ProjectSummary | undefined
    open?: boolean
    onOpenChange?: (open: boolean) => void
  } = {},
) {
  let entries = [...initial]
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'fs.list') {
      const path = String(params['path'] ?? '')
      return {
        entries: entries.filter((entry) => {
          const parent = entry.path.includes('/')
            ? entry.path.slice(0, entry.path.lastIndexOf('/'))
            : ''
          return parent === path && (params['showHidden'] === true || !entry.hidden)
        }),
        truncated: false,
      }
    }
    if (method === 'fs.create') {
      const target = String(params['path'])
      entries = [
        ...entries,
        {
          path: target,
          name: target.split('/').at(-1)!,
          kind: params['kind'] as 'file' | 'dir',
          hidden: false,
        },
      ]
      return { path: target }
    }
    if (method === 'fs.rename') {
      const from = String(params['from'])
      const to = String(params['to'])
      entries = entries.map((entry) =>
        entry.path === from ? { ...entry, path: to, name: to.split('/').at(-1)! } : entry,
      )
      return { path: to }
    }
    if (method === 'fs.delete') {
      const target = String(params['path'])
      entries = entries.filter((entry) => entry.path !== target)
      return {}
    }
    return {}
  })
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request: async (method: string, params: Record<string, unknown>) => ({
      ok: true,
      result: await request(method, params),
    }),
    on: () => () => undefined,
  }
  const selectedProject = 'project' in options ? options.project : project
  render(
    <I18nextProvider i18n={i18n}>
      <FileTreeDialog
        project={selectedProject}
        open={options.open ?? true}
        onOpenChange={options.onOpenChange ?? (() => undefined)}
      />
    </I18nextProvider>,
  )
  return { request }
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
})

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('FileTreeDialog', () => {
  it('loads, filters, creates, renames and deletes entries', async () => {
    const { request } = setup([
      { path: 'notes.txt', name: 'notes.txt', kind: 'file', hidden: false },
      { path: 'src', name: 'src', kind: 'dir', hidden: false },
      { path: 'src/app.ts', name: 'app.ts', kind: 'file', hidden: false },
    ])
    expect(await screen.findByText('notes.txt')).toBeTruthy()
    const srcRow = screen.getByText('src').parentElement!
    await userEvent.click(within(srcRow).getByRole('button', { name: '展开目录' }))
    expect(await screen.findByText('app.ts')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('搜索文件'), 'notes')
    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(screen.queryByText('app.ts')).toBeNull()
    await userEvent.clear(screen.getByLabelText('搜索文件'))

    await userEvent.click(screen.getByRole('button', { name: /^新建文件$/ }))
    await userEvent.type(screen.getByLabelText('名称'), 'created.txt')
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(await screen.findByText('created.txt')).toBeTruthy()

    const createdRow = screen.getByText('created.txt').parentElement!
    await userEvent.click(within(createdRow).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const rename = screen.getByLabelText('名称')
    await userEvent.clear(rename)
    await userEvent.type(rename, 'renamed.txt')
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(await screen.findByText('renamed.txt')).toBeTruthy()

    const renamedRow = screen.getByText('renamed.txt').parentElement!
    await userEvent.click(within(renamedRow).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const confirm = screen.getByRole('dialog', { name: /删除/ })
    await userEvent.click(within(confirm).getByRole('button', { name: '删除' }))
    await expect(screen.queryByText('renamed.txt')).toBeNull()
    expect(request).toHaveBeenCalledWith('fs.create', expect.anything())
  })

  it('shows an error when listing fails', async () => {
    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request: async () => ({ ok: false, error: { code: 'fs.failed', message: 'boom' } }),
      on: () => () => undefined,
    }
    render(
      <I18nextProvider i18n={i18n}>
        <FileTreeDialog project={project} open onOpenChange={() => undefined} />
      </I18nextProvider>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('handles hidden files, menu actions, folders, refresh and keyboard submit', async () => {
    const { request } = setup([
      { path: '.env', name: '.env', kind: 'file', hidden: true },
      { path: 'src', name: 'src', kind: 'dir', hidden: false },
      { path: 'src/app.ts', name: 'app.ts', kind: 'file', hidden: false },
      { path: 'empty', name: 'empty', kind: 'dir', hidden: false },
    ])
    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.queryByText('.env')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '显示隐藏文件' }))
    expect(await screen.findByText('.env')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '隐藏隐藏文件' }))
    await expect(screen.findByText('.env')).rejects.toThrow()

    const srcRow = screen.getByText('src').parentElement!
    await userEvent.dblClick(srcRow)
    expect(await screen.findByText('app.ts')).toBeTruthy()
    const appRow = screen.getByText('app.ts').parentElement!
    await userEvent.dblClick(appRow)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\work\\demo/src/app.ts')

    await userEvent.click(within(srcRow).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '复制路径' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\work\\demo/src')

    await userEvent.click(within(srcRow).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '在资源管理器显示' }))
    expect(request).toHaveBeenCalledWith('fs.reveal', { projectId: 'p1', path: 'src' })

    await userEvent.click(screen.getByText('src'))
    await userEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    await userEvent.type(screen.getByLabelText('名称'), 'nested')
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('nested')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('fs.create', {
      projectId: 'p1',
      path: 'src/nested',
      kind: 'dir',
    })

    await userEvent.click(screen.getByRole('button', { name: '刷新文件树' }))
    const refreshedSrcRow = screen.getByText('src').parentElement!
    await userEvent.click(within(refreshedSrcRow).getByRole('button', { name: '折叠目录' }))
    expect(screen.queryByText('app.ts')).toBeNull()
    await userEvent.click(within(refreshedSrcRow).getByRole('button', { name: '展开目录' }))
    expect(await screen.findByText('app.ts')).toBeTruthy()

    await userEvent.click(
      within(screen.getByText('empty').parentElement!).getByRole('button', { name: '展开目录' }),
    )
    expect(screen.queryByText('这个目录是空的。')).toBeNull()
  })

  it('closes, renders a missing project and reports non-Error action failures', async () => {
    const onOpenChange = vi.fn()
    setup([], { onOpenChange })
    await userEvent.click(screen.getByRole('button', { name: '关闭文件树' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    cleanup()

    setup([], { project: undefined })
    expect(await screen.findByText('文件树')).toBeTruthy()
    expect(screen.getByText('这个目录是空的。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '刷新文件树' }))
    cleanup()

    let calls = 0
    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request: async (method: string) => {
        if (method === 'fs.list') return { ok: true, result: { entries: [], truncated: false } }
        calls += 1
        throw 'create failed'
      },
      on: () => () => undefined,
    }
    render(
      <I18nextProvider i18n={i18n}>
        <FileTreeDialog project={project} open onOpenChange={() => undefined} />
      </I18nextProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: /^新建文件$/ }))
    await userEvent.type(screen.getByLabelText('名称'), 'broken.txt')
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(await screen.findByText('create failed')).toBeTruthy()
    expect(calls).toBe(1)
  })

  it('renders without a bridge and reports string listing failures', async () => {
    delete (window as { cairn?: unknown }).cairn
    render(
      <I18nextProvider i18n={i18n}>
        <FileTreeDialog project={project} open onOpenChange={() => undefined} />
      </I18nextProvider>,
    )
    expect(await screen.findByText('这个目录是空的。')).toBeTruthy()
    cleanup()

    ;(window as { cairn?: unknown }).cairn = {
      ready: async () => ({ ok: true, result: undefined }),
      request: async () => {
        throw 'list failed'
      },
      on: () => () => undefined,
    }
    render(
      <I18nextProvider i18n={i18n}>
        <FileTreeDialog project={project} open onOpenChange={() => undefined} />
      </I18nextProvider>,
    )
    expect(await screen.findByText('list failed')).toBeTruthy()
  })

  it('validates empty names, reports Error action failures and cancels dialogs', async () => {
    const { request } = setup([
      { path: 'notes.txt', name: 'notes.txt', kind: 'file', hidden: false },
    ])
    const row = (await screen.findByText('notes.txt')).parentElement!

    await userEvent.click(screen.getByRole('button', { name: /^新建文件$/ }))
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(request).not.toHaveBeenCalledWith('fs.create', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: '取消' }))

    request.mockRejectedValueOnce(new Error('create failed'))
    await userEvent.click(screen.getByRole('button', { name: /^新建文件$/ }))
    await userEvent.type(screen.getByLabelText('名称'), 'broken.txt')
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('create failed')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))

    await userEvent.click(within(row).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    await userEvent.clear(screen.getByLabelText('名称'))
    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(request).not.toHaveBeenCalledWith('fs.rename', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: '取消' }))

    await userEvent.click(within(row).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    await userEvent.clear(screen.getByLabelText('名称'))
    await userEvent.type(screen.getByLabelText('名称'), 'renamed.txt')
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('renamed.txt')).toBeTruthy()

    const renamedRow = screen.getByText('renamed.txt').parentElement!
    await userEvent.click(within(renamedRow).getByRole('button', { name: '文件操作' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const confirm = screen.getByRole('dialog', { name: /删除/ })
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: /删除/ })).toBeNull()
  })
})
