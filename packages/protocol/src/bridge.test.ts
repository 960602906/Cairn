import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  PROTOCOL_VERSION,
  RpcError,
  createBridgeClient,
  createEndpoint,
  defineSide,
  exposeEndpoint,
  type RpcBridge,
  type RpcChannel,
} from './index.js'

function channelPair(): [RpcChannel, RpcChannel] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()]
  const make = (self: 0 | 1): RpcChannel => ({
    post(message) {
      const copy = structuredClone(message)
      queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((l) => l(copy)))
    },
    onMessage(listener) {
      listeners[self].add(listener)
      return () => listeners[self].delete(listener)
    },
  })
  return [make(0), make(1)]
}

const Main = defineSide({
  requests: {
    add: {
      params: z.object({ a: z.number(), b: z.number() }),
      result: z.object({ sum: z.number() }),
    },
    fail: { params: z.object({}), result: z.object({}) },
    crash: { params: z.object({}), result: z.object({}) },
  },
  events: { tick: z.object({ n: z.number() }) },
})
const Renderer = defineSide({ requests: {}, events: {} })

function connect() {
  const [a, b] = channelPair()
  const main = createEndpoint(a, { local: Main, remote: Renderer })
  const preload = createEndpoint(b, { local: Renderer, remote: Main })
  main.handle('add', ({ a, b }) => ({ sum: a + b }))
  main.handle('fail', () => {
    throw new RpcError('session.not_found', { sessionId: 's1' })
  })
  main.handle('crash', () => {
    throw new Error('secret details')
  })
  const bridge = exposeEndpoint(preload)
  return { main, preload, bridge, client: createBridgeClient<typeof Main>(bridge) }
}

/** contextBridge 只传递普通数据与函数：模拟它对结果做结构化克隆。 */
function overContextBridge(bridge: RpcBridge): RpcBridge {
  return {
    ready: async () => structuredClone(await bridge.ready()),
    request: async (m, p, o) => structuredClone(await bridge.request(m, p, o)),
    on: (name, listener) => bridge.on(name, (data) => listener(structuredClone(data))),
  }
}

describe('exposeEndpoint', () => {
  it('exposes plain functions only', () => {
    const { bridge } = connect()
    expect(Object.keys(bridge).sort()).toEqual(['on', 'ready', 'request'])
    for (const value of Object.values(bridge)) expect(typeof value).toBe('function')
  })

  it('returns results and error codes as plain data', async () => {
    const { bridge } = connect()
    expect(await bridge.ready()).toEqual({ ok: true, result: undefined })
    expect(await bridge.request('add', { a: 1, b: 2 })).toEqual({ ok: true, result: { sum: 3 } })
    expect(await bridge.request('fail', {})).toEqual({
      ok: false,
      error: { code: 'session.not_found', params: { sessionId: 's1' } },
    })
    // 内部错误不泄露细节
    expect(await bridge.request('crash', {})).toEqual({
      ok: false,
      error: { code: 'rpc.internal', params: { method: 'crash' } },
    })
  })

  it('rejects methods outside the contract and invalid params', async () => {
    const { bridge } = connect()
    expect(await bridge.request('fs.readFile', {})).toEqual({
      ok: false,
      error: { code: 'rpc.method_not_found', params: { method: 'fs.readFile' } },
    })
    expect(await bridge.request('add', { a: 'x' })).toEqual({
      ok: false,
      error: { code: 'rpc.invalid_params', params: { method: 'add' } },
    })
  })

  it('maps non-RpcError failures to rpc.internal', async () => {
    const endpoint = {
      ready: Promise.reject(new Error('boom')),
      request: () => {
        throw new TypeError('bad')
      },
      on: () => () => undefined,
    }
    endpoint.ready.catch(() => undefined)
    const bridge = exposeEndpoint(endpoint as never)
    expect(await bridge.ready()).toEqual({ ok: false, error: { code: 'rpc.internal' } })
    expect(await bridge.request('x', {})).toEqual({ ok: false, error: { code: 'rpc.internal' } })
  })

  it('reports a closed endpoint', async () => {
    const { preload, bridge } = connect()
    preload.close()
    expect(await bridge.ready()).toMatchObject({ ok: false, error: { code: 'rpc.closed' } })
  })
})

describe('createBridgeClient', () => {
  it('restores typed requests and RpcError across the bridge', async () => {
    const { bridge } = connect()
    const client = createBridgeClient<typeof Main>(overContextBridge(bridge))
    await expect(client.ready()).resolves.toBeUndefined()
    await expect(client.request('add', { a: 2, b: 3 })).resolves.toEqual({ sum: 5 })

    const error = await client.request('fail', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: 'session.not_found', params: { sessionId: 's1' } })
  })

  it('delivers events and unsubscribes', async () => {
    const { main, client } = connect()
    await client.ready()
    const seen: number[] = []
    const off = client.on('tick', ({ n }) => seen.push(n))
    main.emit('tick', { n: 1 })
    await new Promise((r) => setTimeout(r, 0))
    off()
    main.emit('tick', { n: 2 })
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([1])
  })

  it('rejects ready when the protocol handshake fails', async () => {
    const [a, b] = channelPair()
    a.onMessage(() => a.post({ kind: 'hello', protocolVersion: PROTOCOL_VERSION + 1, ack: true }))
    const client = createBridgeClient<typeof Main>(
      exposeEndpoint(createEndpoint(b, { local: Renderer, remote: Main })),
    )
    await expect(client.ready()).rejects.toMatchObject({ code: 'rpc.protocol_mismatch' })
  })
})
