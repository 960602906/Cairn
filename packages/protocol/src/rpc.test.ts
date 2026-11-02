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

describe('边界情况', () => {
  /** 已完成握手的客户端端点 + 原始对端。 */
  async function clientWithRawPeer() {
    const [a, b] = channelPair()
    const onProtocolError = vi.fn()
    const client = createEndpoint(a, { local: Client, remote: Server, onProtocolError })
    const peer = rawPeer(b)
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    await client.ready
    return { client, peer, onProtocolError }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0))
  const requestsOf = (received: unknown[]) =>
    received.filter((m) => (m as { kind: string }).kind === 'request') as {
      id: string
      method: string
    }[]

  it('RpcError.toInfo：无参数时不带 params 字段', () => {
    expect(new RpcError('x').toInfo()).toEqual({ code: 'x' })
    expect(new RpcError('x', { a: 1 }).toInfo()).toEqual({ code: 'x', params: { a: 1 } })
  })

  it('握手完成前收到的请求返回 protocol_mismatch，不调用处理函数', async () => {
    const [a, b] = channelPair()
    const server = createEndpoint(a, { local: Server, remote: Client })
    const handler = vi.fn(() => ({ sum: 0 }))
    server.handle('add', handler)
    const peer = rawPeer(b)
    peer.send({ kind: 'request', id: '1', method: 'add', params: { a: 1, b: 1 } })
    await vi.waitFor(() =>
      expect(peer.received).toContainEqual({
        kind: 'response',
        id: '1',
        ok: false,
        error: { code: RpcErrorCode.ProtocolMismatch },
      }),
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('握手完成前收到的事件被忽略', async () => {
    const [a, b] = channelPair()
    const onProtocolError = vi.fn()
    const client = createEndpoint(a, { local: Client, remote: Server, onProtocolError })
    const listener = vi.fn()
    client.on('tick', listener)
    rawPeer(b).send({ kind: 'event', name: 'tick', data: { n: 1 } })
    await tick()
    expect(listener).not.toHaveBeenCalled()
    expect(onProtocolError).not.toHaveBeenCalled()
  })

  it('重复的 hello 被忽略，不重复回复确认', async () => {
    const { peer } = await clientWithRawPeer()
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION + 1, ack: true })
    await tick()
    const hellos = peer.received.filter((m) => (m as { kind: string }).kind === 'hello')
    expect(hellos).toEqual([{ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: false }])
  })

  it('未知 id 的响应被忽略，后续请求不受影响', async () => {
    const { client, peer } = await clientWithRawPeer()
    peer.send({ kind: 'response', id: 'nope', ok: true, result: { sum: 1 } })
    const pending = client.request('add', { a: 1, b: 1 })
    await vi.waitFor(() => expect(requestsOf(peer.received)).toHaveLength(1))
    peer.send({
      kind: 'response',
      id: requestsOf(peer.received)[0]!.id,
      ok: true,
      result: { sum: 2 },
    })
    await expect(pending).resolves.toEqual({ sum: 2 })
  })

  it('超时之后才到达的响应被忽略', async () => {
    vi.useFakeTimers()
    const { client, peer } = await clientWithRawPeer()
    const pending = client.request('add', { a: 1, b: 1 }, { timeoutMs: 10 })
    const assertion = expect(pending).rejects.toMatchObject({ code: RpcErrorCode.Timeout })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    peer.send({
      kind: 'response',
      id: requestsOf(peer.received)[0]!.id,
      ok: true,
      result: { sum: 2 },
    })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('timeoutMs 为 0 时不设置计时器，响应正常返回', async () => {
    const { client, peer } = await clientWithRawPeer()
    const pending = client.request('add', { a: 1, b: 1 }, { timeoutMs: 0 })
    await vi.waitFor(() => expect(requestsOf(peer.received)).toHaveLength(1))
    peer.send({
      kind: 'response',
      id: requestsOf(peer.received)[0]!.id,
      ok: true,
      result: { sum: 2 },
    })
    await expect(pending).resolves.toEqual({ sum: 2 })
  })

  it('对端返回错误响应时以对应错误码失败', async () => {
    const { client, peer } = await clientWithRawPeer()
    const pending = client.request('add', { a: 1, b: 1 })
    await vi.waitFor(() => expect(requestsOf(peer.received)).toHaveLength(1))
    peer.send({
      kind: 'response',
      id: requestsOf(peer.received)[0]!.id,
      ok: false,
      error: { code: 'session.not_found' },
    })
    await expect(pending).rejects.toMatchObject({ code: 'session.not_found' })
  })

  it('请求对端未定义的方法时在本地失败，不发送', async () => {
    const { client, peer } = await clientWithRawPeer()
    const untyped = client as unknown as { request(m: string, p: unknown): Promise<unknown> }
    await expect(untyped.request('missing', {})).rejects.toMatchObject({
      code: RpcErrorCode.MethodNotFound,
      params: { method: 'missing' },
    })
    expect(requestsOf(peer.received)).toHaveLength(0)
  })

  it('发出本端未定义的事件时抛出 method_not_found', () => {
    const { server } = connect()
    const untyped = server as unknown as { emit(n: string, d: unknown): void }
    expect(() => untyped.emit('missing', {})).toThrow(
      expect.objectContaining({ code: RpcErrorCode.MethodNotFound }),
    )
  })

  it('同一事件可有多个监听器；没有监听器时事件被静默丢弃', async () => {
    const { server, client } = connect()
    await Promise.all([server.ready, client.ready])
    server.emit('tick', { n: 0 }) // 尚无监听器
    await tick()
    const first = vi.fn()
    const second = vi.fn()
    client.on('tick', first)
    client.on('tick', second)
    server.emit('tick', { n: 1 })
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith({ n: 1 }))
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('关闭时清除计时器；关闭后不再发送任何消息；重复关闭无副作用', async () => {
    vi.useFakeTimers()
    const { client, peer } = await clientWithRawPeer()
    const pending = client.request('add', { a: 1, b: 1 }, { timeoutMs: 1000 })
    const assertion = expect(pending).rejects.toMatchObject({ code: RpcErrorCode.Closed })
    await vi.advanceTimersByTimeAsync(0)
    client.close()
    client.close()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
    const before = peer.received.length
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(peer.received).toHaveLength(before)
  })

  it('处理函数执行期间端点被关闭时不再发送响应', async () => {
    const [a, b] = channelPair()
    const server = createEndpoint(a, { local: Server, remote: Client })
    let release!: () => void
    server.handle('slow', () => new Promise<Record<string, never>>((r) => (release = () => r({}))))
    const peer = rawPeer(b)
    peer.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    peer.send({ kind: 'request', id: '1', method: 'slow', params: {} })
    await vi.waitFor(() => expect(release).toBeDefined())
    server.close()
    release()
    await tick()
    expect(peer.received.some((m) => (m as { kind: string }).kind === 'response')).toBe(false)
  })
})
