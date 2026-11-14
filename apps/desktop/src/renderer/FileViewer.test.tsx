// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type SessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import { RpcError, type FileContent, type ProjectSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { FileViewer } from './FileViewer.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')
const REVEAL = i18n.t('session:fileTree.reveal')

const project: ProjectSummary = {
  projectId: 'p1',
  name: 'demo',
  path: 'C:\\work\\demo',
  createdAt: 1,
}

const view: SessionView = {
  ...createSessionView('s1'),
  info: {
    projectId: 'p1',
    projectPath: 'C:\\work\\demo',
    workspacePath: 'C:\\work\\demo',
    title: '预览',
    model: undefined,
    thinkingLevel: undefined,
    createdAt: 1,
  },
}

function installBridge(request: (method: string, params: unknown) => unknown) {
  const handler = vi.fn(async (method: string, params: unknown) => {
    try {
      return { ok: true, result: await request(method, params) }
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof RpcError ? cause.toInfo() : { code: 'rpc.internal' },
      }
    }
  })
  ;(window as { cairn?: unknown }).cairn = {
    ready: async () => ({ ok: true, result: undefined }),
    request: handler,
    on: () => () => undefined,
  }
  return handler
}

function setup(content: FileContent | Error, path = 'src/index.ts') {
  const store = createStore<Record<string, unknown>>(() => ({ projects: [project] }))
  const handler = installBridge((method) => {
    if (method === 'fs.read') {
      if (content instanceof Error) throw content
      return { content }
    }
    return {}
  })
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store as never}>
        <FileViewer path={path} view={view} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { ...rendered, handler }
}

function renderWithLine(line: number) {
  installBridge(() => ({
    content: { kind: 'text' as const, text: 'const a = 1\nconst b = 2\n' },
  }))
  const store = createStore<Record<string, unknown>>(() => ({ projects: [project] }))
  return (
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store as never}>
        <FileViewer path="src/index.ts" view={view} line={line} />
      </SessionStoreProvider>
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('FileViewer', () => {
  it('renders text content with line numbers', async () => {
    setup({ kind: 'text', text: 'const a = 1\nconst b = 2\n' })
    const region = await screen.findByRole('region', { name: '文件预览：src/index.ts' })
    await waitFor(() => expect(region.textContent).toContain('const a = 1'))
    expect(region.textContent).toContain('const b = 2')
    expect(region.textContent).toContain('1')
    expect(region.textContent).toContain('2')
  })

  it('scrolls to the requested line and tolerates a line past the end', async () => {
    const scroll = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scroll,
      configurable: true,
      writable: true,
    })
    try {
      const { rerender } = render(renderWithLine(2))
      const region = await screen.findByRole('region', { name: '文件预览：src/index.ts' })
      await waitFor(() => expect(region.textContent).toContain('const b = 2'))
      await waitFor(() => expect(scroll).toHaveBeenCalled())
      expect(region.querySelector('[data-line="2"]')?.className).toContain('bg-accent-soft')

      scroll.mockClear()
      rerender(renderWithLine(99))
      await waitFor(() => expect(region.textContent).toContain('const b = 2'))
      expect(scroll).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('shows empty, binary and oversized states', async () => {
    setup({ kind: 'text', text: '' })
    expect(await screen.findByText('空文件。')).toBeTruthy()
    cleanup()

    setup({ kind: 'binary', size: 2048 })
    expect(await screen.findByText('二进制文件，无法预览。')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
    cleanup()

    setup({ kind: 'too_large', size: 10 * 1024 * 1024 })
    expect(await screen.findByText('文件过大，无法预览。')).toBeTruthy()
    expect(screen.getByText('10 MB')).toBeTruthy()
  })

  it('shows an error and retries the request', async () => {
    const user = userEvent.setup()
    let fail = true
    const store = createStore<Record<string, unknown>>(() => ({ projects: [project] }))
    const handler = installBridge((method) => {
      if (method !== 'fs.read') return {}
      if (fail) throw new RpcError('fs.not_found')
      return { content: { kind: 'text', text: 'recovered\n' } }
    })
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store as never}>
          <FileViewer path="src/index.ts" view={view} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('无法读取文件')).toBeTruthy()
    expect(screen.getByText('找不到这个文件或目录')).toBeTruthy()
    fail = false
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '文件预览：src/index.ts' }).textContent).toContain(
        'recovered',
      ),
    )
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('reloads the file from the refresh button', async () => {
    const user = userEvent.setup()
    let text = 'first\n'
    const store = createStore<Record<string, unknown>>(() => ({ projects: [project] }))
    installBridge((method) => (method === 'fs.read' ? { content: { kind: 'text', text } } : {}))
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store as never}>
          <FileViewer path="src/index.ts" view={view} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const region = await screen.findByRole('region', { name: '文件预览：src/index.ts' })
    await waitFor(() => expect(region.textContent).toContain('first'))
    text = 'second\n'
    await user.click(screen.getByRole('button', { name: '重新读取文件' }))
    await waitFor(() => expect(region.textContent).toContain('second'))
  })

  it('caps very long files and toggles line wrapping', async () => {
    const user = userEvent.setup()
    const lines = Array.from({ length: 5001 }, (_, index) => `line ${index + 1}`)
    setup({ kind: 'text', text: `${lines.join('\n')}\n` }, 'src/notes.zzz')
    const region = await screen.findByRole('region', { name: '文件预览：src/notes.zzz' })
    expect(await screen.findByText('仅显示前 5000 行，共 5001 行。')).toBeTruthy()
    expect(region.textContent).toContain('line 5000')
    expect(region.textContent).not.toContain('line 5001')

    const wrap = screen.getByRole('button', { name: '换行' })
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    await user.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
  })

  it('reveals the file in the file manager', async () => {
    const user = userEvent.setup()
    const { handler } = setup({ kind: 'text', text: 'x\n' })
    await screen.findByRole('region', { name: '文件预览：src/index.ts' })
    await user.click(screen.getByRole('button', { name: REVEAL }))
    await waitFor(() =>
      expect(handler.mock.calls.find(([method]) => method === 'fs.reveal')?.[1]).toEqual({
        projectId: 'p1',
        path: 'src/index.ts',
      }),
    )
  })

  it('explains when the session has no workspace and does nothing on reveal', async () => {
    const user = userEvent.setup()
    const handler = installBridge(() => ({}))
    const store = createStore<Record<string, unknown>>(() => ({}))
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store as never}>
          <FileViewer path="a.ts" view={undefined} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('没有关联的工作空间。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: REVEAL }))
    expect(handler).not.toHaveBeenCalled()
  })

  it('shows an error without the main process bridge', async () => {
    const store = createStore<Record<string, unknown>>(() => ({ projects: [project] }))
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store as never}>
          <FileViewer path="a.ts" view={view} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(await screen.findAllByText('无法读取文件')).toHaveLength(2)
  })

  it('treats a non-RPC failure as an internal error', async () => {
    setup(new Error('boom'))
    expect(await screen.findByText('无法读取文件')).toBeTruthy()
  })
})
