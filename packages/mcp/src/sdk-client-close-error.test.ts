import { describe, expect, it, vi } from 'vitest'

// SDK 的 Client.close() 在已断开时总是成功；要覆盖“关闭也失败”的兜底路径只能替换它。
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose: (() => void) | undefined
    async connect(): Promise<void> {
      throw new Error('connect failed')
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: [] }
    }
    async callTool(): Promise<unknown> {
      return {}
    }
    async close(): Promise<void> {
      throw new Error('close failed')
    }
  },
}))

import { createSdkClient } from './index.js'

describe('createSdkClient 关闭失败', () => {
  it('连接与关闭都失败时仍能结束', async () => {
    const client = createSdkClient({
      serverId: 'broken',
      name: 'Broken',
      transport: { kind: 'http', url: 'http://127.0.0.1:1/mcp' },
    })
    await expect(client.connect()).rejects.toThrow('connect failed')
    await expect(client.close()).resolves.toBeUndefined()
  })
})
