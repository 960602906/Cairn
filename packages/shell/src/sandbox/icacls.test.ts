import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { createIcaclsRunner, icaclsPath } = await import('./icacls.js')

describe('createIcaclsRunner', () => {
  it('close 事件没有退出码（被信号结束）时按失败处理', async () => {
    const child = new EventEmitter()
    spawnMock.mockImplementationOnce(() => child)
    const run = createIcaclsRunner({ exe: 'icacls.exe' })
    const pending = run(['/grant', 'x'])
    child.emit('close', null)
    await expect(pending).resolves.toBe(1)
    expect(spawnMock).toHaveBeenCalledWith('icacls.exe', ['/grant', 'x'], expect.any(Object))
  })

  it('提供 run 时直接使用，不再启动进程', async () => {
    const custom = vi.fn(async () => 7)
    await expect(createIcaclsRunner({ run: custom })(['/T'])).resolves.toBe(7)
    expect(custom).toHaveBeenCalledWith(['/T'])
    expect(icaclsPath({ SYSTEMROOT: 'D:\\Win' })).toMatch(/icacls\.exe$/)
  })
})
