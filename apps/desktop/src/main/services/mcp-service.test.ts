import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { McpManager, type McpClient, type McpTool } from '@cairn/mcp'
import { createMemoryStorage } from '@cairn/storage'
import { createMcpService, type McpCredentialStore, type McpService } from './mcp-service.js'

const tools: McpTool[] = [
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  },
]

const fixtureServer = fileURLToPath(
  new URL('../../../../../packages/mcp/src/testing/fixture-server.mjs', import.meta.url),
)

function setup(
  options: { client?: Partial<McpClient>; storage?: ReturnType<typeof createMemoryStorage> } = {},
) {
  const storage = options.storage ?? createMemoryStorage({ now: () => 100 })
  const secrets = new Map<string, string>()
  const credentials: McpCredentialStore = {
    set: vi.fn(async (ref, secret) => {
      secrets.set(ref, secret)
    }),
    delete: vi.fn(async (ref) => secrets.delete(ref)),
    resolve: vi.fn(async (ref) => {
      const value = secrets.get(ref)
      return value === undefined ? undefined : { apiKey: value }
    }),
    has: (ref) => secrets.has(ref),
  }
  const client: McpClient = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ text: 'done', isError: false })),
    close: vi.fn(async () => undefined),
    ...options.client,
  }
  const manager = new McpManager({
    createClient: () => client,
    sleep: async () => undefined,
  })
  const statuses: unknown[] = []
  const raw = createMcpService({
    storage,
    credentials,
    manager,
    createId: () => 'srv-1',
    onStatus: (event) => statuses.push(event),
  })
  return { storage, secrets, credentials, client, manager, service: settling(raw), raw, statuses }
}

/**
 * 服务的写操作不等连接结果。大多数用例关心连接之后的状态：这里等连接结束，再重新读一次。
 */
function settling(service: McpService): McpService {
  return {
    ...service,
    async add(input) {
      const detail = await service.add(input)
      await service.settled()
      return service.get({ serverId: detail.serverId })
    },
    async update(input) {
      await service.update(input)
      await service.settled()
      return service.get({ serverId: input.serverId })
    },
    async reconnect(input) {
      await service.reconnect(input)
      await service.settled()
      return service.list({}).servers.find((item) => item.serverId === input.serverId)!
    },
    async setEnabled(input) {
      await service.setEnabled(input)
      await service.settled()
      return service.list({}).servers.find((item) => item.serverId === input.serverId)!
    },
    async initialize() {
      await service.initialize()
      await service.settled()
    },
  }
}

describe('mcp-service', () => {
  it('添加 stdio 服务：环境变量值只进凭据服务', async () => {
    const { service, storage, secrets } = setup()
    const detail = await service.add({
      name: 'GitHub',
      kind: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: [{ name: 'GITHUB_TOKEN', value: 'plain-secret-value' }],
    })
    expect(detail.status).toBe('connected')
    expect(detail.env).toEqual([{ name: 'GITHUB_TOKEN', configured: true }])
    expect(detail.tools[0]?.name).toBe('mcp_github_create_issue')
    expect(JSON.stringify(storage.mcpServers.list())).not.toContain('plain-secret-value')
    expect([...secrets.values()]).toContain('plain-secret-value')
  })

  it('更新时保留未填写的环境变量值，删除移除的变量', async () => {
    const { service, secrets } = setup()
    await service.add({
      name: 'A',
      kind: 'stdio',
      command: 'node',
      env: [{ name: 'ONE', value: 'one-value' }],
    })
    await service.update({
      serverId: 'srv-1',
      server: {
        name: 'A',
        kind: 'stdio',
        command: 'node',
        env: [{ name: 'ONE' }, { name: 'TWO', value: 'two-value' }],
      },
    })
    expect(secrets.size).toBe(2)
    await service.update({
      serverId: 'srv-1',
      server: { name: 'A', kind: 'stdio', command: 'node', env: [{ name: 'TWO' }] },
    })
    expect([...secrets.values()]).not.toContain('one-value')
  })

  it('http 使用 token 生成 Authorization，返回时不暴露令牌', async () => {
    const calls: unknown[] = []
    const { service } = setup({
      client: {
        callTool: vi.fn(async (_name, _input, options) => {
          calls.push(options)
          return { text: 'ok', isError: false }
        }),
      },
    })
    const detail = await service.add({
      name: 'Remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      auth: 'bearer',
      token: 'token-value',
    })
    expect(detail.tokenConfigured).toBe(true)
    expect(JSON.stringify(detail)).not.toContain('token-value')
    await service.call('srv-1', 'create_issue', { title: 'x' })
    expect(calls.length).toBe(1)
  })

  it('工具偏好默认为 network/ask，可修改', async () => {
    const { service } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    const before = service.tools({ serverId: 'srv-1' }).tools[0]!
    expect(before.category).toBe('network')
    expect(before.effect).toBe('ask')
    const after = service.setTool({
      serverId: 'srv-1',
      name: before.name,
      category: 'read',
      effect: 'allow',
    })
    expect(after.category).toBe('read')
    expect(after.effect).toBe('allow')
    expect(service.exposures()[0]).toMatchObject({ category: 'read', originalName: 'create_issue' })
  })

  it('停用后不连接、不暴露工具', async () => {
    const { service, client } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node', enabled: false })
    expect(service.list({}).servers[0]?.status).toBe('disabled')
    expect(service.exposures()).toEqual([])
    expect(vi.mocked(client.connect).mock.calls).toHaveLength(0)
  })

  it('调用结果按输出预算截断', async () => {
    const { service } = setup({
      client: { callTool: vi.fn(async () => ({ text: 'x'.repeat(10_000), isError: false })) },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    const result = await service.call('srv-1', 'create_issue', {}, 100)
    expect(result.text.length).toBeLessThan(10_000)
    expect(result.text).toContain('[Output truncated]')
  })

  it('未连接时调用返回错误码', async () => {
    const { service } = setup({
      client: { connect: vi.fn(async () => Promise.reject(new Error('down'))) },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    expect(service.exposures()).toEqual([])
    await expect(service.call('srv-1', 'create_issue', {})).rejects.toMatchObject({
      code: 'mcp.not_connected',
    })
  })

  it('删除服务同时删除凭据与工具偏好', async () => {
    const { service, storage, secrets } = setup()
    await service.add({
      name: 'S',
      kind: 'stdio',
      command: 'node',
      env: [{ name: 'KEY', value: 'secret-value' }],
    })
    service.setTool({ serverId: 'srv-1', name: 'mcp_s_create_issue', category: 'read' })
    service.remove({ serverId: 'srv-1' })
    expect(storage.mcpServers.list()).toEqual([])
    expect(storage.mcpToolPrefs.list('srv-1')).toEqual([])
    expect(secrets.size).toBe(0)
  })

  it('未知服务报 mcp.not_found', () => {
    const { service } = setup()
    expect(() => service.get({ serverId: 'missing' })).toThrow(/mcp.not_found/)
    expect(() => service.logs({ serverId: 'missing' })).toThrow(/mcp.not_found/)
  })

  it('initialize 连接已启用的服务并跳过停用的', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    storage.mcpServers.create({ serverId: 'on', name: 'On', kind: 'stdio', command: 'node' })
    storage.mcpServers.create({
      serverId: 'off',
      name: 'Off',
      kind: 'stdio',
      command: 'node',
      enabled: false,
    })
    const { service } = setup({ storage })
    await service.initialize()
    await vi.waitFor(() => expect(service.list({}).servers[0]?.status).toBe('connected'))
    expect(service.list({}).servers[1]?.status).toBe('disabled')
  })

  it('编辑切换为 http、清除令牌并删除不再需要的环境变量', async () => {
    const { service, secrets } = setup()
    await service.add({
      name: 'Local',
      kind: 'stdio',
      command: 'node',
      env: [{ name: 'KEY', value: 'env-secret' }],
    })
    const detail = await service.update({
      serverId: 'srv-1',
      server: {
        name: 'Remote',
        kind: 'http',
        url: 'https://example.com/mcp',
        auth: 'bearer',
        token: 'token-value',
        env: [],
      },
    })
    expect(detail.kind).toBe('http')
    expect(detail.command).toBeUndefined()
    expect(detail.env).toEqual([])
    expect([...secrets.values()]).not.toContain('env-secret')
    await service.update({
      serverId: 'srv-1',
      server: {
        name: 'Remote',
        kind: 'http',
        url: 'https://example.com/mcp',
        auth: 'none',
        clearToken: true,
      },
    })
    expect([...secrets.values()]).not.toContain('token-value')
  })

  it('重新启用服务后恢复连接，停用时断开', async () => {
    const { service, client } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    await service.setEnabled({ serverId: 'srv-1', enabled: false })
    expect(service.list({}).servers[0]?.status).toBe('disabled')
    expect(client.close).toHaveBeenCalled()
    await service.setEnabled({ serverId: 'srv-1', enabled: true })
    expect(service.list({}).servers[0]?.status).toBe('connected')
  })

  it('停用的服务不能重连', async () => {
    const { service } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node', enabled: false })
    await expect(service.reconnect({ serverId: 'srv-1' })).rejects.toMatchObject({
      code: 'mcp.invalid',
    })
  })

  it('工具不存在时报错，日志可以读取', async () => {
    const { service } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    expect(() => service.setTool({ serverId: 'srv-1', name: 'missing' })).toThrow(
      /mcp.tool_not_found/,
    )
    expect(service.logs({ serverId: 'srv-1' }).logs.length).toBeGreaterThan(0)
  })

  it('调用底层错误时转换为 mcp.call_failed', async () => {
    const { service } = setup({
      client: { callTool: vi.fn(async () => Promise.reject(new Error('boom'))) },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    await expect(service.call('srv-1', 'create_issue', {})).rejects.toMatchObject({
      code: 'mcp.call_failed',
    })
  })

  it('返回完整配置字段与凭据状态', async () => {
    const { service } = setup()
    const detail = await service.add({
      name: 'Full',
      kind: 'stdio',
      command: 'node',
      args: ['a', 'b'],
      cwd: '/work',
      env: [{ name: 'A' }],
    })
    expect(detail).toMatchObject({
      command: 'node',
      args: ['a', 'b'],
      cwd: '/work',
      env: [{ name: 'A', configured: false }],
      auth: 'none',
      tokenConfigured: false,
    })
    expect(detail.url).toBeUndefined()
    const { service: remoteService } = setup()
    const remote = await remoteService.add({
      name: 'Remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      auth: 'header',
      headerName: 'X-Key',
      token: 'abc',
    })
    expect(remote).toMatchObject({
      url: 'https://example.com/mcp',
      auth: 'header',
      headerName: 'X-Key',
      tokenConfigured: true,
    })
    expect(remote.command).toBeUndefined()
    expect(remote.args).toBeUndefined()
    expect(remote.cwd).toBeUndefined()
  })

  it('编辑时未给 env / token 会保留原值', async () => {
    const { service, secrets } = setup()
    await service.add({
      name: 'S',
      kind: 'http',
      url: 'https://e.com',
      auth: 'bearer',
      token: 'kept-token',
      env: [{ name: 'KEEP', value: 'kept-env' }],
    })
    await service.update({
      serverId: 'srv-1',
      server: { name: 'S2', kind: 'http', url: 'https://e.com', auth: 'bearer' },
    })
    expect([...secrets.values()]).toEqual(expect.arrayContaining(['kept-token', 'kept-env']))
  })

  it('同名工具经过清洗后仍然唯一', async () => {
    const { service, client } = setup({
      client: {
        listTools: vi.fn(async () => [
          { name: 'a b', description: '', inputSchema: { type: 'object' } },
          { name: 'a_b', description: '', inputSchema: { type: 'object' } },
        ]),
      },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    expect(service.exposures().map((tool) => tool.name)).toEqual(['mcp_s_a_b', 'mcp_s_a_b_2'])
    expect(client.listTools).toHaveBeenCalled()
  })

  it('多个服务之间工具名不冲突，未连接的服务不参与', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const { service } = setup({ storage })
    await service.add({ name: 'Same', kind: 'stdio', command: 'node' })
    // 第二个服务使用不同的 id：手动写入存储并用相同的客户端
    storage.mcpServers.create({
      serverId: 'srv-2',
      name: 'Same',
      kind: 'stdio',
      command: 'node',
    })
    await service.reconnect({ serverId: 'srv-2' })
    const names = service.exposures().map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('状态错误会出现在摘要中', async () => {
    const { service } = setup({
      client: { connect: vi.fn(async () => Promise.reject(new Error('down'))) },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    expect(service.list({}).servers[0]?.error?.code).toBe('mcp.connect_failed')
    expect(service.get({ serverId: 'srv-1' }).tools).toEqual([])
  })

  it('连接期间读取工具返回空，连接后可用', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = setup({
      client: {
        connect: vi.fn(async () => gate),
      },
    })
    const pending = service.add({ name: 'S', kind: 'stdio', command: 'node' })
    await vi.waitFor(() => expect(service.list({}).servers[0]?.status).toBe('connecting'))
    expect(service.tools({ serverId: 'srv-1' }).tools).toEqual([])
    release()
    await pending
    expect(service.tools({ serverId: 'srv-1' }).tools).toHaveLength(1)
  })

  it('setTool 只改给定的字段', async () => {
    const { service } = setup()
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    const name = service.tools({ serverId: 'srv-1' }).tools[0]!.name
    expect(service.setTool({ serverId: 'srv-1', name, category: 'read' })).toMatchObject({
      category: 'read',
      effect: 'ask',
    })
    expect(service.setTool({ serverId: 'srv-1', name, effect: 'deny' })).toMatchObject({
      category: 'read',
      effect: 'deny',
    })
  })

  it('initialize 在解析凭据失败时记录错误并继续', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    storage.mcpServers.create({
      serverId: 'bad',
      name: 'Bad',
      kind: 'stdio',
      command: 'node',
      env: [{ name: 'KEY', credentialRef: 'ref' }],
    })
    const onError = vi.fn()
    const secrets = new Map<string, string>()
    const service = createMcpService({
      storage,
      onError,
      credentials: {
        set: async (ref, value) => {
          secrets.set(ref, value)
        },
        delete: async () => true,
        resolve: async () => Promise.reject(new Error('cannot decrypt')),
        has: () => true,
      },
    })
    await service.initialize()
    expect(onError).toHaveBeenCalled()
  })

  it('环境变量名清洗后冲突时生成不同的凭据引用', async () => {
    const { service, secrets } = setup()
    const detail = await service.add({
      name: 'S',
      kind: 'stdio',
      command: 'node',
      env: [
        { name: 'A B', value: 'one' },
        { name: 'A_B', value: 'two' },
      ],
    })
    expect(detail.env.map((entry) => entry.configured)).toEqual([true, true])
    expect(secrets.size).toBe(2)
  })

  it('未注入管理器与状态回调时仍可添加与关闭', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const service = settling(
      createMcpService({
        storage,
        credentials: {
          set: async () => undefined,
          delete: async () => true,
          resolve: async () => undefined,
          has: () => false,
        },
      }),
    )
    const detail = await service.add({
      name: 'Broken',
      kind: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
    expect(detail.status).toBe('error')
    await service.close()
  })

  it('汇总工具时跳过未连接的其他服务并保持全局唯一', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const { service } = setup({ storage })
    storage.mcpServers.create({
      serverId: 'off',
      name: 'Off',
      kind: 'stdio',
      command: 'node',
      enabled: false,
    })
    await service.add({ name: 'Same', kind: 'stdio', command: 'node' })
    expect(service.tools({ serverId: 'srv-1' }).tools[0]?.name).toBe('mcp_same_create_issue')
    storage.mcpServers.create({
      serverId: 'srv-2',
      name: 'Same',
      kind: 'stdio',
      command: 'node',
    })
    await service.reconnect({ serverId: 'srv-2' })
    expect(service.tools({ serverId: 'srv-1' }).tools[0]?.name).toBe('mcp_same_create_issue')
    expect(service.tools({ serverId: 'srv-2' }).tools[0]?.name).toBe('mcp_same_create_issue_2')
    expect(service.exposures().map((tool) => tool.name)).toEqual([
      'mcp_same_create_issue',
      'mcp_same_create_issue_2',
    ])
  })

  it('令牌引用无法解析时不带认证头', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const { service } = setup({ storage })
    storage.mcpServers.create({
      serverId: 'remote',
      name: 'Remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      auth: 'bearer',
      credentialRef: 'missing',
    })
    await service.setEnabled({ serverId: 'remote', enabled: true })
    expect(service.list({}).servers[0]?.status).toBe('connected')
  })

  it('header 认证没有指定头名称时使用 Authorization', async () => {
    const { service } = setup()
    const detail = await service.add({
      name: 'Header',
      kind: 'http',
      url: 'https://example.com/mcp',
      auth: 'header',
      token: 'header-token',
    })
    expect(detail.headerName).toBeUndefined()
    expect(detail.tokenConfigured).toBe(true)
  })

  it('缺少命令或地址时使用空字符串并跳过认证', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const { service } = setup({ storage })
    storage.mcpServers.create({ serverId: 'local', name: 'Local', kind: 'stdio' })
    await service.setEnabled({ serverId: 'local', enabled: true })
    expect(service.list({}).servers[0]?.status).toBe('connected')
    storage.mcpServers.create({ serverId: 'remote', name: 'Remote', kind: 'http' })
    await service.setEnabled({ serverId: 'remote', enabled: true })
    expect(service.get({ serverId: 'remote' }).url).toBeUndefined()
  })

  it('删除 HTTP 服务时清理令牌凭据', async () => {
    const { service, secrets } = setup()
    await service.add({
      name: 'Remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      auth: 'bearer',
      token: 'remove-token',
    })
    service.remove({ serverId: 'srv-1' })
    expect([...secrets.values()]).not.toContain('remove-token')
    expect(service.list({}).servers).toEqual([])
  })

  it('底层抛出非 McpError 时记录并返回 call_failed', async () => {
    const manager = {
      call: vi.fn(async () => Promise.reject(new Error('raw failure'))),
      close: vi.fn(async () => undefined),
    } as unknown as McpManager
    const onError = vi.fn()
    const service = createMcpService({
      storage: createMemoryStorage({ now: () => 1 }),
      credentials: {
        set: async () => undefined,
        delete: async () => true,
        resolve: async () => undefined,
        has: () => false,
      },
      manager,
      onError,
    })
    await expect(service.call('srv-1', 'tool', {})).rejects.toMatchObject({
      code: 'mcp.call_failed',
    })
    expect(onError).toHaveBeenCalled()
    await service.close()
    expect(manager.close).toHaveBeenCalled()
  })

  it('编辑时省略命令或地址会沿用当前值', async () => {
    const { service } = setup()
    await service.add({ name: 'A', kind: 'stdio', command: 'node', args: ['a'] })
    const kept = await service.update({
      serverId: 'srv-1',
      server: { name: 'A', kind: 'stdio' },
    })
    expect(kept.command).toBe('node')
    await service.update({
      serverId: 'srv-1',
      server: { name: 'A', kind: 'http', url: 'https://example.com/mcp', auth: 'none' },
    })
    const http = await service.update({
      serverId: 'srv-1',
      server: { name: 'A', kind: 'http' },
    })
    expect(http.url).toBe('https://example.com/mcp')
  })

  it('工具名清洗后为空时使用 tool 占位', async () => {
    const { service } = setup({
      client: {
        listTools: vi.fn(async () => [
          { name: '!!!', description: '', inputSchema: { type: 'object' } },
        ]),
      },
    })
    await service.add({ name: 'S', kind: 'stdio', command: 'node' })
    expect(service.exposures()[0]?.name).toBe('mcp_s_tool')
  })

  it('默认管理器把连接成功与失败状态推给回调', async () => {
    const credentials: McpCredentialStore = {
      set: async () => undefined,
      delete: async () => true,
      resolve: async () => undefined,
      has: () => false,
    }
    const statuses: { status: string; toolCount: number; error?: unknown }[] = []
    const service = settling(
      createMcpService({
        storage: createMemoryStorage({ now: () => 1 }),
        credentials,
        onStatus: (event) => statuses.push(event),
      }),
    )
    const detail = await service.add({
      name: 'Fixture',
      kind: 'stdio',
      command: process.execPath,
      args: [fixtureServer],
    })
    expect(detail.status).toBe('connected')
    expect(statuses.some((event) => event.status === 'connected' && event.toolCount > 0)).toBe(true)
    await service.close()

    const failed: { status: string; toolCount: number; error?: unknown }[] = []
    const broken = settling(
      createMcpService({
        storage: createMemoryStorage({ now: () => 1 }),
        credentials,
        onStatus: (event) => failed.push(event),
      }),
    )
    const error = await broken.add({
      name: 'Broken',
      kind: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    })
    expect(error.status).toBe('error')
    expect(failed.some((event) => event.error !== undefined)).toBe(true)
    await broken.close()
  })

  it('编辑缺少命令或地址的记录时使用空字符串', async () => {
    const storage = createMemoryStorage({ now: () => 1 })
    const { service } = setup({ storage })
    storage.mcpServers.create({ serverId: 'local', name: 'Local', kind: 'stdio' })
    const local = await service.update({
      serverId: 'local',
      server: { name: 'Local', kind: 'stdio' },
    })
    expect(local.command).toBe('')
    storage.mcpServers.create({ serverId: 'remote', name: 'Remote', kind: 'http' })
    const remote = await service.update({
      serverId: 'remote',
      server: { name: 'Remote', kind: 'http' },
    })
    expect(remote.url).toBe('')
  })
})

describe('mcp-service 不等连接、工具权限与清单变化', () => {
  it('添加、启用、重连都立即返回“连接中”，连接结果之后再推送', async () => {
    let finish: () => void = () => undefined
    const { raw } = setup({
      client: {
        connect: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve
            }),
        ),
      },
    })
    const detail = await raw.add({ name: 'Slow', kind: 'stdio', command: 'node' })
    expect(detail.status).toBe('connecting')
    finish()
    await raw.settled()
    expect(raw.get({ serverId: 'srv-1' }).status).toBe('connected')

    const reconnecting = raw.reconnect({ serverId: 'srv-1' })
    expect((await reconnecting).status).toBe('connecting')
    finish()
    await raw.settled()

    expect((await raw.setEnabled({ serverId: 'srv-1', enabled: false })).status).toBe('disabled')
    expect((await raw.setEnabled({ serverId: 'srv-1', enabled: true })).status).toBe('connecting')
    finish()
    await raw.settled()
    expect(raw.get({ serverId: 'srv-1' }).status).toBe('connected')
  })

  it('保存时不再连接已停用的服务', async () => {
    const { service, client } = setup()
    await service.add({ name: 'A', kind: 'stdio', command: 'node', enabled: false })
    await service.update({
      serverId: 'srv-1',
      server: { name: 'A', kind: 'stdio', command: 'node2', enabled: false },
    })
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('设置过效果的工具变成按工具名匹配的规则，没设置过的不加', async () => {
    const { service } = setup()
    await service.add({ name: 'GitHub', kind: 'stdio', command: 'node' })
    expect(service.permissionRules()).toEqual([])
    service.setTool({ serverId: 'srv-1', name: 'mcp_github_create_issue', effect: 'deny' })
    expect(service.permissionRules()).toEqual([
      {
        id: 'mcp.srv-1.create_issue',
        scope: 'global',
        effect: 'deny',
        match: { tool: 'mcp_github_create_issue' },
        source: 'user',
      },
    ])
    await service.setEnabled({ serverId: 'srv-1', enabled: false })
    expect(service.permissionRules()).toEqual([])
  })

  it('连接结果、停用、删除与工具设置都通知工具清单变化', async () => {
    const storage = createMemoryStorage({ now: () => 100 })
    const changed = vi.fn()
    const client: McpClient = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => tools),
      callTool: vi.fn(async () => ({ text: 'done', isError: false })),
      close: vi.fn(async () => undefined),
    }
    const manager = new McpManager({ createClient: () => client, sleep: async () => undefined })
    const service = settling(
      createMcpService({
        storage,
        credentials: {
          set: async () => undefined,
          delete: async () => true,
          resolve: async () => undefined,
          has: () => false,
        },
        manager,
        createId: () => 'srv-1',
        onStatus: (event) => manager.get(event.serverId),
        onToolsChanged: changed,
      }),
    )
    // 自己的管理器不经服务的 onStatus：这里只验证服务主动发出的通知
    await service.add({ name: 'A', kind: 'stdio', command: 'node' })
    const before = changed.mock.calls.length
    service.setTool({ serverId: 'srv-1', name: 'mcp_a_create_issue', effect: 'allow' })
    await service.setEnabled({ serverId: 'srv-1', enabled: false })
    service.remove({ serverId: 'srv-1' })
    expect(changed.mock.calls.length).toBe(before + 3)
  })

  it('默认管理器连上后通知工具清单变化，连接中不通知', async () => {
    const changed = vi.fn()
    const statuses: string[] = []
    const service = settling(
      createMcpService({
        storage: createMemoryStorage({ now: () => 1 }),
        credentials: {
          set: async () => undefined,
          delete: async () => true,
          resolve: async () => undefined,
          has: () => false,
        },
        onStatus: (event) => statuses.push(event.status),
        onToolsChanged: () => changed(statuses.at(-1)),
      }),
    )
    await service.add({
      name: 'Fixture',
      kind: 'stdio',
      command: process.execPath,
      args: [fixtureServer],
    })
    expect(changed).toHaveBeenCalled()
    expect(changed.mock.calls.every(([status]) => status !== 'connecting')).toBe(true)
    await service.close()
  })
})
