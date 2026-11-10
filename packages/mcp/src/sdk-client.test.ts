import { describe, expect, it } from 'vitest'
import { createSdkClient, stdioCommand } from './index.js'

const unreachable = 'http://127.0.0.1:1/mcp'

describe('createSdkClient（HTTP 传输）', () => {
  it('没有请求头时创建传输，连接失败会抛错', async () => {
    const client = createSdkClient({
      serverId: 'remote',
      name: 'Remote',
      transport: { kind: 'http', url: unreachable },
      connectTimeoutMs: 1_000,
    })
    client.onClose?.(() => undefined)
    await expect(client.connect()).rejects.toBeTruthy()
    await client.close().catch(() => undefined)
  })

  it('带请求头时同样能创建传输', async () => {
    const client = createSdkClient({
      serverId: 'remote',
      name: 'Remote',
      transport: { kind: 'http', url: unreachable, headers: { 'X-Key': 'value' } },
      connectTimeoutMs: 1_000,
    })
    await expect(client.connect()).rejects.toBeTruthy()
    await client.close().catch(() => undefined)
  })
})

describe('createSdkClient（stdio 传输）', () => {
  it('空白 stderr 行不会触发日志回调', async () => {
    const logs: string[] = []
    const client = createSdkClient({
      serverId: 'blank',
      name: 'Blank',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("\\n")'],
      },
      connectTimeoutMs: 1_000,
    })
    client.onLog?.((line) => logs.push(line))
    await expect(client.connect()).rejects.toBeTruthy()
    await client.close().catch(() => undefined)
    expect(logs).toEqual([])
  })
})

describe('stdioCommand', () => {
  it('Windows 上 npx 这类脚本经 cmd.exe 启动，.exe 直接启动', () => {
    expect(stdioCommand('npx', ['-y', 'pkg'], 'win32', 'C:\\Windows\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/c', 'npx', '-y', 'pkg'],
    })
    expect(stdioCommand('uvx', [], 'win32', '')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/c', 'uvx'],
    })
    expect(stdioCommand('C:\\tools\\server.EXE', ['a'], 'win32', 'cmd.exe')).toEqual({
      command: 'C:\\tools\\server.EXE',
      args: ['a'],
    })
  })

  it('其他平台原样启动', () => {
    expect(stdioCommand('npx', ['-y', 'pkg'], 'linux')).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
    })
    expect(stdioCommand('npx', [])).toEqual(
      process.platform === 'win32'
        ? { command: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/c', 'npx'] }
        : { command: 'npx', args: [] },
    )
  })
})
