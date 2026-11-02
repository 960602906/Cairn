import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type RpcBridge } from '@nexus/protocol'
import { API_KEY, RPC_CHANNEL } from '../shared/ipc.js'
import { createIpcChannel, exposeRendererApi, type IpcRendererLike } from './expose.js'

function fakeIpc() {
  const sent: unknown[] = []
  const listeners = new Set<(event: unknown, message: unknown) => void>()
  const ipc: IpcRendererLike = {
    send: (channel, message) => {
      expect(channel).toBe(RPC_CHANNEL)
      sent.push(message)
    },
    on: (channel, listener) => {
      expect(channel).toBe(RPC_CHANNEL)
      listeners.add(listener)
    },
    removeListener: (_channel, listener) => listeners.delete(listener),
  }
  const deliver = (message: unknown) => listeners.forEach((l) => l({}, message))
  return { ipc, sent, listeners, deliver }
}

function expose() {
  const { ipc, sent, listeners, deliver } = fakeIpc()
  const exposed = new Map<string, RpcBridge>()
  const api = exposeRendererApi({
    contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
    ipcRenderer: ipc,
  })
  return { api, exposed, sent, listeners, deliver }
}

describe('exposeRendererApi', () => {
  it('exposes only the bridge functions under window.nexus', () => {
    const { api, exposed } = expose()
    expect([...exposed.keys()]).toEqual([API_KEY])
    expect(exposed.get(API_KEY)).toBe(api)
    expect(Object.keys(api).sort()).toEqual(['on', 'ready', 'request'])
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
})
