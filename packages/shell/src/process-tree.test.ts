import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Kernel32 } from './job-object.js'
import { createProcessTree, defaultTaskKill, resetProcessTreeCache } from './process-tree.js'

afterEach(() => resetProcessTreeCache())

const layout = { size: 144, limitFlagsOffset: 16 }

function fakeKernel32(overrides: Partial<Kernel32> = {}): Kernel32 {
  return {
    CreateJobObjectW: () => ({}),
    SetInformationJobObject: () => 1,
    OpenProcess: () => ({}),
    AssignProcessToJobObject: () => 1,
    TerminateJobObject: vi.fn(() => 1),
    CloseHandle: vi.fn(() => 1),
    ...overrides,
  }
}

describe('Windows', () => {
  it('作业对象：放入后 terminate 结束作业，dispose 关闭句柄；不用 taskkill', async () => {
    const kernel32 = fakeKernel32()
    const taskkill = vi.fn(() => Promise.resolve())
    const tree = await createProcessTree({
      platform: 'win32',
      kernel32: () => Promise.resolve({ kernel32, layout }),
      taskkill,
    })
    expect(tree).toMatchObject({ mechanism: 'job-object', detached: false })
    tree.attach(42)
    expect(tree.mechanism).toBe('job-object')
    await tree.terminate()
    expect(kernel32.TerminateJobObject).toHaveBeenCalledTimes(1)
    tree.dispose()
    expect(kernel32.CloseHandle).toHaveBeenCalled()
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('放入作业失败时回退到 taskkill', async () => {
    const kernel32 = fakeKernel32({ AssignProcessToJobObject: () => 0 })
    const taskkill = vi.fn(() => Promise.resolve())
    const tree = await createProcessTree({
      platform: 'win32',
      kernel32: () => Promise.resolve({ kernel32, layout }),
      taskkill,
    })
    tree.attach(42)
    expect(tree.mechanism).toBe('taskkill')
    await tree.terminate()
    expect(taskkill).toHaveBeenCalledWith(42)
    expect(kernel32.TerminateJobObject).not.toHaveBeenCalled()
    tree.dispose()
  })

  it('作业结束失败时也用 taskkill', async () => {
    const kernel32 = fakeKernel32({ TerminateJobObject: () => 0 })
    const taskkill = vi.fn(() => Promise.resolve())
    const tree = await createProcessTree({
      platform: 'win32',
      kernel32: () => Promise.resolve({ kernel32, layout }),
      taskkill,
    })
    await tree.terminate() // 还没有进程
    expect(taskkill).not.toHaveBeenCalled()
    tree.attach(7)
    await tree.terminate()
    expect(taskkill).toHaveBeenCalledWith(7)
  })

  it('koffi 加载失败或不用作业对象时用 taskkill；加载只尝试一次', async () => {
    const load = vi.fn(() => Promise.reject(new Error('no koffi')))
    const taskkill = vi.fn(() => Promise.resolve())
    for (let i = 0; i < 2; i++) {
      const tree = await createProcessTree({ platform: 'win32', kernel32: load, taskkill })
      expect(tree.mechanism).toBe('taskkill')
    }
    expect(load).toHaveBeenCalledTimes(1)
    const tree = await createProcessTree({ platform: 'win32', kernel32: undefined, taskkill })
    expect(tree.mechanism).toBe('taskkill')
    tree.attach(3)
    await tree.terminate()
    expect(taskkill).toHaveBeenCalledWith(3)
  })

  it('创建作业失败时用 taskkill', async () => {
    const kernel32 = fakeKernel32({ CreateJobObjectW: () => null })
    const tree = await createProcessTree({
      platform: 'win32',
      kernel32: () => Promise.resolve({ kernel32, layout }),
    })
    expect(tree.mechanism).toBe('taskkill')
  })

  it('默认的 taskkill：可执行文件不存在时也正常返回', async () => {
    await expect(defaultTaskKill({ SystemRoot: '/no-such-dir' })(1)).resolves.toBeUndefined()
  })
})

describe('其他平台', () => {
  it('进程组：terminate 与 dispose 向进程组发信号，进程组不存在时忽略', async () => {
    const killGroup = vi.fn<(pid: number) => void>()
    const tree = await createProcessTree({ platform: 'linux', killGroup })
    expect(tree).toMatchObject({ mechanism: 'process-group', detached: true })
    await tree.terminate() // 还没有进程
    expect(killGroup).not.toHaveBeenCalled()
    tree.attach(5)
    await tree.terminate()
    expect(killGroup).toHaveBeenCalledWith(5)
    killGroup.mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    tree.dispose()
    expect(killGroup).toHaveBeenCalledTimes(2)
    tree.dispose()
    expect(killGroup).toHaveBeenCalledTimes(2)
  })
})
