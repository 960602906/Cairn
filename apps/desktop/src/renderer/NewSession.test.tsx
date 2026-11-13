// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { greetingPeriod, NewSession } from './NewSession.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { FILE_DRAG_TYPE } from './file-drag.js'

afterEach(cleanup)

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const providers = [
  {
    id: 'fake',
    kind: 'openai',
    displayName: '测试供应商',
    baseUrl: 'https://example.com',
    models: [
      { id: 'fast', displayName: '快', ...capabilities },
      { id: 'strong', displayName: '强', ...capabilities },
    ],
  },
]

function setup(
  settings: object = {},
  sessionCreate: unknown = { sessionId: 's1' },
  skillList: unknown = { skills: [] },
  handlers: Record<string, (params: unknown) => unknown> = {},
) {
  let current = {
    locale: 'zh-CN',
    providers,
    defaultModel: { providerId: 'fake', modelId: 'fast' },
    permissionMode: 'ask',
    ...settings,
  }
  const request = vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method]
    if (handler) return handler(params)
    if (method === 'settings.get') {
      return current
    }
    if (method === 'settings.update') {
      current = { ...current, ...(params as object) }
      return current
    }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') {
      return {
        projects: [{ projectId: 'p1', name: 'work', path: '/work', createdAt: 1 }],
      }
    }
    if (method === 'skill.list') return skillList
    if (method === 'session.create') return sessionCreate
    if (method === 'fs.search') {
      if ((params as { query: string }).query === 'boom') throw new Error('boom')
      return { entries: [{ path: 'src/a.ts', kind: 'file' }], truncated: false }
    }
    if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
    return {}
  })
  const api = { ready: () => Promise.resolve(), request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  return { request }
}

describe('greetingPeriod', () => {
  it('maps the local hour to the greeting of the day', () => {
    expect([4, 23, 0].map(greetingPeriod)).toEqual(['night', 'night', 'night'])
    expect([5, 11].map(greetingPeriod)).toEqual(['morning', 'morning'])
    expect([12, 13].map(greetingPeriod)).toEqual(['noon', 'noon'])
    expect([14, 17].map(greetingPeriod)).toEqual(['afternoon', 'afternoon'])
    expect([18, 22].map(greetingPeriod)).toEqual(['evening', 'evening'])
  })
})

describe('NewSession welcome', () => {
  it('fills the composer from a suggestion chip without creating a session', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement

    await user.click(screen.getByRole('button', { name: '总结一下这个项目的架构和主要模块' }))

    expect(input.value).toBe('总结一下这个项目的架构和主要模块')
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
  })

  it('stays on the welcome page until the first message is sent', async () => {
    let release!: () => void
    const promptSent = new Promise<{ messageId: string }>((resolve) => {
      release = () => resolve({ messageId: 'm1' })
    })
    const { request } = setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'session.prompt': () => promptSent,
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))

    // 会话已经建好（activeSessionId 已变），但第一轮还没发出去：不切到会话页，避免闪一下空状态。
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.create', {
        projectPath: '/work',
        title: '做点事',
      }),
    )
    expect(screen.getByText('今天想从哪里开始？')).toBeTruthy()
    expect(screen.queryByText('开始一个新任务')).toBeNull()

    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.queryByText('今天想从哪里开始？')).toBeNull())
  })
})

const skill = (name: string, overrides: object = {}) => ({
  name,
  description: `${name} 的说明`,
  sha256: 'a'.repeat(64),
  source: 'user',
  enabled: true,
  pinned: false,
  tokens: { index: 5, pinned: 12 },
  shadowed: false,
  hasScripts: false,
  files: [],
  ...overrides,
})

describe('NewSession composer parity', () => {
  it('lists enabled skills after /, highlights the command, and sends the skill payload', async () => {
    const { request } = setup(
      {},
      { sessionId: 's1' },
      {
        skills: [
          skill('review'),
          skill('off', { enabled: false }),
          skill('shadowed', { shadowed: true }),
        ],
      },
    )
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.list', { projectId: 'p1' }))
    await user.type(input, '/')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    expect(within(list).getByRole('option', { name: /\/plan/ })).toBeTruthy()
    expect(within(list).getByRole('option', { name: /\/review/ })).toBeTruthy()
    expect(within(list).queryByRole('option', { name: /\/off/ })).toBeNull()
    expect(within(list).queryByRole('option', { name: /\/shadowed/ })).toBeNull()
    expect(within(list).getByText('技能')).toBeTruthy()

    // ↑ 回到最后一项，Tab 把 `/review` 补全成可以接着写任务的样子。
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-command-skill:review')
    // ↓ 回到第一项，再 ↑ 回到技能，循环不越界。
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-command-plan')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-command-skill:review')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('/review ')
    expect(document.querySelector('[data-token="command"]')?.textContent).toBe('/review')
    await user.type(input, '看看改动{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '看看改动' }],
        skills: [{ name: 'review' }],
      }),
    )
    expect(request).toHaveBeenCalledWith('session.create', {
      projectPath: '/work',
      title: '看看改动',
    })
  })

  it('does not create a session for a skill without a task and toggles plan from the send button', async () => {
    const { request } = setup({}, { sessionId: 's1' }, { skills: [skill('review')] })
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.list', { projectId: 'p1' }))
    await user.type(input, '/review{Enter}')
    expect(input.value).toBe('/review ')
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())

    await user.clear(input)
    await user.type(input, '/plan')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: '退出计划模式' })).toBeTruthy()
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
  })

  it('only suggests agents the default agent may delegate to', async () => {
    const agentSummary = (agentId: string, name: string) => ({
      agentId,
      name: { 'zh-CN': name },
      description: {},
      source: 'user',
      archived: false,
      status: 'published',
      version: 1,
      hasDraft: false,
      modelMode: 'inherit',
      updatedAt: 1,
    })
    setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({
          agents: [
            agentSummary('builtin.explorer', '探索员'),
            agentSummary('builtin.coder', '编程助手'),
          ],
        }),
        'agent.delegationTargets': () => ({ enabled: true, agentIds: ['builtin.explorer'] }),
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '看 @探')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('探索员')
    expect(within(list).queryByText('编程助手')).toBeNull()

    // 委派关闭时一个 Agent 都不建议。
    cleanup()
    setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents: [agentSummary('builtin.explorer', '探索员')] }),
        'agent.delegationTargets': () => ({ enabled: false, agentIds: [] }),
      },
    )
    const next = await screen.findByPlaceholderText('有什么可以帮你？')
    await userEvent.type(next, '看 @探')
    await screen.findByRole('listbox', { name: '引用文件' })
    expect(screen.queryByText('探索员')).toBeNull()
  })

  it('completes a dismissed skill name instead of sending it', async () => {
    const { request } = setup({}, { sessionId: 's1' }, { skills: [skill('review')] })
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await waitFor(() => expect(request).toHaveBeenCalledWith('skill.list', { projectId: 'p1' }))
    await user.type(input, '/review')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
    await user.keyboard('{Enter}')
    expect(input.value).toBe('/review ')
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
  })

  it('closes the command panel with Escape and an outside click', async () => {
    setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '/')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()

    await user.clear(input)
    await user.type(input, '/p')
    await screen.findByRole('listbox', { name: '输入指令' })
    // 非 DOM 节点上的 pointerdown 不影响面板。
    fireEvent.pointerDown(window)
    expect(screen.getByRole('listbox', { name: '输入指令' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox', { name: '输入指令' })).toBeNull()
  })

  it('keeps unmatched drafts ordinary and toggles plan after the panel is dismissed', async () => {
    setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    // 没有匹配项时方向键与 Tab 不拦，面板保持打开。
    await user.type(input, '/zzz')
    const list = await screen.findByRole('listbox', { name: '输入指令' })
    expect(within(list).getByText('没有匹配的指令')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('/zzz')
    expect(screen.getByRole('listbox', { name: '输入指令' })).toBeTruthy()
    // 点在输入框里不算离开面板。
    fireEvent.pointerDown(input)
    expect(screen.getByRole('listbox', { name: '输入指令' })).toBeTruthy()

    // 关掉面板后 `/plan` 单独发送只切换计划模式。
    await user.clear(input)
    await user.type(input, '/plan')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.keyDown(input, { key: 'Escape' })
    await user.keyboard('{Enter}')
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: '退出计划模式' })).toBeTruthy()
  })

  it('inserts a dragged file as a highlighted @ mention and sends it', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await user.type(input, '看 ')
    const dataTransfer = {
      types: [FILE_DRAG_TYPE],
      getData: (type: string) =>
        type === FILE_DRAG_TYPE ? JSON.stringify({ path: 'src/a.ts', kind: 'file' }) : '',
      dropEffect: 'none',
    }
    fireEvent.dragOver(input, { dataTransfer })
    const card = input.parentElement!.parentElement!
    expect(card.className).toContain('ring-2')
    fireEvent.dragLeave(card, { relatedTarget: document.body })
    expect(card.className).not.toContain('ring-2')
    // 不是本应用拖来的内容不高亮。
    fireEvent.dragOver(input, { dataTransfer: { ...dataTransfer, types: ['text/plain'] } })
    expect(card.className).not.toContain('ring-2')
    fireEvent.dragOver(input, { dataTransfer })
    fireEvent.drop(input, { dataTransfer })
    expect(input.value).toBe('看 @src/a.ts ')
    expect(document.querySelector('[data-token="mention"]')?.textContent).toBe('@src/a.ts')

    // 非本应用的文件拖入时不动草稿。
    fireEvent.drop(input, { dataTransfer: { ...dataTransfer, getData: () => '' } })
    expect(input.value).toBe('看 @src/a.ts ')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '看 @src/a.ts' }],
        mentions: [{ path: 'src/a.ts' }],
      }),
    )
  })
})

describe('NewSession controls', () => {
  it('suggests files of the selected project after @ and sends them as mentions', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await screen.findAllByText('work')
    await user.type(input, '看 @boom')
    expect(await screen.findByText('没有匹配的文件或文件夹')).toBeTruthy()
    await user.clear(input)
    await user.type(input, '看 @a')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('a.ts')
    expect(request).toHaveBeenCalledWith('fs.search', { projectId: 'p1', query: 'a', limit: 50 })
    await user.keyboard('{Enter}')
    expect(input.value).toBe('看 @src/a.ts ')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '看 @src/a.ts' }],
        mentions: [{ path: 'src/a.ts' }],
      }),
    )
  })

  it('creates the session, switches the model, then sends the first prompt in plan mode', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 快' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '模型：测试供应商 · 快' }))
    await user.click(await screen.findByRole('menuitem', { name: /强/ }))
    await user.type(input, '/plan{Enter}')
    expect(input.getAttribute('placeholder')).toBe('描述要做的事。这一轮只会阅读项目并提出计划')
    expect(screen.getByRole('button', { name: '退出计划模式' })).toBeTruthy()
    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '做点事' }],
        mode: 'plan',
      }),
    )
    const calls = request.mock.calls
      .map(([method]) => method)
      .filter((method) =>
        ['session.create', 'session.setModel', 'session.prompt'].includes(method as string),
      )
    expect(calls).toEqual(['session.create', 'session.setModel', 'session.prompt'])
    expect(request).toHaveBeenCalledWith('session.setModel', {
      sessionId: 's1',
      model: { providerId: 'fake', modelId: 'strong' },
    })
  })

  it('sends /plan with a task in plan mode and toggles plan mode with the shortcut', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await screen.findByRole('button', { name: '模型：测试供应商 · 快' })
    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: '退出计划模式' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '退出计划模式' }))
    expect(screen.queryByRole('button', { name: '退出计划模式' })).toBeNull()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    dialog.remove()
    expect(screen.queryByRole('button', { name: '退出计划模式' })).toBeNull()

    await user.type(input, '/plan 整理目录{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '整理目录' }],
        mode: 'plan',
      }),
    )
  })

  it('keeps the default model when it is already selected and switches the permission mode', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await user.click(await screen.findByRole('menuitem', { name: /只读/ }))
    expect(request).toHaveBeenCalledWith('settings.update', { permissionMode: 'read-only' })

    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '做点事' }],
      }),
    )
    expect(request).not.toHaveBeenCalledWith('session.setModel', expect.anything())
  })

  it('disables sending when no enabled model is available', async () => {
    setup({
      providers: [
        {
          ...providers[0],
          models: providers[0]!.models.map((model) => ({ ...model, enabled: false })),
        },
      ],
    })
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '做点事')
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('sends with Enter but leaves Shift+Enter to the textarea', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())

    await user.type(input, '开始做{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '开始做' }],
      }),
    )
  })

  it('stays on the page when session creation fails', async () => {
    const { request } = setup({}, null)
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.create', {
        projectPath: '/work',
        title: '做点事',
      }),
    )
    expect(request).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not create a session for an empty draft and keeps an initial project path', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'settings.get') {
        return { locale: 'zh-CN', providers, defaultModel: { providerId: 'fake', modelId: 'fast' } }
      }
      if (method === 'project.list') return { projects: [] }
      return {}
    })
    const store = createSessionStore({
      ready: () => Promise.resolve(),
      request,
      on: () => () => {},
    } as unknown as MainApi)
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <SessionStoreProvider store={store}>
          <NewSession initialProjectPath="/preset" onDone={() => {}} />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    expect(await screen.findByRole('button', { name: '工作空间：preset' })).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
  })

  it('updates the selected project after choosing a folder', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    await screen.findByPlaceholderText('有什么可以帮你？')
    await user.click(screen.getByRole('button', { name: '工作空间：work' }))
    await user.click(await screen.findByRole('menuitem', { name: '选择文件夹…' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('project.open', {}))
  })
})
