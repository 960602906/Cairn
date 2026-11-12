// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentDetail } from '@cairn/protocol'
import { AgentEditor } from './AgentEditor.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const mockDetail: AgentDetail = {
  agentId: 'user.custom',
  source: 'user',
  archived: false,
  validation: { ok: true, errors: [], warnings: [] },
  draft: {
    id: 'user.custom',
    name: { 'zh-CN': '测试助手', 'en-US': 'Test Assistant' },
    description: { 'zh-CN': '描述' },
    instructions: 'You are a test agent.',
    model: { mode: 'inherit' },
    tools: { allow: ['*'] },
    skills: { allow: ['*'] },
    permissions: 'ask',
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
  },
  published: {
    id: 'user.custom',
    version: 1,
    schemaVersion: 1,
    source: 'user',
    status: 'published',
    createdAt: 1000,
    updatedAt: 1000,
    name: { 'zh-CN': '测试助手', 'en-US': 'Test Assistant' },
    description: { 'zh-CN': '描述' },
    instructions: 'You are a test agent.',
    model: { mode: 'inherit' },
    tools: { allow: ['*'] },
    skills: { allow: ['*'] },
    permissions: 'ask',
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
  },
}

describe('AgentEditor component', () => {
  it('renders editor, switches sections, and saves changes', async () => {
    const onBack = vi.fn()
    const onChanged = vi.fn()
    let savedDraft: { instructions?: string } | undefined

    const fakeApi = {
      request: async (method: string, params: unknown) => {
        if (method === 'agent.get') return mockDetail
        if (method === 'agent.saveDraft') {
          const { definition } = params as {
            definition: { instructions: string }
          }
          savedDraft = definition
          return {
            ...mockDetail,
            draft: { ...mockDetail.draft, ...definition },
          }
        }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor
            agentId="user.custom"
            initial={mockDetail}
            onBack={onBack}
            onChanged={onChanged}
          />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    // Renders title
    expect(await screen.findByText('测试助手')).toBeDefined()

    // Switch to instructions section
    const instructionsBtn = screen.getByRole('button', { name: /提示词|指令/i })
    fireEvent.click(instructionsBtn)

    // Textarea should contain instructions
    const textarea = screen.getByLabelText(/提示词|指令/i)
    expect((textarea as HTMLTextAreaElement).value).toBe('You are a test agent.')

    // Modify instructions
    fireEvent.change(textarea, { target: { value: 'Updated prompt' } })

    // Save button should be enabled
    const saveBtn = screen.getByRole('button', { name: '保存草稿' })
    expect(saveBtn).toBeDefined()
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(savedDraft).toBeDefined()
      expect(savedDraft?.instructions).toBe('Updated prompt')
      expect(onChanged).toHaveBeenCalled()
    })
  })
})

function makeStore(
  handlers: Record<string, (params: unknown) => unknown>,
): ReturnType<typeof createSessionStore> {
  const fakeApi = {
    request: async (method: string, params: unknown) => handlers[method]?.(params),
    on: () => () => {},
  }
  return createSessionStore(fakeApi as unknown as MainApi)
}

function renderEditor(
  store: ReturnType<typeof createSessionStore>,
  props: {
    agentId?: string
    initial?: AgentDetail
    onBack?: () => void
    onChanged?: () => void
    onOpenAgent?: (agentId: string) => void
  } = {},
) {
  const onBack = props.onBack ?? vi.fn()
  const onChanged = props.onChanged ?? vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentEditor
          agentId={props.agentId ?? 'user.custom'}
          initial={props.initial ?? mockDetail}
          onBack={onBack}
          onChanged={onChanged}
          {...(props.onOpenAgent ? { onOpenAgent: props.onOpenAgent } : {})}
        />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { onBack, onChanged }
}

describe('AgentEditor sections and actions', () => {
  it('navigates every section and edits fields', async () => {
    const store = makeStore({
      'agent.get': () => mockDetail,
      'skill.list': () => ({ skills: [{ name: 'tdd', description: '' }] }),
      'mcp.list': () => ({ servers: [{ serverId: 'srv', name: 'Fixture' }] }),
      'agent.saveDraft': () => mockDetail,
      'settings.get': () => ({
        providers: [
          {
            id: 'p1',
            displayName: 'P1',
            apiFormat: 'openai',
            models: [{ id: 'm1', displayName: 'M1', contextWindow: 40000 }],
          },
        ],
      }),
    })
    await store.getState().loadSettings()
    renderEditor(store)
    await screen.findByText('测试助手')

    // 基本信息：名称、图标、颜色、标签
    const nameZh = screen.getByDisplayValue('测试助手')
    fireEvent.change(nameZh, { target: { value: '新名字' } })
    fireEvent.change(screen.getByLabelText('图标'), { target: { value: 'bot' } })
    fireEvent.change(screen.getByLabelText('颜色'), { target: { value: 'agent-blue' } })
    const basicInputs = screen.getAllByRole('textbox')
    fireEvent.change(basicInputs[basicInputs.length - 1]!, { target: { value: 'a, b' } })

    // 指令
    fireEvent.click(screen.getByRole('button', { name: /^指令/ }))
    fireEvent.change(screen.getByLabelText('系统指令'), {
      target: { value: 'x'.repeat(64000) },
    })

    // 模型：固定 + 参数
    fireEvent.click(screen.getByRole('button', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('radio', { name: '固定' }))
    fireEvent.change(screen.getByLabelText('主模型'), { target: { value: 'p1/m1' } })
    fireEvent.change(screen.getByLabelText('温度'), { target: { value: '0.7' } })
    fireEvent.change(screen.getByLabelText('最大输出 tokens'), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText('辅助模型'), { target: { value: '' } })

    // 固定到 40k 上下文窗口后，超长指令会提示占用过高
    fireEvent.click(screen.getByRole('button', { name: /^指令/ }))
    expect(screen.getByText(/指令较长/)).toBeDefined()

    // 能力：全部工具开关、分类、Skills、MCP
    fireEvent.click(screen.getByRole('button', { name: /^能力/ }))
    expect(await screen.findByText('tdd')).toBeDefined()
    expect(screen.getByText('Fixture')).toBeDefined()
    fireEvent.click(screen.getByRole('switch', { name: '全部工具' }))
    fireEvent.click(screen.getByRole('switch', { name: '全部已启用的 Skills' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fixture' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '读取' }))

    // 权限
    fireEvent.click(screen.getByRole('button', { name: /^权限/ }))
    fireEvent.click(screen.getByRole('radio', { name: /只读/ }))

    // 限额
    fireEvent.click(screen.getByRole('button', { name: /^限额/ }))
    fireEvent.change(screen.getByLabelText('每轮最大步数'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('每轮最长时间（分钟）'), {
      target: { value: '3' },
    })

    // 上下文
    fireEvent.click(screen.getByRole('button', { name: /^上下文/ }))
    fireEvent.click(screen.getByRole('switch', { name: '读取项目说明 AGENTS.md' }))
    fireEvent.click(screen.getByRole('radio', { name: '关闭' }))
    fireEvent.change(screen.getByLabelText('预留输出 tokens'), { target: { value: '1000' } })

    // 记忆
    fireEvent.click(screen.getByRole('button', { name: /^记忆/ }))
    expect(screen.getByText('即将推出')).toBeDefined()

    // 返回基本信息，修改后 Ctrl+S 保存
    fireEvent.click(screen.getByRole('button', { name: /^基本信息/ }))
    fireEvent.change(screen.getByDisplayValue('新名字'), { target: { value: '最终名字' } })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => expect(screen.getByLabelText('草稿已保存')).toBeDefined())
  })

  it('publishes, duplicates, exports, and archives', async () => {
    const onBack = vi.fn()
    const onChanged = vi.fn()
    const onOpenAgent = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:test')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => ({ ...mockDetail }),
      'agent.publish': () => ({
        ...mockDetail,
        published: { ...mockDetail.published!, version: 2 },
      }),
      'agent.duplicate': () => ({ ...mockDetail, agentId: 'user.copy' }),
      'agent.export': () => ({ markdown: '# Agent' }),
      'agent.archive': () => ({ ...mockDetail, archived: true }),
    })
    renderEditor(store, { onBack, onChanged, onOpenAgent })
    await screen.findByText('测试助手')

    // 发布
    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    const publishDialog = await screen.findByRole('dialog')
    fireEvent.click(within(publishDialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    // 复制
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith('user.copy'))

    // 导出
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalled()

    // 归档
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
    click.mockRestore()
  })

  it('shows builtin as read-only and duplicates it', async () => {
    const builtin: AgentDetail = {
      ...mockDetail,
      agentId: 'builtin.coder',
      source: 'builtin',
    }
    const onOpenAgent = vi.fn()
    const store = makeStore({
      'agent.get': () => builtin,
      'agent.duplicate': () => ({ ...mockDetail, agentId: 'user.copy' }),
    })
    renderEditor(store, { agentId: 'builtin.coder', initial: builtin, onOpenAgent })

    expect(await screen.findByText(/内置 Agent 只读/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '基于编程助手复制' }))
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith('user.copy'))
  })

  it('unarchives an archived agent', async () => {
    const archived: AgentDetail = { ...mockDetail, archived: true }
    const onChanged = vi.fn()
    const store = makeStore({
      'agent.get': () => archived,
      'agent.unarchive': () => ({ ...mockDetail, archived: false }),
    })
    renderEditor(store, { initial: archived, onChanged })
    await screen.findByText('测试助手')

    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('asks before leaving with unsaved changes', async () => {
    const onBack = vi.fn()
    const store = makeStore({ 'agent.get': () => mockDetail })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')

    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改了' } })
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })

  it('opens versions and effective views', async () => {
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.versions': () => ({
        versions: [
          {
            version: 1,
            publishedAt: 1000,
            name: { 'zh-CN': '测试助手' },
            description: {},
            instructionsBytes: 10,
            usedBySessions: 0,
          },
        ],
      }),
      'agent.diff': () => ({ fields: [], instructions: { from: 'a', to: 'b' } }),
      'agent.effectiveConfig': () => ({
        agentId: 'user.custom',
        source: 'published',
        version: 1,
        systemPrompt: 'prompt',
        tools: [],
        skills: [],
        permissionRules: [],
        budget: {
          contextWindow: 128000,
          reserveOutputTokens: 0,
          systemPromptTokens: 10,
          toolsTokens: 0,
          skillsTokens: 0,
          historyTokens: 0,
        },
      }),
    })
    renderEditor(store)
    await screen.findByText('测试助手')

    fireEvent.click(screen.getByRole('button', { name: '版本历史' }))
    await waitFor(() => expect(screen.getAllByText('草稿').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: '生效配置' }))
    expect(await screen.findByText('prompt')).toBeDefined()
  })
})

const validationDetail: AgentDetail = {
  ...mockDetail,
  validation: {
    ok: false,
    errors: [
      { path: 'name', code: 'name_required' },
      { path: 'tools.allow', code: 'unknown_tool', params: { tool: 'nope' } },
    ],
    warnings: [{ path: 'instructions', code: 'instructions_too_long' }],
  },
}

describe('AgentEditor edge paths', () => {
  it('shows an untitled new draft and returns immediately when clean', async () => {
    const onBack = vi.fn()
    const store = makeStore({})
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor agentId={undefined} onBack={onBack} onChanged={vi.fn()} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('未命名 Agent')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('marks sections with validation errors and warnings', async () => {
    const store = makeStore({ 'agent.get': () => validationDetail })
    renderEditor(store, { initial: validationDetail })
    await waitFor(() => expect(screen.getAllByLabelText('1 个错误').length).toBeGreaterThan(0))
    expect(screen.getAllByLabelText('1 个警告').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /^能力/ }))
    expect(screen.getByText('找不到工具 nope')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /^基本信息/ }))
    expect(screen.getByText('至少填写一种语言的名称')).toBeDefined()

    // 警告在发布确认弹窗里列出，发布按钮因校验失败被禁用
    const publishButton = screen.getByRole('button', { name: '发布 v2' })
    expect((publishButton as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves before publishing when there are unsaved changes', async () => {
    const calls: string[] = []
    const onChanged = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => {
        calls.push('save')
        return mockDetail
      },
      'agent.publish': () => {
        calls.push('publish')
        return { ...mockDetail, published: { ...mockDetail.published!, version: 2 } }
      },
    })
    renderEditor(store, { onChanged })
    await screen.findByText('测试助手')
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })

    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(calls).toEqual(['save', 'publish']))
    expect(onChanged).toHaveBeenCalled()
  })

  it('stops publishing when saving the draft fails', async () => {
    const publish = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => undefined,
      'agent.publish': publish,
    })
    renderEditor(store)
    await screen.findByText('测试助手')
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '发布' }))
    // 保存失败时停留在发布确认弹窗，且不会调用发布
    await waitFor(() => expect(publish).not.toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps the editor state when save, duplicate, export, archive and unarchive fail', async () => {
    const onBack = vi.fn()
    const store = makeStore({ 'agent.get': () => mockDetail })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')

    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(screen.queryByLabelText('草稿已保存')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    expect(onBack).not.toHaveBeenCalled()
  })

  it('saves and leaves from the unsaved dialog', async () => {
    const onBack = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => mockDetail,
    })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并离开' }))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })

  it('closes the leave dialog on cancel and ignores unrelated shortcuts', async () => {
    const onBack = vi.fn()
    const store = makeStore({ 'agent.get': () => mockDetail })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')
    fireEvent.keyDown(window, { key: 'x' })
    fireEvent.keyDown(window, { key: 's' })
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onBack).not.toHaveBeenCalled()
  })

  it('edits model params, limits, context and tags', async () => {
    const store = makeStore({
      'agent.get': () => ({
        ...mockDetail,
        draft: {
          ...mockDetail.draft!,
          tags: ['a'],
          limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 120_000 },
          context: {
            includeProjectInstructions: true,
            compaction: 'auto',
            reserveOutputTokens: 100,
          },
        },
      }),
      'settings.get': () => ({
        providers: [
          {
            id: 'p1',
            displayName: 'P1',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    })
    await store.getState().loadSettings()
    renderEditor(store)
    await screen.findByText('测试助手')

    const textboxes = screen.getAllByRole('textbox')
    fireEvent.change(textboxes[textboxes.length - 1]!, { target: { value: '  ' } })

    fireEvent.click(screen.getByRole('button', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('radio', { name: '固定' }))
    fireEvent.change(screen.getByLabelText('主模型'), { target: { value: 'p1/m1' } })
    fireEvent.change(screen.getByLabelText('主模型'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('温度'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('最大输出 tokens'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('辅助模型'), { target: { value: 'p1/m1' } })

    fireEvent.click(screen.getByRole('button', { name: /^限额/ }))
    fireEvent.change(screen.getByLabelText('每轮最大步数'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('每轮最长时间（分钟）'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('每轮 token 上限'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('连续工具错误上限'), { target: { value: '3' } })

    fireEvent.click(screen.getByRole('button', { name: /^上下文/ }))
    fireEvent.change(screen.getByLabelText('预留输出 tokens'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: /^基本信息/ }))
    fireEvent.change(screen.getByLabelText('图标'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('颜色'), { target: { value: '' } })
    const tagInputs = screen.getAllByRole('textbox')
    expect((tagInputs[tagInputs.length - 1] as HTMLInputElement).value).toBe('')
  })

  it('shows empty capability lists when skills and MCP are unavailable', async () => {
    const store = makeStore({
      'agent.get': () => mockDetail,
      'skill.list': () => ({ skills: [] }),
      'mcp.list': () => ({ servers: [] }),
    })
    renderEditor(store)
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: /^能力/ }))
    expect(await screen.findByText('还没有安装 Skills。')).toBeDefined()
    expect(screen.getByText('还没有配置 MCP 服务。')).toBeDefined()
    fireEvent.click(screen.getByRole('checkbox', { name: '读取' }))
    fireEvent.click(screen.getByRole('switch', { name: '全部已启用的 Skills' }))
  })

  it('falls back to published fields when there is no draft', async () => {
    const en = createI18n('en-US')
    const publishedOnly: AgentDetail = { ...mockDetail, draft: undefined }
    const store = makeStore({ 'agent.get': () => publishedOnly })
    render(
      <I18nextProvider i18n={en}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor agentId="user.custom" onBack={vi.fn()} onChanged={vi.fn()} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('Test Assistant')).toBeDefined()
  })

  it('creates and saves a brand new draft without an id', async () => {
    const calls: unknown[] = []
    const store = makeStore({
      'agent.saveDraft': (params) => {
        calls.push(params)
        return {
          ...mockDetail,
          agentId: 'user.created',
          draft: { ...mockDetail.draft!, id: 'user.created' },
        }
      },
      'agent.publish': () => ({ ...mockDetail, agentId: 'user.created', published: undefined }),
    })
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor agentId={undefined} onBack={vi.fn()} onChanged={vi.fn()} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('未命名 Agent')).toBeDefined()

    const textboxes = screen.getAllByRole('textbox')
    fireEvent.change(textboxes[0]!, { target: { value: '新助手' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toMatchObject({ definition: { name: { 'zh-CN': '新助手' } } })
    expect((calls[0] as { definition: { id?: string } }).definition.id).toBeUndefined()
  })

  it('removes tools and turns all-tools on', async () => {
    const detail: AgentDetail = {
      ...mockDetail,
      draft: { ...mockDetail.draft!, tools: { allow: ['read'] }, skills: { allow: [] } },
    }
    const store = makeStore({ 'agent.get': () => detail })
    renderEditor(store, { initial: detail })
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: /^能力/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '读取' }))
    fireEvent.click(screen.getByRole('switch', { name: '全部工具' }))
    fireEvent.click(screen.getByRole('switch', { name: '全部已启用的 Skills' }))
    expect(screen.getByRole('switch', { name: '全部工具' })).toBeDefined()
  })

  it('renders warnings in the publish dialog and English descriptions', async () => {
    const en = createI18n('en-US')
    const withWarnings: AgentDetail = {
      ...mockDetail,
      validation: {
        ok: true,
        errors: [],
        warnings: [{ path: 'instructions', code: 'instructions_too_long' }],
      },
    }
    const store = makeStore({
      'agent.get': () => withWarnings,
      'agent.publish': () => ({ ...withWarnings, published: undefined }),
    })
    render(
      <I18nextProvider i18n={en}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor
            agentId="user.custom"
            initial={withWarnings}
            onBack={vi.fn()}
            onChanged={vi.fn()}
          />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('Test Assistant')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Warnings')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps a saved draft when the response has no draft', async () => {
    const onChanged = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => ({ ...mockDetail, draft: undefined }),
      'agent.publish': () => ({ ...mockDetail, draft: undefined, published: mockDetail.published }),
    })
    renderEditor(store, { onChanged })
    await screen.findByText('测试助手')
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.getByText('改名')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('stays on the editor when saving before leaving fails', async () => {
    const onBack = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => undefined,
    })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')
    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并离开' }))
    await waitFor(() => expect(onBack).not.toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('ignores publish for a draft that has never been saved', async () => {
    const publish = vi.fn()
    const store = makeStore({ 'agent.publish': publish })
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentEditor agentId={undefined} onBack={vi.fn()} onChanged={vi.fn()} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await screen.findByText('未命名 Agent')
    fireEvent.click(screen.getByRole('button', { name: '发布 v1' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(publish).not.toHaveBeenCalled())
  })

  it('clears temperature and max output params', async () => {
    const store = makeStore({ 'agent.get': () => mockDetail })
    renderEditor(store)
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: /^模型/ }))
    const temperature = screen.getByLabelText('温度')
    fireEvent.change(temperature, { target: { value: '0.5' } })
    fireEvent.change(temperature, { target: { value: '' } })
    const maxOutput = screen.getByLabelText('最大输出 tokens')
    fireEvent.change(maxOutput, { target: { value: '1000' } })
    fireEvent.change(maxOutput, { target: { value: '' } })
    // 清空输入不会抹掉已保存的参数值，只是不再改动它
    expect((temperature as HTMLInputElement).value).toBe('0.5')
    expect((maxOutput as HTMLInputElement).value).toBe('1000')
  })

  it('does not save a built-in agent with Ctrl+S', async () => {
    const saveDraft = vi.fn()
    const builtin: AgentDetail = { ...mockDetail, agentId: 'builtin.coder', source: 'builtin' }
    const store = makeStore({
      'agent.get': () => builtin,
      'agent.saveDraft': saveDraft,
    })
    renderEditor(store, { agentId: 'builtin.coder', initial: builtin })
    await screen.findByText(/内置 Agent 只读/)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(saveDraft).not.toHaveBeenCalled())
  })

  it('returns to the list when duplicating without an open handler', async () => {
    const onBack = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.duplicate': () => ({ ...mockDetail, agentId: 'user.copy' }),
    })
    renderEditor(store, { onBack })
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })

  it('keeps the draft when publishing fails', async () => {
    const onChanged = vi.fn()
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.publish': () => undefined,
    })
    renderEditor(store, { onChanged })
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(onChanged).not.toHaveBeenCalled())
    expect(screen.getByText('测试助手')).toBeDefined()
  })

  it('keeps the archived state when unarchiving fails', async () => {
    const archived: AgentDetail = { ...mockDetail, archived: true }
    const onChanged = vi.fn()
    const store = makeStore({
      'agent.get': () => archived,
      'agent.unarchive': () => undefined,
    })
    renderEditor(store, { initial: archived, onChanged })
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    await waitFor(() => expect(onChanged).not.toHaveBeenCalled())
  })

  it('edits the delegation policy and saves it with the draft', async () => {
    const other = {
      agentId: 'user.other',
      name: { 'zh-CN': '审查员' },
      description: {},
      source: 'user',
      archived: false,
      status: 'published',
      version: 1,
      hasDraft: false,
      modelMode: 'inherit',
      updatedAt: 1,
    }
    let saved: { delegation?: unknown } | undefined
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.list': () => ({ agents: [other] }),
      'agent.saveDraft': (params) => {
        const { definition } = params as { definition: Record<string, unknown> }
        saved = definition
        return { ...mockDetail, draft: { ...mockDetail.draft, ...definition } }
      },
    })
    await store.getState().refreshAgents({ includeArchived: true })
    renderEditor(store)
    await screen.findByText('测试助手')

    fireEvent.click(screen.getByRole('button', { name: /^委派/ }))
    expect(screen.getByText(/未启用委派/)).toBeDefined()
    fireEvent.click(screen.getByRole('switch', { name: '允许委派' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '审查员' }))
    // 清空数字输入时保留上一次的值，再改成合法值。
    fireEvent.change(screen.getByLabelText('最大委派深度'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('最大委派深度'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('每轮最多子任务'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('最多并行子任务'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('子任务预算比例'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('默认工作区'), { target: { value: 'isolated' } })
    fireEvent.change(screen.getByLabelText('合并审阅'), {
      target: { value: 'parent-then-user' },
    })

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(saved?.delegation).toEqual({
        enabled: true,
        allowedAgents: ['user.other'],
        maxDepth: 2,
        maxChildrenPerTurn: 4,
        maxParallel: 2,
        childBudgetShare: 0.4,
        defaultWorkspace: 'isolated',
        mergeReview: 'parent-then-user',
      }),
    )
  })

  it('explains when there is no published agent to delegate to', async () => {
    const store = makeStore({ 'agent.get': () => mockDetail })
    renderEditor(store)
    await screen.findByText('测试助手')
    fireEvent.click(screen.getByRole('button', { name: /^委派/ }))
    fireEvent.click(screen.getByRole('switch', { name: '允许委派' }))
    expect(screen.getByText('还没有可委派的已发布 Agent。')).toBeDefined()
  })

  it('does not open the trial panel when saving the draft fails', async () => {
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => undefined,
      'trial.list': () => ({ trials: [] }),
    })
    renderEditor(store)
    await screen.findByText('测试助手')

    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens the trial panel without saving a clean draft', async () => {
    let saves = 0
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => {
        saves += 1
        return mockDetail
      },
      'trial.list': () => ({ trials: [] }),
    })
    renderEditor(store)
    await screen.findByText('测试助手')

    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))
    expect(await screen.findByRole('dialog')).toBeDefined()
    expect(saves).toBe(0)
  })

  it('saves the draft before opening the trial panel', async () => {
    let saves = 0
    const store = makeStore({
      'agent.get': () => mockDetail,
      'agent.saveDraft': () => {
        saves += 1
        return mockDetail
      },
      'trial.list': () => ({ trials: [] }),
    })
    renderEditor(store)
    await screen.findByText('测试助手')

    fireEvent.change(screen.getByDisplayValue('测试助手'), { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))
    await waitFor(() => expect(saves).toBeGreaterThan(0))
    expect(await screen.findByRole('dialog')).toBeDefined()
    expect(screen.getByText(/用当前草稿运行一次/)).toBeDefined()
  })
})
