import { spawnSync } from 'node:child_process'
import type * as NodeChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSdkClient, stdioCommand, terminateProcessTree } from './index.js'

// 只替换 spawnSync，避免在 Windows 上真实启动 taskkill；其余 child_process 保持原样，
// 因为 SDK 的 stdio 传输自己会用到 spawn。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      signal: null,
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    })),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('terminateProcessTree', () => {
  it('pid 为 null 时不做任何事', () => {
    const spawn = vi.mocked(spawnSync)
    spawn.mockClear()
    const kill = vi.spyOn(process, 'kill')
    terminateProcessTree(null, 'win32')
    terminateProcessTree(null, 'linux')
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('Windows 用 taskkill /T /F 结束进程树', () => {
    const spawn = vi.mocked(spawnSync)
    spawn.mockClear()
    terminateProcessTree(4321, 'win32')
    expect(spawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' }),
    )
  })

  it('非 Windows 向进程发 SIGTERM', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    terminateProcessTree(4321, 'linux')
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM')
  })

  it('非 Windows 结束已退出进程时吞掉错误', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    expect(() => terminateProcessTree(4321, 'darwin')).not.toThrow()
  })
})
