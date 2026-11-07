import { describe, expect, it, vi } from 'vitest'
import {
  contentToText,
  McpError,
  McpManager,
  type McpClient,
  type McpServerSpec,
  type McpTool,
} from './index.js'

const SECRET = `${'unit'}-${'test'}-${'secret'}-${'value'}`

const spec: McpServerSpec = {
  serverId: 'srv-1',
  name: 'Fixture',
  transport: {
    kind: 'stdio',
    command: 'node',
    env: { SECRET_TOKEN: SECRET },
  },
}

const tools: McpTool[] = [
  {
    name: 'echo',
    description: 'Echo input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

function fakeClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ text: 'ok', isError: false })),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('McpManager', () => {
  it('连接、列出工具并转发调用', async () => {
    const client = fakeClient()
    const statuses: string[] = []
    const manager = new McpManager({
      createClient: () => client,
      onStatus: (state) => statuses.push(state.status),
      sleep: async () => undefined,
    })
    const state = await manager.add(spec)
    expect(state.status).toBe('connected')
    expect(state.tools).toEqual(tools)
    expect(statuses).toContain('connecting')
    expect(manager.tools()).toEqual([{ serverId: 'srv-1', tool: tools[0] }])

    const result = await manager.call('srv-1', 'echo', { text: 'hi' })
    expect(result).toEqual({ text: 'ok', isError: false })
    expect(client.callTool).toHaveBeenCalledWith('echo', { text: 'hi' }, {})
  })

  it('连接失败后按退避重试，最终报错', async () => {
    const connect = vi
      .fn<McpClient['connect']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const sleeps: number[] = []
    const manager = new McpManager({
      createClient: () => fakeClient({ connect }),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      reconnect: { attempts: 2, initialDelayMs: 100, factor: 2, maxDelayMs: 1000 },
    })
    const state = await manager.add(spec)
    expect(state.status).toBe('connected')
    expect(sleeps).toEqual([100])
  })

  it('重试耗尽后进入错误状态', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({ connect: vi.fn(async () => Promise.reject(new Error('nope'))) }),
      sleep: async () => undefined,
      reconnect: { attempts: 2, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    const state = await manager.add(spec)
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('mcp.connect_failed')
  })

  it('连接超时', async () => {
    const manager = new McpManager({
      createClient: () => fakeClient({ connect: () => new Promise(() => undefined) }),
      sleep: async () => undefined,
      reconnect: { attempts: 1, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    const state = await manager.add({ ...spec, connectTimeoutMs: 5 })
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('mcp.timeout')
  })

  it('日志按环境变量值脱敏，并限制行数', async () => {
    const manager = new McpManager({
      createClient: () => fakeClient(),
      sleep: async () => undefined,
    })
    await manager.add({ ...spec, maxLogLines: 2 })
    const logs = manager.logs('srv-1')
    expect(logs.length).toBeLessThanOrEqual(2)
    expect(logs.map((entry) => entry.message).join('\n')).not.toContain(SECRET)
  })

  it('未连接时调用报 mcp.not_connected', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({ connect: vi.fn(async () => Promise.reject(new Error('x'))) }),
      sleep: async () => undefined,
      reconnect: { attempts: 1, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    await manager.add(spec)
    await expect(manager.call('srv-1', 'echo', {})).rejects.toMatchObject({
      code: 'mcp.not_connected',
    })
  })

  it('未知服务与移除', () => {
    const manager = new McpManager({ createClient: () => fakeClient() })
    expect(() => manager.logs('missing')).toThrow(McpError)
    manager.remove('missing')
    expect(manager.list()).toEqual([])
  })

  it('重复添加会替换旧连接', async () => {
    const first = fakeClient()
    const second = fakeClient()
    let count = 0
    const manager = new McpManager({
      createClient: () => (count++ === 0 ? first : second),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    await manager.add({ ...spec, name: 'Replacement' })
    expect(first.close).toHaveBeenCalled()
    expect(manager.list()).toHaveLength(1)
  })

  it('手动重连会重新连接', async () => {
    const connect = vi.fn(async () => undefined)
    const manager = new McpManager({
      createClient: () => fakeClient({ connect }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    const state = await manager.reconnect('srv-1')
    expect(state.status).toBe('connected')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('传输关闭后自动重连', async () => {
    vi.useFakeTimers()
    try {
      let closeListener: (() => void) | undefined
      const connect = vi.fn(async () => undefined)
      const manager = new McpManager({
        createClient: () =>
          fakeClient({
            connect,
            onClose(listener) {
              closeListener = listener
            },
          }),
        reconnect: { attempts: 2, initialDelayMs: 10, factor: 2, maxDelayMs: 100 },
      })
      await manager.add(spec)
      expect(manager.get('srv-1')?.status).toBe('connected')
      closeListener?.()
      expect(manager.get('srv-1')?.status).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(10)
      expect(connect).toHaveBeenCalledTimes(2)
      expect(manager.get('srv-1')?.status).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('调用失败时记录日志并转换错误', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          callTool: vi.fn(async () => Promise.reject(new Error('failure'))),
        }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    await expect(manager.call('srv-1', 'echo', {})).rejects.toMatchObject({
      code: 'mcp.call_failed',
    })
    expect(manager.logs('srv-1').at(-1)?.level).toBe('error')
  })

  it('关闭后忽略迟到的事件', async () => {
    let closeListener: (() => void) | undefined
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          onClose(listener) {
            closeListener = listener
          },
        }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    await manager.close()
    closeListener?.()
    expect(manager.list()).toEqual([])
  })

  it('自动重连次数用尽后进入错误状态', async () => {
    vi.useFakeTimers()
    try {
      let closeListener: (() => void) | undefined
      let attempts = 0
      const manager = new McpManager({
        createClient: () =>
          fakeClient({
            connect: vi.fn(async () => {
              attempts += 1
              if (attempts > 1) throw new Error('still down')
            }),
            onClose(listener) {
              closeListener = listener
            },
          }),
        reconnect: { attempts: 1, initialDelayMs: 5, factor: 2, maxDelayMs: 10 },
      })
      await manager.add(spec)
      closeListener?.()
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.get('srv-1')?.status).toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('重连时旧连接关闭失败不影响新连接', async () => {
    let first = true
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          close: vi.fn(async () => {
            if (first) {
              first = false
              throw new Error('close failed')
            }
          }),
        }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    expect((await manager.reconnect('srv-1')).status).toBe('connected')
  })

  it('get 对未知服务返回 undefined', () => {
    const manager = new McpManager({ createClient: () => fakeClient() })
    expect(manager.get('missing')).toBeUndefined()
  })

  it('McpError 没有说明时使用错误码', () => {
    expect(new McpError('mcp.code').message).toBe('mcp.code')
  })

  it('未注入 sleep 时使用默认的退避等待', async () => {
    const connect = vi
      .fn<McpClient['connect']>()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(undefined)
    const manager = new McpManager({
      createClient: () => fakeClient({ connect }),
      reconnect: { attempts: 2, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    expect((await manager.add(spec)).status).toBe('connected')
  })

  it('没有客户端时也能重连', async () => {
    let first = true
    const manager = new McpManager({
      createClient: () => {
        if (first) {
          first = false
          throw new Error('client unavailable')
        }
        return fakeClient()
      },
      sleep: async () => undefined,
      reconnect: { attempts: 1, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    expect((await manager.add(spec)).status).toBe('error')
    expect((await manager.reconnect('srv-1')).status).toBe('connected')
  })

  it('未连接的服务不提供工具', async () => {
    const manager = new McpManager({
      createClient: () => fakeClient({ connect: vi.fn(async () => Promise.reject('plain')) }),
      sleep: async () => undefined,
      reconnect: { attempts: 1, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
    })
    await manager.add(spec)
    expect(manager.tools()).toEqual([])
  })

  it('调用失败时非 Error 异常也会脱敏并转换', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          callTool: vi.fn(async () => Promise.reject(`bad ${SECRET}`)),
        }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    const error = await manager.call('srv-1', 'echo', {}).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).code).toBe('mcp.call_failed')
    expect((error as McpError).message).not.toContain(SECRET)
  })

  it('调用抛出 McpError 时原样返回', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          callTool: vi.fn(async () => Promise.reject(new McpError('mcp.custom', 'custom'))),
        }),
      sleep: async () => undefined,
    })
    await manager.add(spec)
    await expect(manager.call('srv-1', 'echo', {})).rejects.toMatchObject({ code: 'mcp.custom' })
  })

  it('stderr 多行日志按行记录并裁剪', async () => {
    let logListener: ((line: string) => void) | undefined
    const manager = new McpManager({
      createClient: () =>
        fakeClient({
          onLog(listener) {
            logListener = listener
          },
        }),
      sleep: async () => undefined,
    })
    await manager.add({ ...spec, maxLogLines: 3 })
    logListener?.('first\n\n  \nsecond')
    const logs = manager.logs('srv-1')
    expect(logs).toHaveLength(3)
    expect(logs.at(-1)?.message).toBe('stderr: second')
  })

  it('重试等待期间关闭后停止重试', async () => {
    const manager = new McpManager({
      createClient: () =>
        fakeClient({ connect: vi.fn(async () => Promise.reject(new Error('down'))) }),
      reconnect: { attempts: 3, initialDelayMs: 1, factor: 2, maxDelayMs: 2 },
      sleep: async () => {
        await manager.close()
      },
    })
    await manager.add(spec)
    expect(manager.list()).toEqual([])
  })
})

describe('contentToText', () => {
  it('converts every content kind', () => {
    expect(contentToText(undefined)).toBe('')
    expect(contentToText({ a: 1 })).toBe('{"a":1}')
    expect(
      contentToText([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png' },
        { type: 'audio', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file://a', text: 'body' } },
        { type: 'resource', resource: { uri: 'file://b', blob: 'x' } },
        { type: 'resource' },
        'raw',
        { type: 'unknown', value: 1 },
      ]),
    ).toBe(
      'hello\n[image image/png]\n[audio audio/wav]\nbody\n[resource file://b]\n[resource]\nraw\n{"type":"unknown","value":1}',
    )
  })

  it('缺失字段时使用占位文本', () => {
    expect(
      contentToText([
        { type: 'text' },
        { type: 'image' },
        { type: 'audio' },
        { type: 'resource', resource: {} },
      ]),
    ).toBe('\n[image unknown]\n[audio unknown]\n[resource unknown]')
  })
})
