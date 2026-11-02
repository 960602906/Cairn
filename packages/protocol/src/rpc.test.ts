import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  HostForMain,
  MainForHost,
  MainForRenderer,
  PROTOCOL_VERSION,
  RendererForMain,
  RpcError,
  RpcErrorCode,
  createEndpoint,
  defineSide,
  type RpcChannel,
} from './index.js'

/** 一对内存通道：异步投递、结构化克隆，模拟 MessagePort / Electron IPC。 */
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

/** 只记录发出的消息、可手动注入消息的“原始”对端，用于构造非法输入。 */
function rawPeer(channel: RpcChannel) {
  const received: unknown[] = []
  channel.onMessage((m) => received.push(m))
  return { received, send: (m: unknown) => channel.post(m) }
}

const Server = defineSide({
  requests: {
    add: {
      params: z.object({ a: z.number(), b: z.number() }),
      result: z.object({ sum: z.number() }),
    },
    fail: { params: z.object({}), result: z.object({}) },
    slow: { params: z.object({}), result: z.object({}) },
    bad: { params: z.object({}), result: z.object({ n: z.number() }) },
  },
  events: { tick: z.object({ n: z.number().int() }) },
})
const Client = defineSide({ requests: {}, events: {} })

function connect(options: { onProtocolError?: (e: RpcError, m: unknown) => void } = {}) {
  const [a, b] = channelPair()
  const server = createEndpoint(a, { local: Server, remote: Client, ...options })
  const client = createEndpoint(b, { local: Client, remote: Server, ...options })
  return { server, client }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('握手', () => {
  it('双方 ready', async () => {
    const { server, client } = connect()
    await expect(Promise.all([server.ready, client.ready])).resolves.toBeDefined()
  })

  it('对端晚于本端创建（错过第一次 hello）时仍能完成握手', async () => {
    const [a, b] = channelPair()
    const server = createEndpoint(a, { local: Server, remote: Client })
    await new Promise((r) => setTimeout(r, 0)) // server 的 hello 已投递但无人接收
    const client = createEndpoint(b, { local: Client, remote: Server })
    await expect(Promise.all([server.ready, client.ready])).resolves.toBeDefined()
  })

  it('协议版本不兼容时拒绝连接，请求以 protocol_mismatch 失败', async () => {
    const [a, b] = channelPair()
    const peer = rawPeer(b)
    const client = createEndpoint(a, { local: Client, remote: Server })
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION + 1, ack: false })
    await expect(client.ready).rejects.toMatchObject({
      code: RpcErrorCode.ProtocolMismatch,
      params: { local: PROTOCOL_VERSION, remote: PROTOCOL_VERSION + 1 },
    })
    await expect(client.request('add', { a: 1, b: 2 })).rejects.toMatchObject({
      code: RpcErrorCode.ProtocolMismatch,
    })
  })
})

describe('请求 / 响应', () => {
  it('类型化调用并返回结果', async () => {
    const { server, client } = connect()
    server.handle('add', ({ a, b }) => ({ sum: a + b }))
    await expect(client.request('add', { a: 1, b: 2 })).resolves.toEqual({ sum: 3 })
  })

  it('并发请求按 id 对应', async () => {
    const { server, client } = connect()
    server.handle('add', async ({ a, b }) => {
      await new Promise((r) => setTimeout(r, a))
      return { sum: a + b }
    })
    const results = await Promise.all([
      client.request('add', { a: 5, b: 0 }),
      client.request('add', { a: 1, b: 0 }),
    ])
    expect(results).toEqual([{ sum: 5 }, { sum: 1 }])
  })

  it('超时', async () => {
    vi.useFakeTimers()
    const { server, client } = connect()
    server.handle('slow', () => new Promise(() => undefined))
    const pending = client.request('slow', {}, { timeoutMs: 1000 })
    const assertion = expect(pending).rejects.toMatchObject({
      code: RpcErrorCode.Timeout,
      params: { method: 'slow', timeoutMs: 1000 },
    })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('调用方参数校验失败时不发送请求', async () => {
    const { server, client } = connect()
    const handler = vi.fn(() => ({ sum: 0 }))
    server.handle('add', handler)
    // @ts-expect-error 故意传入错误类型
    await expect(client.request('add', { a: 'x', b: 2 })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('接收方校验参数：绕过类型的非法请求返回 invalid_params', async () => {
    const [a, b] = channelPair()
    const onProtocolError = vi.fn()
    const server = createEndpoint(a, { local: Server, remote: Client, onProtocolError })
    const handler = vi.fn(() => ({ sum: 0 }))
    server.handle('add', handler)
    const peer = rawPeer(b)
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: false })
    peer.send({ kind: 'request', id: '1', method: 'add', params: { a: 'x' } })
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({
        kind: 'response',
        id: '1',
        ok: false,
        error: { code: RpcErrorCode.InvalidParams, params: { method: 'add' } },
      }),
    )
    expect(handler).not.toHaveBeenCalled()
    expect(onProtocolError).toHaveBeenCalled()
  })

  it('未注册处理函数时返回 method_not_found', async () => {
    const { client } = connect()
    await expect(client.request('add', { a: 1, b: 2 })).rejects.toMatchObject({
      code: RpcErrorCode.MethodNotFound,
    })
  })

  it('处理函数抛出 RpcError 时原样返回错误码与参数', async () => {
    const { server, client } = connect()
    server.handle('fail', () => {
      throw new RpcError('session.not_found', { sessionId: 's1' })
    })
    await expect(client.request('fail', {})).rejects.toMatchObject({
      code: 'session.not_found',
      params: { sessionId: 's1' },
    })
  })

  it('处理函数抛出其他错误时返回 rpc.internal，不泄露错误信息', async () => {
    const { server, client } = connect()
    server.handle('fail', () => {
      throw new Error('secret path C:\\Users\\me')
    })
    const error = await client.request('fail', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: RpcErrorCode.Internal, params: { method: 'fail' } })
  })

  it('处理函数返回非法结果时调用方收到 rpc.internal', async () => {
    const { server, client } = connect()
    // @ts-expect-error 故意返回错误类型
    server.handle('bad', () => ({ n: 'x' }))
    await expect(client.request('bad', {})).rejects.toMatchObject({ code: RpcErrorCode.Internal })
  })

  it('调用方校验响应：对端返回非法结果时以 invalid_result 失败', async () => {
    const [a, b] = channelPair()
    const client = createEndpoint(a, { local: Client, remote: Server })
    const peer = rawPeer(b)
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    const pending = client.request('bad', {})
    await vi.waitFor(() =>
      expect(peer.received.some((m) => (m as { kind: string }).kind === 'request')).toBe(true),
    )
    const request = peer.received.find((m) => (m as { kind: string }).kind === 'request') as {
      id: string
    }
    peer.send({ kind: 'response', id: request.id, ok: true, result: { n: 'x' } })
    await expect(pending).rejects.toMatchObject({ code: RpcErrorCode.InvalidResult })
  })

  it('关闭端点时未完成的请求以 rpc.closed 失败，之后的请求也失败', async () => {
    const { server, client } = connect()
    server.handle('slow', () => new Promise(() => undefined))
    await client.ready
    const pending = client.request('slow', {}, { timeoutMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    client.close()
    await expect(pending).rejects.toMatchObject({ code: RpcErrorCode.Closed })
    await expect(client.request('slow', {})).rejects.toMatchObject({ code: RpcErrorCode.Closed })
  })
})

describe('事件', () => {
  it('发出并接收类型化事件，可取消订阅', async () => {
    const { server, client } = connect()
    const received: number[] = []
    const off = client.on('tick', ({ n }) => received.push(n))
    await Promise.all([server.ready, client.ready])
    server.emit('tick', { n: 1 })
    await vi.waitFor(() => expect(received).toEqual([1]))
    off()
    server.emit('tick', { n: 2 })
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toEqual([1])
  })

  it('发出非法事件时抛出 invalid_params', () => {
    const { server } = connect()
    expect(() => server.emit('tick', { n: 1.5 })).toThrow(RpcError)
  })

  it('收到未知事件或非法消息时报告协议错误，不调用监听器', async () => {
    const [a, b] = channelPair()
    const onProtocolError = vi.fn()
    const client = createEndpoint(a, { local: Client, remote: Server, onProtocolError })
    const listener = vi.fn()
    client.on('tick', listener)
    const peer = rawPeer(b)
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    peer.send({ kind: 'event', name: 'boom', data: {} })
    peer.send({ kind: 'event', name: 'tick', data: { n: 'x' } })
    peer.send({ nonsense: true })
    await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledTimes(3))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('实际接口定义', () => {
  const event = {
    v: 1 as const,
    sessionId: 's1',
    runId: 'r1',
    seq: 1,
    ts: 1,
    type: 'turn.started' as const,
    payload: {},
  }

  it('渲染 ↔ 主：session.subscribe 返回补发事件，session.events 推送事件', async () => {
    const [a, b] = channelPair()
    const main = createEndpoint(a, { local: MainForRenderer, remote: RendererForMain })
    const renderer = createEndpoint(b, { local: RendererForMain, remote: MainForRenderer })
    main.handle('session.subscribe', ({ afterSeq }) => ({
      events: afterSeq < 1 ? [event] : [],
      lastSeq: 1,
    }))
    await expect(
      renderer.request('session.subscribe', { sessionId: 's1', afterSeq: 0 }),
    ).resolves.toEqual({
      events: [event],
      lastSeq: 1,
    })
    const pushed = vi.fn()
    renderer.on('session.events', pushed)
    main.emit('session.events', { sessionId: 's1', events: [{ ...event, seq: 2 }] })
    await vi.waitFor(() =>
      expect(pushed).toHaveBeenCalledWith({ sessionId: 's1', events: [{ ...event, seq: 2 }] }),
    )
  })

  it('主 ↔ 宿主：host.init 携带历史，host.event 推送无 seq 事件', async () => {
    const [a, b] = channelPair()
    const main = createEndpoint(a, { local: MainForHost, remote: HostForMain })
    const host = createEndpoint(b, { local: HostForMain, remote: MainForHost })
    const init = vi.fn(() => ({}))
    host.handle('host.init', init)
    await main.request('host.init', {
      sessionId: 's1',
      runId: 'r1',
      workspacePath: '/work',
      agent: { id: 'builtin.coder', version: 1 },
      model: { providerId: 'fake', modelId: 'fake' },
      mode: 'interactive',
      limits: { maxStepsPerTurn: 50, maxTurnDurationMs: 1000, maxConsecutiveToolErrors: 5 },
      history: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], ts: 1 }],
    })
    expect(init).toHaveBeenCalledOnce()

    const received = vi.fn()
    main.on('host.event', received)
    const { seq: _seq, ...unsequenced } = event
    host.emit('host.event', { event: unsequenced })
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ event: unsequenced }))
    // 宿主即使带上 seq 也会被丢弃：seq 只能由主进程分配。
    host.emit('host.event', { event })
    await vi.waitFor(() => expect(received).toHaveBeenLastCalledWith({ event: unsequenced }))
  })
})
