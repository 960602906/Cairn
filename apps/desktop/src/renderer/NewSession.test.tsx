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
import { readNewSessionTeam, writeNewSessionTeam } from './composer-drafts.js'

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

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

const agentFixture = (agentId: string, name: string, extra: object = {}) => ({
  agentId,
  name: { 'zh-CN': name },
  description: {},
  source: 'builtin',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
  ...extra,
})

/** 计划模式开启时，权限 / 计划合并菜单的读屏名称会带上「计划模式已开启」。 */
const planOn = () => screen.queryByRole('button', { name: /计划模式已开启/ }) !== null

const teamFixture = (teamId: string, name: string, extra: object = {}) => ({
  teamId,
  name: { 'zh-CN': name },
  description: {},
  pattern: 'delegate',
  coordinator: 'builtin.coder',
  memberCount: 2,
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  updatedAt: 1,
  ...extra,
})

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
  // 附件保存走 window.cairn（preload 桥）；测试里把同一组 handler 挂回去。
  ;(window as { cairn?: unknown }).cairn = {
    request: async (method: string, params: unknown) => ({
      ok: true,
      result: await request(method, params),
    }),
    filePaths: {
      fromFile: (file: File) => (file as File & { path?: string }).path,
    },
  }
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
    // 技能说明只占一行，放不下时截断，完整内容留在 title 里。
    const skillDescription = within(list).getByText('review 的说明')
    expect(skillDescription.className).toContain('truncate')
    expect(skillDescription.getAttribute('title')).toBe('review 的说明')

    // 输入法组字时的方向键属于候选词操作，不移动面板选择。
    const initialActive = input.getAttribute('aria-activedescendant')
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })
    expect(input.getAttribute('aria-activedescendant')).toBe(initialActive)

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
    expect(planOn()).toBe(true)
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

  it('follows the selected team or agent when suggesting @agents', async () => {
    const agents = [
      agentFixture('builtin.coder', '编程助手'),
      agentFixture('builtin.explorer', '探索员'),
      agentFixture('user.checker', '审查员'),
    ]
    const { request } = setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents }),
        'team.list': () => ({ teams: [teamFixture('user.team-1', '日常协作')] }),
        'agent.delegationTargets': (params) => {
          const selection = params as { teamId?: string; agent?: { id: string } }
          // 团队主控与选中的探索员各自允许审查员；默认 Agent 只允许探索员。
          return selection.teamId === 'user.team-1' || selection.agent?.id === 'builtin.explorer'
            ? { enabled: true, agentIds: ['user.checker'] }
            : { enabled: true, agentIds: ['builtin.explorer'] }
        },
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    const picker = await screen.findByRole('listbox', { name: '选择 Agent 或团队' })
    await user.click(within(picker).getByText('日常协作'))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('agent.delegationTargets', {
        teamId: 'user.team-1',
      }),
    )
    await user.type(input, '请 @审')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('审查员')
    expect(within(list).queryByText('探索员')).toBeNull()
    await user.keyboard('{Escape}')

    // 改选单个 Agent：候选跟着它的委派名单走。
    await user.click(screen.getByRole('button', { name: '切换团队：日常协作' }))
    const again = await screen.findByRole('listbox', { name: '选择 Agent 或团队' })
    await user.click(within(again).getByText('探索员'))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('agent.delegationTargets', {
        agent: { id: 'builtin.explorer', version: 1 },
      }),
    )
    expect(screen.getByRole('button', { name: '切换 Agent：探索员' })).toBeTruthy()
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
    expect(planOn()).toBe(true)
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

  it('inserts a file dropped from the operating system as a workspace-relative mention', async () => {
    setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await user.type(input, '看 ')
    ;(window as { cairn?: unknown }).cairn = {
      windowControls: { platform: 'darwin' },
      filePaths: { fromFile: (file: unknown) => (file as { path?: string }).path ?? '' },
    }
    const external = {
      types: ['Files'],
      items: [
        {
          kind: 'file',
          getAsFile: () => ({ path: '/work/docs/a.md' }),
          webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
        },
        {
          kind: 'file',
          getAsFile: () => ({ path: '/work/src' }),
          webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
        },
      ],
      files: [],
      getData: () => '',
      dropEffect: 'none',
    }
    fireEvent.drop(input, { dataTransfer: external })
    expect(input.value).toBe('看 @docs/a.md @src/ ')
  })
})

describe('NewSession 附件（ADR-0052）', () => {
  it('粘贴没有路径的文件：保存为附件并显示，发送时随输入带上', async () => {
    const { request } = setup(
      {},
      { sessionId: 's1' },
      {},
      {
        'attachment.save': () => ({
          blobRef: 'b1',
          kind: 'file',
          name: '报告.pdf',
          mimeType: 'application/pdf',
          size: 2048,
        }),
      },
    )
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File([new Uint8Array([1, 2, 3])], '报告.pdf', { type: 'application/pdf' })],
        items: [],
        getData: () => '',
      },
    })
    expect(await screen.findByText('报告.pdf')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [
          {
            type: 'file',
            blobRef: 'b1',
            name: '报告.pdf',
            mimeType: 'application/pdf',
            size: 2048,
          },
        ],
      }),
    )
    expect(request).toHaveBeenCalledWith('session.create', {
      projectPath: '/work',
      title: undefined,
    })
  })

  it('粘贴截图：显示缩略图，移除后可以空手发送', async () => {
    const { request } = setup(
      {},
      { sessionId: 's1' },
      {},
      {
        'attachment.save': () => ({
          blobRef: 'b2',
          kind: 'image',
          name: '截图.png',
          mimeType: 'image/png',
          size: 8,
        }),
      },
    )
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File([new Uint8Array([137, 80, 78, 71])], '截图.png', { type: 'image/png' })],
        items: [],
        getData: () => '',
      },
    })
    await screen.findByAltText('截图.png')
    fireEvent.click(screen.getByLabelText('移除附件'))
    expect(screen.queryByAltText('截图.png')).toBeNull()
    // 附件和文字都没有时发送按钮禁用，不会创建空会话。
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
  })

  it('拖入文件：有路径的走 @ 引用，没有路径的存成附件', async () => {
    const { request } = setup(
      {},
      { sessionId: 's1' },
      {},
      {
        'attachment.save': () => ({
          blobRef: 'b3',
          kind: 'file',
          name: '笔记.md',
          mimeType: 'text/markdown',
          size: 10,
        }),
      },
    )
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    const fromPath = { path: '/work/a.txt', type: 'text/plain' } as unknown as File
    fireEvent.drop(input, {
      dataTransfer: {
        types: ['Files'],
        files: [fromPath],
        getData: () => '',
      },
    })
    await waitFor(() => expect(input.value).toContain('a.txt'))
    expect(request).not.toHaveBeenCalledWith('attachment.save', expect.anything(), undefined)

    fireEvent.drop(input, {
      dataTransfer: {
        types: ['Files'],
        files: [new File([new Uint8Array([1, 2])], '笔记.md', { type: 'text/markdown' })],
        getData: () => '',
      },
    })
    expect(await screen.findByText('笔记.md')).toBeTruthy()
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

  it('keeps the active @ mention in view while navigating with the keyboard', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    setup({}, undefined, undefined, {
      'fs.search': () => ({
        entries: [
          { path: 'src/a.ts', kind: 'file' },
          { path: 'src/b.ts', kind: 'file' },
        ],
        truncated: false,
      }),
    })
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '看 @a')
    const list = await screen.findByRole('listbox', { name: '引用文件' })
    await within(list).findByText('b.ts')
    scrollIntoView.mockClear()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(
      within(list)
        .getAllByRole('option')
        .find((option) => option.getAttribute('aria-selected') === 'true'),
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
    expect(planOn()).toBe(true)
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
    expect(planOn()).toBe(true)
    await user.click(screen.getByRole('button', { name: /计划模式已开启/ }))
    await user.click(await screen.findByRole('menuitem', { name: /计划模式/ }))
    expect(planOn()).toBe(false)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    dialog.remove()
    expect(planOn()).toBe(false)

    await user.type(input, '/plan 整理目录{Enter}')
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '整理目录' }],
        mode: 'plan',
      }),
    )
  })

  it('returns focus to the input after picking a model or mode', async () => {
    setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await user.click(screen.getByRole('button', { name: '模型：测试供应商 · 快' }))
    await user.click(await screen.findByRole('menuitem', { name: /强/ }))
    await waitFor(() => expect(document.activeElement).toBe(input))

    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await user.click(await screen.findByRole('menuitem', { name: /计划模式/ }))
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(planOn()).toBe(true)
  })

  it('toggles plan mode with the shortcut while the mention list is open', async () => {
    setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents: [agentFixture('builtin.explorer', '探索员')] }),
        'agent.delegationTargets': () => ({ enabled: true, agentIds: ['builtin.explorer'] }),
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '看看 @探')
    await screen.findByRole('listbox', { name: '引用文件' })
    fireEvent.keyDown(input, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(planOn()).toBe(true)
  })

  it('keeps the draft and plan mode when the page remounts', async () => {
    setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '这段还没发出')
    fireEvent.keyDown(document.body, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(planOn()).toBe(true)

    // 打开设置再回来时新对话页整体重新挂载。
    cleanup()
    setup()
    const again = (await screen.findByPlaceholderText(
      '描述要做的事。这一轮只会阅读项目并提出计划',
    )) as HTMLTextAreaElement
    expect(again.value).toBe('这段还没发出')
  })

  it('remembers each workspace model and the last workspace', async () => {
    const projects = [
      { projectId: 'p1', name: 'work', path: '/work', createdAt: 1 },
      { projectId: 'p2', name: 'side', path: '/side', createdAt: 2 },
    ]
    const listProjects = { 'project.list': () => ({ projects }) }
    setup({}, undefined, undefined, listProjects)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 快' })).toBeTruthy()

    // 在 work 里换成强模型。
    await user.click(screen.getByRole('button', { name: '模型：测试供应商 · 快' }))
    await user.click(await screen.findByRole('menuitem', { name: /强/ }))
    expect(screen.getByRole('button', { name: '模型：测试供应商 · 强' })).toBeTruthy()

    // 另一个工作空间仍用默认模型。
    await user.click(screen.getByRole('button', { name: '工作空间：work' }))
    await user.click(await screen.findByRole('menuitem', { name: 'side' }))
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 快' })).toBeTruthy()

    // 切回 work 时恢复它自己的选择。
    await user.click(screen.getByRole('button', { name: '工作空间：side' }))
    await user.click(await screen.findByRole('menuitem', { name: 'work' }))
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 强' })).toBeTruthy()

    // 重新进入页面：回到上次的工作空间，模型也在。
    cleanup()
    setup({}, undefined, undefined, listProjects)
    expect(await screen.findByRole('button', { name: '工作空间：work' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 强' })).toBeTruthy()
  })

  it('applies the selected agent when the session is created', async () => {
    const agents = [
      agentFixture('builtin.coder', '编程助手'),
      agentFixture('builtin.reviewer', '代码审查员', {
        version: 2,
        description: { 'zh-CN': '审查改动的正确性' },
      }),
      agentFixture('user.draft', '草稿', { source: 'user', status: 'draft', version: 0 }),
      agentFixture('user.old', '旧助手', { source: 'user', archived: true }),
    ]
    const { request } = setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents }),
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    const list = await screen.findByRole('listbox', { name: '选择 Agent' })
    expect(within(list).getByText('审查改动的正确性')).toBeTruthy()
    // 草稿与已归档的不出现在可选列表里。
    expect(within(list).queryByText('草稿')).toBeNull()
    expect(within(list).queryByText('旧助手')).toBeNull()
    await user.click(within(list).getByText('代码审查员'))
    expect(screen.getByRole('button', { name: '切换 Agent：代码审查员' })).toBeTruthy()

    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.setAgent', {
        sessionId: 's1',
        agent: { id: 'builtin.reviewer', version: 2 },
      }),
    )
    const calls = request.mock.calls
      .map(([method]) => method)
      .filter((method) =>
        ['session.create', 'session.setAgent', 'session.prompt'].includes(method as string),
      )
    expect(calls).toEqual(['session.create', 'session.setAgent', 'session.prompt'])
  })

  it('applies the selected team when the session is created', async () => {
    const agents = [
      agentFixture('builtin.coder', '编程助手'),
      agentFixture('builtin.reviewer', '代码审查员'),
    ]
    const teams = [
      teamFixture('user.team-1', '日常协作'),
      teamFixture('user.team-draft', '草稿团队', { status: 'draft', version: 0 }),
    ]
    const { request } = setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents }),
        'team.list': () => ({ teams }),
      },
    )
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    const list = await screen.findByRole('listbox', { name: '选择 Agent 或团队' })
    // 没有发布版本的团队不能选。
    expect(within(list).queryByText('草稿团队')).toBeNull()
    await user.click(within(list).getByText('日常协作'))
    expect(screen.getByRole('button', { name: '切换团队：日常协作' })).toBeTruthy()

    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.setTeam', {
        sessionId: 's1',
        teamId: 'user.team-1',
      }),
    )
    expect(request).not.toHaveBeenCalledWith('session.setAgent', expect.anything())
    const calls = request.mock.calls
      .map(([method]) => method)
      .filter((method) =>
        ['session.create', 'session.setTeam', 'session.setAgent', 'session.prompt'].includes(
          method as string,
        ),
      )
    expect(calls).toEqual(['session.create', 'session.setTeam', 'session.prompt'])
  })

  it('uses the coordinator fixed model for a selected team', async () => {
    const agents = [
      agentFixture('builtin.coder', '编程助手'),
      agentFixture('user.fixed', '固定模型助手', {
        source: 'user',
        modelMode: 'fixed',
        model: { providerId: 'fake', modelId: 'strong' },
      }),
    ]
    const teams = [teamFixture('user.team-1', '日常协作', { coordinator: 'user.fixed' })]
    setup({}, undefined, undefined, {
      'agent.list': () => ({ agents }),
      'team.list': () => ({ teams }),
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    await user.click(await screen.findByRole('option', { name: /日常协作/ }))
    expect(screen.getByRole('button', { name: '切换团队：日常协作' })).toBeTruthy()
    const model = screen.getByRole('button', { name: '模型：测试供应商 · 强' })
    expect((model as HTMLButtonElement).disabled).toBe(true)
  })

  it('remembers the selected team per workspace', async () => {
    const projects = [
      { projectId: 'p1', name: 'work', path: '/work', createdAt: 1 },
      { projectId: 'p2', name: 'side', path: '/side', createdAt: 2 },
    ]
    const teams = [teamFixture('user.team-1', '日常协作')]
    const agents = [agentFixture('builtin.coder', '编程助手')]
    const handlers = {
      'project.list': () => ({ projects }),
      'agent.list': () => ({ agents }),
      'team.list': () => ({ teams }),
    }
    setup({}, undefined, undefined, handlers)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: '工作空间：work' })).toBeTruthy()

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    await user.click(await screen.findByRole('option', { name: /日常协作/ }))
    expect(screen.getByRole('button', { name: '切换团队：日常协作' })).toBeTruthy()

    // 另一个工作空间仍用默认 Agent。
    await user.click(screen.getByRole('button', { name: '工作空间：work' }))
    await user.click(await screen.findByRole('menuitem', { name: 'side' }))
    expect(await screen.findByRole('button', { name: '切换 Agent：编程助手' })).toBeTruthy()

    // 切回 work 时恢复它自己的团队。
    await user.click(screen.getByRole('button', { name: '工作空间：side' }))
    await user.click(await screen.findByRole('menuitem', { name: 'work' }))
    expect(await screen.findByRole('button', { name: '切换团队：日常协作' })).toBeTruthy()

    // 重新进入页面：回到上次的工作空间，团队也在。
    cleanup()
    setup({}, undefined, undefined, handlers)
    expect(await screen.findByRole('button', { name: '切换团队：日常协作' })).toBeTruthy()
  })

  it('drops a remembered team that is no longer available', async () => {
    writeNewSessionTeam('/work', 'user.team-gone')
    const { request } = setup(
      {},
      { sessionId: 's1' },
      { skills: [] },
      {
        'agent.list': () => ({ agents: [agentFixture('builtin.coder', '编程助手')] }),
        'team.list': () => ({ teams: [] }),
      },
    )
    // 模板列表读回来后清掉记录，输入框回到默认 Agent。
    await waitFor(() => expect(readNewSessionTeam('/work')).toBeUndefined())
    expect(screen.getByRole('button', { name: '切换 Agent：编程助手' })).toBeTruthy()

    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('session.prompt', expect.anything()))
    expect(request).not.toHaveBeenCalledWith('session.setTeam', expect.anything())
  })

  it('opens Agents settings from the new-session picker', async () => {
    const agents = [agentFixture('builtin.coder', '编程助手')]
    setup({}, undefined, undefined, { 'agent.list': () => ({ agents }) })
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    await user.click(await screen.findByRole('button', { name: '管理 Agents' }))
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy()
  })

  it('opens Teams settings from the new-session picker', async () => {
    const agents = [agentFixture('builtin.coder', '编程助手')]
    setup({}, undefined, undefined, {
      'agent.list': () => ({ agents }),
      'team.list': () => ({ teams: [] }),
    })
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    await user.click(await screen.findByRole('button', { name: '管理团队' }))
    expect(await screen.findByRole('heading', { name: '团队模板' })).toBeTruthy()
  })

  it('remembers the selected agent per workspace', async () => {
    const projects = [
      { projectId: 'p1', name: 'work', path: '/work', createdAt: 1 },
      { projectId: 'p2', name: 'side', path: '/side', createdAt: 2 },
    ]
    const agents = [
      agentFixture('builtin.coder', '编程助手'),
      agentFixture('builtin.reviewer', '代码审查员'),
    ]
    const handlers = {
      'project.list': () => ({ projects }),
      'agent.list': () => ({ agents }),
    }
    setup({}, undefined, undefined, handlers)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: '工作空间：work' })).toBeTruthy()

    // 在 work 里换成代码审查员。
    await user.click(await screen.findByRole('button', { name: '切换 Agent：编程助手' }))
    await user.click(await screen.findByRole('option', { name: /代码审查员/ }))
    expect(screen.getByRole('button', { name: '切换 Agent：代码审查员' })).toBeTruthy()

    // 另一个工作空间仍用默认 Agent。
    await user.click(screen.getByRole('button', { name: '工作空间：work' }))
    await user.click(await screen.findByRole('menuitem', { name: 'side' }))
    expect(await screen.findByRole('button', { name: '切换 Agent：编程助手' })).toBeTruthy()

    // 切回 work 时恢复它自己的选择。
    await user.click(screen.getByRole('button', { name: '工作空间：side' }))
    await user.click(await screen.findByRole('menuitem', { name: 'work' }))
    expect(await screen.findByRole('button', { name: '切换 Agent：代码审查员' })).toBeTruthy()

    // 重新进入页面：回到上次的工作空间，Agent 也在。
    cleanup()
    setup({}, undefined, undefined, handlers)
    expect(await screen.findByRole('button', { name: '工作空间：work' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: '切换 Agent：代码审查员' })).toBeTruthy()
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

  it('recognizes /goal but asks to create a session first', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = (await screen.findByPlaceholderText('有什么可以帮你？')) as HTMLTextAreaElement
    await user.type(input, '/goal 测试通过')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/先发送一条消息创建会话/)).toBeTruthy()
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything())
    expect(input.value).toBe('/goal 测试通过')
  })
})
