import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type RpcBridge } from '@cairn/protocol'
import { API_KEY, RPC_CHANNEL } from '../shared/ipc.js'
import { createIpcChannel, exposeRendererApi, type IpcRendererLike } from './expose.js'
import { WINDOW_CONTROLS_CHANNEL } from '../shared/window-controls.js'

function fakeIpc() {
  const sent: unknown[] = []
  const listeners = new Set<(event: unknown, message: unknown) => void>()
  const windowListeners = new Map<string, Set<(event: unknown, message: unknown) => void>>()
  const invoked: string[] = []
  const ipc: IpcRendererLike = {
    send: (channel, message) => {
      expect(channel).toBe(RPC_CHANNEL)
      sent.push(message)
    },
    invoke: async (channel) => {
      expect(Object.values(WINDOW_CONTROLS_CHANNEL)).toContain(channel)
      invoked.push(channel)
      return (
        channel !== WINDOW_CONTROLS_CHANNEL.minimize && channel !== WINDOW_CONTROLS_CHANNEL.close
      )
    },
    on: (channel, listener) => {
      if (channel === RPC_CHANNEL) {
        listeners.add(listener)
        return
      }
      const set = windowListeners.get(channel) ?? new Set()
      set.add(listener)
      windowListeners.set(channel, set)
    },
    removeListener: (channel, listener) => {
      if (channel === RPC_CHANNEL) listeners.delete(listener)
      else windowListeners.get(channel)?.delete(listener)
    },
  }
  const deliver = (message: unknown) => listeners.forEach((l) => l({}, message))
  const deliverWindow = (channel: string, value: unknown) =>
    windowListeners.get(channel)?.forEach((listener) => listener({}, value))
  return { ipc, sent, listeners, deliver, invoked, deliverWindow, windowListeners }
}

function expose() {
  const fake = fakeIpc()
  const { ipc } = fake
  const exposed = new Map<string, RpcBridge>()
  const api = exposeRendererApi({
    contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
    ipcRenderer: ipc,
    platform: 'win32',
  })
  return { api, exposed, ...fake }
}

describe('exposeRendererApi', () => {
  it('exposes only the bridge functions under window.cairn', () => {
    const { api, exposed } = expose()
    expect([...exposed.keys()]).toEqual([API_KEY])
    expect(exposed.get(API_KEY)).toBe(api)
    expect(Object.keys(api).sort()).toEqual(['on', 'ready', 'request', 'windowControls'])
    expect(api.windowControls.platform).toBe('win32')
    expect(api).not.toHaveProperty('send')
    expect(api).not.toHaveProperty('ipcRenderer')
  })

  it('starts the protocol handshake on the RPC channel', () => {
    const { sent } = expose()
    expect(sent).toEqual([{ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: false }])
  })

  it('sends validated requests to the main process and returns responses', async () => {
    const { api, sent, deliver } = expose()
    deliver({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    expect(await api.ready()).toEqual({ ok: true, result: undefined })

    const pending = api.request('session.list', {})
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ kind: 'request', method: 'session.list', params: {} })
    const { id } = sent[1] as { id: string }
    deliver({ kind: 'response', id, ok: true, result: { sessions: [] } })
    expect(await pending).toEqual({ ok: true, result: { sessions: [] } })
  })

  it('refuses methods outside MainForRenderer without sending them', async () => {
    const { api, sent, deliver } = expose()
    deliver({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    expect(await api.request('credentials.get', {})).toMatchObject({
      ok: false,
      error: { code: 'rpc.method_not_found' },
    })
    expect(sent).toHaveLength(1)
  })

  it('removes the IPC listener when the endpoint unsubscribes', () => {
    const { ipc, listeners } = fakeIpc()
    const channel = createIpcChannel(ipc)
    const off = channel.onMessage(() => undefined)
    expect(listeners.size).toBe(1)
    off()
    expect(listeners.size).toBe(0)
  })

  it('routes window controls through fixed channels only', async () => {
    const { api, invoked, deliverWindow, windowListeners } = expose()
    await api.windowControls.minimize()
    expect(await api.windowControls.toggleMaximize()).toBe(true)
    await api.windowControls.close()
    expect(await api.windowControls.isMaximized()).toBe(true)
    expect(invoked).toEqual([
      WINDOW_CONTROLS_CHANNEL.minimize,
      WINDOW_CONTROLS_CHANNEL.toggleMaximize,
      WINDOW_CONTROLS_CHANNEL.close,
      WINDOW_CONTROLS_CHANNEL.isMaximized,
    ])

    const listener = vi.fn()
    const off = api.windowControls.onMaximizedChange(listener)
    deliverWindow(WINDOW_CONTROLS_CHANNEL.maximizedChanged, true)
    deliverWindow(WINDOW_CONTROLS_CHANNEL.maximizedChanged, 'ignored')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(true)
    off()
    expect(windowListeners.get(WINDOW_CONTROLS_CHANNEL.maximizedChanged)?.size ?? 0).toBe(0)
  })
})
