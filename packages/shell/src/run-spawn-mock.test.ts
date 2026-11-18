import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { runCommand } = await import('./run.js')
const { ShellError } = await import('./run.js')

const tree = () => ({
  mechanism: 'taskkill' as const,
  detached: false,
  attach: vi.fn(),
  terminate: vi.fn(() => Promise.resolve()),
  dispose: vi.fn(),
})

class FakeChild extends EventEmitter {
  pid: number | undefined
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

describe('spawn 的异常路径', () => {
  it('spawn 同步抛出不带 code 的错误时包装为 shell.spawn_failed', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const processTree = tree()
    const error = await runCommand({ kind: 'cmd', exe: 'cmd.exe' }, 'echo', {
      cwd: process.cwd(),
      processTree: async () => processTree,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ShellError)
    expect(error).toMatchObject({ code: 'shell.spawn_failed' })
    expect((error as Error).message).toContain('(Error: boom)')
    expect(processTree.dispose).toHaveBeenCalledTimes(1)
  })

  it('启动后的 error 事件不影响结果，stdin 错误被忽略', async () => {
    const child = new FakeChild()
    child.pid = 4242
    spawnMock.mockImplementationOnce(() => child)
    const processTree = tree()
    const pending = runCommand({ kind: 'cmd', exe: 'cmd.exe' }, 'echo', {
      cwd: process.cwd(),
      timeoutMs: 0,
      processTree: async () => processTree,
    })
    // 等监听器挂好后再触发事件
    await new Promise((resolve) => setTimeout(resolve, 0))
    child.stdin.emit('error', new Error('EPIPE'))
    child.emit('error', new Error('late error'))
    child.emit('exit')
    child.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ exitCode: 0, aborted: false })
    expect(child.pid).toBe(4242)
    expect(processTree.attach).toHaveBeenCalledWith(4242)
    expect(processTree.dispose).toHaveBeenCalled()
  })

  it('结束进程树失败时直接杀掉 shell 进程', async () => {
    const child = new FakeChild()
    child.pid = 4243
    spawnMock.mockImplementationOnce(() => child)
    const processTree = tree()
    processTree.terminate.mockImplementationOnce(() =>
      Promise.reject(new Error('terminate failed')),
    )
    const pending = runCommand({ kind: 'cmd', exe: 'cmd.exe' }, 'echo', {
      cwd: process.cwd(),
      timeoutMs: 5,
      processTree: async () => processTree,
    })
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'), { interval: 1 })
    child.emit('exit')
    child.emit('close', 1, null)
    await expect(pending).resolves.toMatchObject({ timedOut: true, aborted: false })
    expect(processTree.terminate).toHaveBeenCalledTimes(1)
  })
})
