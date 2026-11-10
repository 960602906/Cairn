// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import {
  RpcError,
  type HubMcpCard,
  type McpLogEntry,
  type McpServerDetail,
  type McpServerInput,
  type McpServerSummary,
  type McpStatusEvent,
  type McpToolSummary,
} from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(cleanup)

const tool = (patch: Partial<McpToolSummary> = {}): McpToolSummary => ({
  name: 'mcp_fixture_echo',
  originalName: 'echo',
  description: 'Echo input.',
  inputSchema: { type: 'object' },
  category: 'network',
  effect: 'ask',
  ...patch,
})

const TOKEN = `${'token'}-${'value'}`

const server = (patch: Partial<McpServerSummary> = {}): McpServerSummary => ({
  serverId: 'm1',
  name: 'Fixture',
  kind: 'stdio',
  enabled: true,
  status: 'connected',
  toolCount: 1,
  updatedAt: 1,
  ...patch,
})

const detailOf = (
  value: McpServerSummary,
  patch: Partial<McpServerDetail> = {},
): McpServerDetail => ({
  ...value,
  command: 'node',
  args: ['server.mjs'],
  env: [{ name: 'TOKEN', configured: true }],
  auth: 'none',
  tokenConfigured: false,
  tools: [tool()],
  ...patch,
})

interface SetupOptions {
  readonly servers?: McpServerSummary[]
  readonly failAdd?: boolean
  readonly failList?: boolean
  readonly failGet?: boolean
  readonly failLogs?: boolean
  readonly failSetTool?: boolean
  readonly failSetEnabled?: boolean
  readonly failRemove?: boolean
  /** 覆盖详情，用来测远程配置、空工具列表等分支。 */
  readonly detail?: Partial<McpServerDetail>
  readonly logsFor?: (serverId: string) => McpLogEntry[]
  readonly hubItems?: HubMcpCard[]
  readonly failHub?: boolean
  /** 挂起 `mcp.add`，用来验证保存时的重复点击。 */
  readonly addGate?: Promise<void>
}

function setup(options: SetupOptions = {}) {
  let servers = options.servers ?? [server()]
  const defaultLogs: McpLogEntry[] = [
    { ts: 1_700_000_000_000, level: 'info' as const, message: 'connecting to Fixture' },
    { ts: 1_700_000_001_000, level: 'warn' as const, message: 'connection closed' },
  ]
  const detailOfId = (serverId: string): McpServerDetail => {
    const found = servers.find((item) => item.serverId === serverId)
    if (!found) throw new RpcError('mcp.not_found', { serverId })
    const base = detailOf(found, {
      ...(found.serverId === 'm1'
        ? {}
        : { command: 'npx', args: [], env: [], url: undefined, auth: 'none' }),
    })
    return options.detail === undefined ? base : { ...base, ...options.detail }
  }
  const handlers = new Map<string, (payload: unknown) => void>()
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'settings.get':
        return { locale: 'zh-CN', providers: [] }
      case 'settings.shell':
        return { detected: 'bash', options: ['auto'] }
      case 'session.list':
        return { sessions: [] }
      case 'project.list':
        return { projects: [] }
      case 'mcp.list': {
        if (options.failList) throw new RpcError('mcp.not_found')
        return { servers }
      }
      case 'mcp.get':
        if (options.failGet) throw new RpcError('mcp.not_found')
        return detailOfId((params as { serverId: string }).serverId)
      case 'mcp.add': {
        await options.addGate
        if (options.failAdd) throw new RpcError('mcp.connect_failed')
        const input = params as McpServerInput
        const created = server({
          serverId: 'm-new',
          name: input.name,
          kind: input.kind,
          status: 'connected',
        })
        servers = [...servers, created]
        return detailOf(created, { command: input.command, args: input.args ?? [], env: [] })
      }
      case 'mcp.update': {
        const { serverId, server: input } = params as {
          serverId: string
          server: McpServerInput
        }
        servers = servers.map((item) =>
          item.serverId === serverId ? { ...item, name: input.name, kind: input.kind } : item,
        )
        return detailOfId(serverId)
      }
      case 'mcp.remove': {
        if (options.failRemove) throw new RpcError('mcp.not_found')
        const { serverId } = params as { serverId: string }
        servers = servers.filter((item) => item.serverId !== serverId)
        return {}
      }
      case 'mcp.setEnabled': {
        if (options.failSetEnabled) throw new RpcError('mcp.not_connected')
        const { serverId, enabled } = params as { serverId: string; enabled: boolean }
        servers = servers.map((item) =>
          item.serverId === serverId
            ? { ...item, enabled, status: enabled ? 'connected' : 'disabled', toolCount: 1 }
            : item,
        )
        return servers.find((item) => item.serverId === serverId)!
      }
      case 'mcp.reconnect':
        return servers.find((item) => item.serverId === (params as { serverId: string }).serverId)!
      case 'mcp.setTool': {
        if (options.failSetTool) throw new RpcError('mcp.tool_not_found')
        const input = params as {
          serverId: string
          name: string
          category?: McpToolSummary['category']
          effect?: McpToolSummary['effect']
        }
        return tool({
          name: input.name,
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.effect === undefined ? {} : { effect: input.effect }),
        })
      }
      case 'mcp.logs': {
        if (options.failLogs) throw new RpcError('mcp.not_found')
        const { serverId } = params as { serverId: string }
        return { logs: options.logsFor?.(serverId) ?? defaultLogs }
      }
      case 'hub.mcp': {
        if (options.failHub) throw new RpcError('hub.failed')
        return { items: options.hubItems ?? [] }
      }
      default:
        return {}
    }
  })
  const api = {
    ready: async () => {},
    request,
    on: (event: string, listener: (payload: unknown) => void) => {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    },
  } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
  return {
    request,
    setServers: (next: McpServerSummary[]) => (servers = next),
    emitStatus: (event: McpStatusEvent) => handlers.get('mcp.status')?.(event),
  }
}

async function openMcp() {
  await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
  const nav = await screen.findByRole('navigation', { name: '设置分类' })
  await userEvent.click(within(nav).getByRole('button', { name: 'MCP 服务' }))
  return screen.findByRole('heading', { name: 'MCP 服务' })
}

describe('McpSettings', () => {
  it('lists servers with status, tool count and toggles enablement', async () => {
    const { request } = setup()
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    expect(within(list).getByText('Fixture')).toBeTruthy()
    expect(within(list).getByText('已连接')).toBeTruthy()
    expect(within(list).getByText('1 个工具')).toBeTruthy()

    await userEvent.click(within(list).getByRole('switch', { name: '启用 Fixture' }))
    expect(request).toHaveBeenCalledWith('mcp.setEnabled', {
      serverId: 'm1',
      enabled: false,
    })
    await waitFor(() => expect(within(list).getByText('已停用')).toBeTruthy())
  })

  it('filters servers and applies enablement in batch', async () => {
    const { request } = setup({
      servers: [
        server({ serverId: 'm1', name: 'Alpha' }),
        server({ serverId: 'm2', name: 'Beta', status: 'disabled', enabled: false }),
        server({ serverId: 'm3', name: 'Gamma', kind: 'http' }),
      ],
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    const search = screen.getByRole('searchbox', { name: '搜索服务' })

    await userEvent.type(search, 'beta')
    await waitFor(() => expect(within(list).queryByText('Alpha')).toBeNull())
    expect(within(list).getByText('Beta')).toBeTruthy()

    await userEvent.clear(search)
    await userEvent.type(search, '远程')
    await waitFor(() => expect(within(list).getByText('Gamma')).toBeTruthy())
    expect(within(list).queryByText('Alpha')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'missing')
    expect(await screen.findByText('没有匹配的服务。')).toBeTruthy()

    await userEvent.clear(search)
    const restored = await screen.findByRole('list', { name: 'MCP 服务' })
    await waitFor(() => expect(within(restored).getByText('Alpha')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(restored).getByRole('checkbox', { name: '选择 Alpha' }))
    await userEvent.click(within(restored).getByRole('checkbox', { name: '选择 Beta' }))
    await userEvent.click(screen.getByRole('button', { name: '启用' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.setEnabled', { serverId: 'm1', enabled: true }),
    )
    expect(request).toHaveBeenCalledWith('mcp.setEnabled', { serverId: 'm2', enabled: true })
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 Alpha' })).toBeNull())
  })

  it('deletes several servers from batch mode', async () => {
    const { request } = setup({
      servers: [
        server({ serverId: 'm1', name: 'Alpha' }),
        server({ serverId: 'm2', name: 'Beta' }),
      ],
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(screen.getByRole('button', { name: '批量' }))
    await userEvent.click(within(list).getByRole('checkbox', { name: '选择 Alpha' }))
    await userEvent.click(within(list).getByRole('checkbox', { name: '选择 Beta' }))
    await userEvent.click(screen.getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '删除选中的 2 个服务？' })).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '删除服务' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('mcp.remove', { serverId: 'm1' }))
    expect(request).toHaveBeenCalledWith('mcp.remove', { serverId: 'm2' })
    expect(await screen.findByText(/还没有 MCP 服务/)).toBeTruthy()
  })

  it('adds a stdio server with arguments and environment variables', async () => {
    const { request } = setup({ servers: [] })
    await openMcp()
    expect(await screen.findByText(/还没有 MCP 服务/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '添加服务' }))

    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名称'), 'GitHub')
    await userEvent.type(within(dialog).getByLabelText('命令'), 'node')
    await userEvent.type(within(dialog).getByLabelText('参数'), 'server.mjs{enter}--stdio')
    await userEvent.type(within(dialog).getByLabelText('工作目录'), '/work')
    await userEvent.click(within(dialog).getByRole('button', { name: '添加变量' }))
    const names = within(dialog).getAllByLabelText('名称')
    await userEvent.type(names[1]!, 'TOKEN')
    await userEvent.type(within(dialog).getByLabelText('TOKEN 的值'), 'secret-value')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.add', {
        name: 'GitHub',
        kind: 'stdio',
        enabled: true,
        command: 'node',
        args: ['server.mjs', '--stdio'],
        cwd: '/work',
        env: [{ name: 'TOKEN', value: 'secret-value' }],
      }),
    )
    const detail = await screen.findByRole('dialog')
    expect(within(detail).getByRole('heading', { name: 'GitHub' })).toBeTruthy()
  })

  it('adds a remote server with header authentication', async () => {
    const { request } = setup({ servers: [] })
    await openMcp()
    await userEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名称'), 'Remote')
    await userEvent.selectOptions(within(dialog).getByLabelText('类型'), 'http')
    await userEvent.type(within(dialog).getByLabelText('地址'), 'https://example.com/mcp')
    await userEvent.selectOptions(within(dialog).getByLabelText('认证方式'), 'header')
    await userEvent.type(within(dialog).getByLabelText('请求头名称'), 'X-Key')
    await userEvent.type(within(dialog).getByLabelText('令牌'), TOKEN)
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.add', {
        name: 'Remote',
        kind: 'http',
        enabled: true,
        url: 'https://example.com/mcp',
        auth: 'header',
        headerName: 'X-Key',
        token: TOKEN,
      }),
    )
  })

  it('removes environment rows and requires a header name for header auth', async () => {
    const { request } = setup({ servers: [] })
    await openMcp()
    await userEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名称'), 'Remote')
    await userEvent.selectOptions(within(dialog).getByLabelText('类型'), 'http')
    await userEvent.type(within(dialog).getByLabelText('地址'), 'https://example.com/mcp')
    await userEvent.selectOptions(within(dialog).getByLabelText('认证方式'), 'header')
    const save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(within(dialog).getByLabelText('请求头名称'), 'X-Key')
    expect(save.disabled).toBe(false)

    await userEvent.click(within(dialog).getByRole('button', { name: '添加变量' }))
    const names = within(dialog).getAllByLabelText('名称')
    await userEvent.type(names[1]!, 'TEMP')
    expect(within(dialog).queryByText('没有环境变量。')).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: '删除变量 TEMP' }))
    expect(within(dialog).getByText('没有环境变量。')).toBeTruthy()
    await userEvent.click(save)
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.add', {
        name: 'Remote',
        kind: 'http',
        enabled: true,
        url: 'https://example.com/mcp',
        auth: 'header',
        headerName: 'X-Key',
      }),
    )
  })

  it('browses the MCP market and installs a remote server', async () => {
    const card = (patch: Partial<HubMcpCard>): HubMcpCard => ({
      id: 'acme/http',
      name: 'acme/http',
      title: 'HTTP Server',
      description: 'Remote tools.',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      homepage: 'https://example.com',
      requiresAuth: false,
      ...patch,
    })
    const { request } = setup({
      servers: [],
      hubItems: [
        card({}),
        card({ id: 'acme/auth', name: 'acme/auth', title: 'Auth Server', requiresAuth: true }),
        card({ id: 'acme/stdio', name: 'acme/stdio', title: 'Local Server', transport: 'stdio' }),
      ],
    })
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('HTTP Server')).toBeTruthy()
    expect(within(dialog).getByText('需要鉴权')).toBeTruthy()

    const installButtons = within(dialog).getAllByRole('button', { name: '一键添加' })
    expect(installButtons).toHaveLength(3)
    expect(installButtons[1]).toHaveProperty('disabled', true)
    expect(installButtons[2]).toHaveProperty('disabled', true)
    await userEvent.click(installButtons[0]!)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.add', {
        name: 'HTTP Server',
        kind: 'http',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
      }),
    )
    // 添加成功后自动打开详情，列表里也能看到这个服务。
    expect(await screen.findByRole('heading', { name: 'HTTP Server' })).toBeTruthy()
  })

  it('searches the MCP market and reports an unavailable registry', async () => {
    const { request } = setup({ servers: [], hubItems: [] })
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('没有找到匹配的服务。')).toBeTruthy()
    await userEvent.type(within(dialog).getByRole('searchbox', { name: '搜索 MCP 服务' }), 'github')
    await userEvent.click(within(dialog).getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('hub.mcp', { query: 'github' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    cleanup()

    setup({ servers: [], failHub: true })
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    expect((await screen.findByRole('alert')).textContent).toContain('市场暂时不可用')
  })

  it('renders market cards without links or descriptions and keeps the dialog on add failure', async () => {
    const card: HubMcpCard = {
      id: 'acme/no-link',
      name: 'acme/no-link',
      title: 'No Link',
      description: '',
      transport: 'http',
      url: 'https://mcp.example.com/no-link',
      requiresAuth: false,
    }
    const { request } = setup({ servers: [], hubItems: [card], failAdd: true })
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('No Link')).toBeTruthy()
    expect(within(dialog).getByText('这个服务还没有简介。')).toBeTruthy()
    expect(within(dialog).queryByRole('link')).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: '一键添加' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.add', {
        name: 'No Link',
        kind: 'http',
        url: 'https://mcp.example.com/no-link',
        enabled: true,
      }),
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('No Link')).toBeTruthy()
  })

  it('shows the adding state and blocks other market installs while pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const card = (id: string, title: string): HubMcpCard => ({
      id,
      name: id,
      title,
      description: `${title} tools.`,
      transport: 'http',
      url: `https://mcp.example.com/${id}`,
      requiresAuth: false,
    })
    setup({
      servers: [],
      addGate: gate,
      hubItems: [card('first', 'First'), card('second', 'Second')],
    })
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    const dialog = await screen.findByRole('dialog')
    const add = await within(dialog).findAllByRole('button', { name: '一键添加' })
    await userEvent.click(add[0]!)
    const pending = await within(dialog).findByRole('button', { name: '正在添加…' })
    expect(pending).toHaveProperty('disabled', true)
    expect(add[1]).toHaveProperty('disabled', true)
    release()
    expect(await screen.findByRole('heading', { name: 'First' })).toBeTruthy()
  })

  it('reports a failed market search after results are already visible', async () => {
    const options = {
      servers: [],
      hubItems: [
        {
          id: 'acme/http',
          name: 'acme/http',
          title: 'HTTP Server',
          description: 'Remote tools.',
          transport: 'http' as const,
          url: 'https://mcp.example.com/mcp',
          requiresAuth: false,
        },
      ],
      failHub: false,
    }
    setup(options)
    await openMcp()
    await userEvent.click(screen.getByRole('button', { name: '市场' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('HTTP Server')).toBeTruthy()

    options.failHub = true
    await userEvent.type(
      within(dialog).getByRole('searchbox', { name: '搜索 MCP 服务' }),
      'missing',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '搜索' }))
    expect(await within(dialog).findByText(/市场暂时不可用/)).toBeTruthy()
    expect(within(dialog).getByText('HTTP Server')).toBeTruthy()
  })

  it('shows tools and logs, and updates per-tool permissions', async () => {
    const { request } = setup()
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('mcp_fixture_echo')).toBeTruthy())
    expect(within(dialog).getByText('connecting to Fixture')).toBeTruthy()
    expect(within(dialog).getByText('connection closed')).toBeTruthy()

    await userEvent.selectOptions(within(dialog).getByLabelText('mcp_fixture_echo 的类别'), 'read')
    expect(request).toHaveBeenCalledWith('mcp.setTool', {
      serverId: 'm1',
      name: 'mcp_fixture_echo',
      category: 'read',
    })
    await userEvent.selectOptions(
      within(dialog).getByLabelText('mcp_fixture_echo 的默认权限'),
      'deny',
    )
    expect(request).toHaveBeenCalledWith('mcp.setTool', {
      serverId: 'm1',
      name: 'mcp_fixture_echo',
      effect: 'deny',
    })
  })

  it('edits, reconnects and deletes a server', async () => {
    const { request } = setup()
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    let dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '重新连接' }))
    expect(request).toHaveBeenCalledWith('mcp.reconnect', { serverId: 'm1' })

    await userEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    dialog = await screen.findByRole('dialog')
    const name = within(dialog).getAllByLabelText('名称')[0]!
    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.update', {
        serverId: 'm1',
        server: {
          name: 'Renamed',
          kind: 'stdio',
          enabled: true,
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'TOKEN' }],
        },
      }),
    )

    dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog')
    expect(within(confirm).getByText(/会删除这份配置/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '删除服务' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('mcp.remove', { serverId: 'm1' }))
    expect(await screen.findByText(/还没有 MCP 服务/)).toBeTruthy()
    expect(screen.queryByText('Renamed')).toBeNull()
  })

  it('shows connection errors and reports add failures', async () => {
    const { request } = setup({
      servers: [
        server({
          status: 'error',
          toolCount: 0,
          error: { code: 'mcp.connect_failed', message: 'spawn failed' },
        }),
      ],
      failAdd: true,
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    expect(within(list).getByText('错误')).toBeTruthy()
    expect(within(list).getByText('mcp.connect_failed：spawn failed')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '添加服务' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名称'), 'Broken')
    await userEvent.type(within(dialog).getByLabelText('命令'), 'node')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'mcp.add')).toBe(true),
    )
    expect(await screen.findByText(/无法连接 MCP 服务/)).toBeTruthy()
  })

  it('renders connecting and disabled states and refreshes on status events', async () => {
    const { request, emitStatus } = setup({
      servers: [
        server({ serverId: 'm1', name: 'Busy', status: 'connecting' }),
        server({ serverId: 'm2', name: 'Off', status: 'disabled', enabled: false }),
      ],
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    expect(within(list).getByText('连接中')).toBeTruthy()
    expect(within(list).getByText('已停用')).toBeTruthy()

    await userEvent.click(within(list).getByRole('button', { name: '查看 Busy 的详情' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('mcp_fixture_echo')).toBeTruthy())

    const count = (method: string) => request.mock.calls.filter(([name]) => name === method).length
    const getCount = count('mcp.get')
    const listCount = count('mcp.list')
    emitStatus({ serverId: 'm1', status: 'connected', toolCount: 1 })
    await waitFor(() => expect(count('mcp.get')).toBe(getCount + 1))
    expect(count('mcp.list')).toBe(listCount + 1)

    const afterMatch = count('mcp.get')
    emitStatus({ serverId: 'm2', status: 'disabled', toolCount: 0 })
    await waitFor(() => expect(count('mcp.list')).toBe(listCount + 2))
    expect(count('mcp.get')).toBe(afterMatch)
  })

  it('edits a remote server and clears a stored token', async () => {
    const { request } = setup({
      detail: {
        kind: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        env: [],
        url: 'https://example.com/mcp',
        auth: 'bearer',
        headerName: undefined,
        tokenConfigured: true,
      },
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    const form = await screen.findByRole('dialog')
    expect(within(form).getByPlaceholderText('已设置，留空保持不变')).toBeTruthy()
    await userEvent.click(within(form).getByRole('switch', { name: '清除已保存的令牌' }))
    await userEvent.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.update', {
        serverId: 'm1',
        server: {
          name: 'Fixture',
          kind: 'http',
          enabled: true,
          url: 'https://example.com/mcp',
          auth: 'bearer',
          clearToken: true,
        },
      }),
    )
  })

  it('omits empty arguments, cwd and blank environment names when saving', async () => {
    const { request } = setup({
      detail: { command: undefined, args: undefined, cwd: undefined },
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    const form = await screen.findByRole('dialog')
    await userEvent.type(within(form).getByLabelText('命令'), 'node')
    await userEvent.click(within(form).getByRole('button', { name: '添加变量' }))
    await userEvent.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.update', {
        serverId: 'm1',
        server: {
          name: 'Fixture',
          kind: 'stdio',
          enabled: true,
          command: 'node',
          env: [{ name: 'TOKEN' }],
        },
      }),
    )
  })

  it('shows detail errors and the empty tools/logs states', async () => {
    setup({
      servers: [server({ serverId: 'm2', name: 'Quiet', status: 'error', toolCount: 0 })],
      detail: {
        error: { code: 'mcp.connect_failed', message: 'boom' },
        tools: [],
      },
      logsFor: () => [],
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Quiet 的详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('mcp.connect_failed：boom')).toBeTruthy()
    expect(within(dialog).getByText('连接后显示工具。')).toBeTruthy()
    expect(within(dialog).getByText('暂时没有日志。')).toBeTruthy()
  })

  it('keeps current state when tool, toggle and remove calls fail', async () => {
    const { request } = setup({
      failSetTool: true,
      failSetEnabled: true,
      failRemove: true,
      detail: {
        tools: [tool(), tool({ name: 'mcp_fixture_nodesc', description: '' })],
      },
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('switch', { name: '启用 Fixture' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('mcp.setEnabled', { serverId: 'm1', enabled: false }),
    )
    expect(within(list).getByText('已连接')).toBeTruthy()

    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    const category = within(dialog).getByLabelText('mcp_fixture_echo 的类别')
    await userEvent.selectOptions(category, 'read')
    expect(request).toHaveBeenCalledWith('mcp.setTool', {
      serverId: 'm1',
      name: 'mcp_fixture_echo',
      category: 'read',
    })
    expect((category as HTMLSelectElement).value).toBe('network')

    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog')
    await userEvent.click(within(confirm).getByRole('button', { name: '删除服务' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('mcp.remove', { serverId: 'm1' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }))
    const current = await screen.findByRole('list', { name: 'MCP 服务' })
    expect(within(current).getByText('Fixture')).toBeTruthy()
    expect(screen.queryByText(/还没有 MCP 服务/)).toBeNull()
  })

  it('closes the form and confirmations without changing anything', async () => {
    const { request } = setup()
    await openMcp()
    await userEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    let dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog')
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText(/会删除这份配置/)).toBeNull())
    expect(request).not.toHaveBeenCalledWith('mcp.remove', { serverId: 'm1' })
  })

  it('shows the empty state when listing fails and keeps details closed when loading fails', async () => {
    setup({ failList: true, failGet: true })
    await openMcp()
    expect(await screen.findByText(/还没有 MCP 服务/)).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'MCP 服务' })).toBeNull()
  })

  it('shows an empty log list when logs are unavailable', async () => {
    setup({ failLogs: true })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('暂时没有日志。')).toBeTruthy()
  })

  it('ignores repeated saves while the first is pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { request } = setup({ servers: [], addGate: gate })
    await openMcp()
    await userEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    const form = await screen.findByRole('dialog')
    await userEvent.type(within(form).getByLabelText('名称'), 'Slow')
    await userEvent.type(within(form).getByLabelText('命令'), 'node')
    const save = within(form).getByRole('button', { name: '保存' })
    await userEvent.click(save)
    expect(save).toHaveProperty('disabled', true)
    await userEvent.click(save)
    expect(request.mock.calls.filter(([method]) => method === 'mcp.add')).toHaveLength(1)
    release()
    expect(await screen.findByRole('heading', { name: 'Slow' })).toBeTruthy()
  })

  it('renders error-level log entries', async () => {
    setup({
      logsFor: () => [
        { ts: 1_700_000_000_000, level: 'error', message: 'connection lost' },
        { ts: 1_700_000_001_000, level: 'info', message: 'retrying' },
      ],
    })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })
    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('connection lost')).toBeTruthy()
    expect(within(dialog).getByText('retrying')).toBeTruthy()
  })

  it('closes dialogs with Escape and keeps other servers selected', async () => {
    setup({ servers: [server({ serverId: 'm1' }), server({ serverId: 'm2', name: 'Other' })] })
    await openMcp()
    const list = await screen.findByRole('list', { name: 'MCP 服务' })

    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(screen.getByRole('button', { name: '添加服务' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(within(list).getByRole('button', { name: '查看 Fixture 的详情' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText(/会删除这份配置/)).toBeNull())
  })
})
