import { describe, expect, it, vi } from 'vitest'
import { RPC_CHANNEL } from '../../shared/ipc.js'
import {
  checkIpcSender,
  createRendererChannel,
  type IpcMainEventLike,
  type IpcMainLike,
} from './renderer-transport.js'

const policy = { rendererUrl: 'file:///app/out/renderer/index.html' }
const appUrl = 'file:///app/out/renderer/index.html#/s1'

function event(id: number, url: string | null, parent: unknown = null): IpcMainEventLike {
  return { sender: { id }, senderFrame: url === null ? null : { url, parent } }
}

function fakeIpcMain() {
  const listeners = new Set<Parameters<IpcMainLike['on']>[1]>()
  const ipcMain: IpcMainLike = {
    on: (channel, listener) => {
      expect(channel).toBe(RPC_CHANNEL)
      listeners.add(listener)
    },
    removeListener: (_channel, listener) => listeners.delete(listener),
  }
  const emit = (e: IpcMainEventLike, message: unknown) => listeners.forEach((l) => l(e, message))
  return { ipcMain, listeners, emit }
}

describe('checkIpcSender', () => {
  it('accepts the main frame of the app page only', () => {
    expect(checkIpcSender(event(1, appUrl), policy)).toBeUndefined()
    expect(checkIpcSender(event(1, null), policy)).toBe('no_frame')
    expect(checkIpcSender(event(1, appUrl, {}), policy)).toBe('subframe')
    expect(checkIpcSender(event(1, 'https://evil.example/'), policy)).toBe('untrusted_url')
  })
})

describe('createRendererChannel', () => {
  it('delivers messages from its own window and rejects the rest', () => {
    const { ipcMain, emit } = fakeIpcMain()
    const onRejected = vi.fn()
    const channel = createRendererChannel({
      ipcMain,
      contents: { id: 7, send: vi.fn(), isDestroyed: () => false },
      policy,
      onRejected,
    })
    const received: unknown[] = []
    channel.onMessage((m) => received.push(m))

    emit(event(7, appUrl), 'ok')
    emit(event(8, appUrl), 'other window')
    emit(event(7, 'https://evil.example/'), 'navigated away')
    emit(event(7, appUrl, {}), 'iframe')
    expect(received).toEqual(['ok'])
    expect(onRejected.mock.calls).toEqual([
      ['untrusted_url', 'https://evil.example/'],
      ['subframe', appUrl],
    ])
  })

  it('works without a rejection handler and removes its listener', () => {
    const { ipcMain, listeners, emit } = fakeIpcMain()
    const channel = createRendererChannel({
      ipcMain,
      contents: { id: 1, send: vi.fn(), isDestroyed: () => false },
      policy,
    })
    const off = channel.onMessage(() => undefined)
    emit(event(1, null), 'dropped')
    expect(listeners.size).toBe(1)
    off()
    expect(listeners.size).toBe(0)
  })

  it('sends to the window until it is destroyed', () => {
    let destroyed = false
    const send = vi.fn()
    const channel = createRendererChannel({
      ipcMain: fakeIpcMain().ipcMain,
      contents: { id: 1, send, isDestroyed: () => destroyed },
      policy,
    })
    channel.post({ kind: 'hello' })
    destroyed = true
    channel.post({ kind: 'late' })
    expect(send.mock.calls).toEqual([[RPC_CHANNEL, { kind: 'hello' }]])
  })
})
