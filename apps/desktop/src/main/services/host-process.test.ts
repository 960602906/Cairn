import { describe, expect, it, vi } from 'vitest'
import { HOST_PORT_MESSAGE, portChannel, type MessagePortMainLike } from '../../shared/host-port.js'
import { createUtilityHostSpawner, type UtilityProcessLike } from './host-process.js'

function fakePort() {
  const listeners = new Set<(event: { data: unknown }) => void>()
  const port = {
    postMessage: vi.fn(),
    on: vi.fn((_event: 'message', l: (event: { data: unknown }) => void) => listeners.add(l)),
    removeListener: vi.fn((_event: 'message', l: (event: { data: unknown }) => void) =>
      listeners.delete(l),
    ),
    start: vi.fn(),
    close: vi.fn(),
  } satisfies MessagePortMainLike
  const deliver = (data: unknown) => listeners.forEach((l) => l({ data }))
  return { port, listeners, deliver }
}

function fakeChild() {
  let exitListener: ((code: number) => void) | undefined
  const child = {
    pid: 77,
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
    once: vi.fn((_event: 'exit', l: (code: number) => void) => (exitListener = l)),
  } satisfies UtilityProcessLike
  return { child, exit: (code: number) => exitListener?.(code) }
}

describe('portChannel', () => {
  it('posts to the port and unwraps message events', () => {
    const { port, listeners, deliver } = fakePort()
    const channel = portChannel(port)
    channel.post({ a: 1 })
    expect(port.postMessage).toHaveBeenCalledWith({ a: 1 })

    const received: unknown[] = []
    const off = channel.onMessage((m) => received.push(m))
    deliver('hello')
    expect(received).toEqual(['hello'])
    off()
    expect(listeners.size).toBe(0)
  })
})

describe('createUtilityHostSpawner', () => {
  it('forks the host and hands it a dedicated port', () => {
    const { child, exit } = fakeChild()
    const p1 = fakePort()
    const p2 = fakePort()
    const fork = vi.fn(() => child)
    const spawn = createUtilityHostSpawner({
      entry: '/app/out/main/agent-host.js',
      fork,
      createMessageChannel: () => ({ port1: p1.port, port2: p2.port }),
    })
    const proc = spawn('s1')

    expect(fork).toHaveBeenCalledWith('/app/out/main/agent-host.js', [], {
      serviceName: 'NEXUS-OS Agent Host',
    })
    expect(child.postMessage).toHaveBeenCalledWith({ type: HOST_PORT_MESSAGE }, [p2.port])
    expect(p1.port.start).toHaveBeenCalled()
    expect(proc.pid).toBe(77)

    proc.channel.post('ping')
    expect(p1.port.postMessage).toHaveBeenCalledWith('ping')

    const codes: number[] = []
    proc.onExit((code) => codes.push(code))
    proc.kill()
    expect(child.kill).toHaveBeenCalledTimes(1)

    exit(5)
    expect(codes).toEqual([5])
    expect(p1.port.close).toHaveBeenCalled()
    // 已退出的进程不再重复结束
    proc.kill()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
