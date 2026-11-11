// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView, type PlanView, type SessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import type { ProjectSummary } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { SessionHome } from './SessionHome.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const project: ProjectSummary = {
  projectId: 'p1',
  name: 'demo',
  path: 'C:\\work\\demo',
  createdAt: 1,
}

const plan: PlanView = {
  planId: 'pl1',
  content: {
    goal: '修复登录流程',
    files: ['src/login.ts'],
    steps: [
      { id: 'read', title: '查看登录流程' },
      { id: 'test', title: '补测试' },
    ],
    risks: '',
    verification: '测试通过',
    markdown: '',
  },
  steps: [
    { id: 'read', title: '查看登录流程', status: 'done' },
    { id: 'test', title: '补测试', status: 'pending' },
  ],
  status: 'approved',
  seq: 4,
  runId: 'r1',
  turnId: 't1',
}

const view: SessionView = {
  ...createSessionView('s1'),
  info: {
    projectId: 'p1',
    projectPath: 'C:\\work\\demo',
    workspacePath: 'C:\\work\\demo',
    title: '修复登录',
    model: undefined,
    createdAt: 1,
  },
  brief: { content: '## 目标\n修复登录\n- 不要改 API', editedBy: 'user' as const },
  plans: [plan],
  runOrder: ['r1', 'r2'],
  contextTokens: 12_500,
  usage: { inputTokens: 20_000, outputTokens: 5_000 },
}

function installBridge(request: (method: string, params: unknown) => unknown) {
  const handler = vi.fn(async (method: string, params: unknown) => {
    try {
      return { ok: true, result: await request(method, params) }
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'rpc.failed',
          message: cause instanceof Error ? cause.message : String(cause),
        },
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

function setup({
  homeView = view,
  projects = [project],
  status = 'idle' as const,
  onOpenFiles = vi.fn(),
  onOpenInspector = vi.fn(),
} = {}) {
  const store = createStore<Record<string, unknown>>(() => ({
    projects,
  }))
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store as never}>
        <SessionHome
          view={homeView}
          status={status}
          onOpenFiles={onOpenFiles}
          onOpenInspector={onOpenInspector}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return { onOpenFiles, onOpenInspector }
}

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

describe('SessionHome', () => {
  it('previews the tree and inspector, and opens each section', async () => {
    const request = installBridge((method) =>
      method === 'fs.list'
        ? {
            entries: [
              { path: 'src', name: 'src', kind: 'dir', hidden: false },
              { path: 'README.md', name: 'README.md', kind: 'file', hidden: false },
            ],
            truncated: false,
          }
        : {},
    )
    const callbacks = setup()

    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('fs.list', { projectId: 'p1', limit: 6 }, undefined)

    // 改动从对话里的「本轮变更」进入，概要从「+」菜单打开，首页不再重复这两个入口。
    expect(screen.queryByRole('button', { name: '打开改动' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开概要' })).toBeNull()

    expect(screen.queryByRole('button', { name: '打开计划' })).toBeNull()
    expect(screen.getByText('2 个运行')).toBeTruthy()
    expect(screen.getByText('上下文 12.5K')).toBeTruthy()
    expect(screen.getByText('累计 25.0K tokens')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '打开文件树' }))
    await userEvent.click(screen.getByRole('button', { name: '打开检查' }))
    expect(callbacks.onOpenFiles).toHaveBeenCalledOnce()
    expect(callbacks.onOpenInspector).toHaveBeenCalledOnce()
  })

  it('keeps the remaining entries visible with empty states and no plan card', async () => {
    installBridge(() => ({ entries: [], truncated: false }))
    const emptyView: SessionView = {
      ...createSessionView('s1'),
      info: {
        projectId: 'p1',
        projectPath: 'C:\\work\\demo',
        workspacePath: 'C:\\work\\demo',
        title: '',
        model: undefined,
        createdAt: 1,
      },
    }
    setup({ homeView: emptyView, projects: [] })

    expect(await screen.findByText('demo')).toBeTruthy()
    expect(screen.getByText('没有关联的工作空间。')).toBeTruthy()
    expect(screen.getByText('还没有运行记录。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开计划' })).toBeNull()
  })

  it('reports a tree read failure without hiding the entry', async () => {
    installBridge(() => {
      throw new Error('offline')
    })
    setup()
    expect(await screen.findByText('无法读取文件树。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开文件树' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('正在读取目录…')).toBeNull())
  })
})
