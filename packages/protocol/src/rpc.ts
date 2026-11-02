/**
 * 类型化、带版本的进程间通信（ADR-0009，架构 §15）。
 *
 * 与传输无关：渲染↔主（Electron IPC）与主↔宿主（MessagePort）共用同一实现，
 * 只需提供一个 RpcChannel（发送与接收原始消息）。
 *
 * - 两类消息：带 id 的请求/响应（可超时）与单向事件。
 * - 收发两端都做运行时校验；校验失败返回明确的错误码。
 * - 建立连接时交换协议版本，不兼容时拒绝连接。
 */
import { z } from 'zod'
import { ErrorInfo, Id } from './common.js'

/** IPC 协议版本。消息定义出现不兼容变化时提升。 */
export const PROTOCOL_VERSION = 1

export const RpcErrorCode = {
  Timeout: 'rpc.timeout',
  InvalidParams: 'rpc.invalid_params',
  InvalidResult: 'rpc.invalid_result',
  MethodNotFound: 'rpc.method_not_found',
  Internal: 'rpc.internal',
  ProtocolMismatch: 'rpc.protocol_mismatch',
  Closed: 'rpc.closed',
} as const

/** 带错误码的错误。处理函数抛出它时，错误码与参数原样返回给调用方。 */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    readonly params?: ErrorInfo['params'],
  ) {
    super(code)
    this.name = 'RpcError'
  }

  toInfo(): ErrorInfo {
    return this.params ? { code: this.code, params: this.params } : { code: this.code }
  }
}

// ---------- 消息定义 ----------

export interface RequestDef<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  params: P
  result: R
}

/** 一侧对外提供的接口：它处理的请求与它发出的事件。 */
export interface Side {
  requests: Record<string, RequestDef>
  events: Record<string, z.ZodType>
}

export function defineSide<S extends Side>(side: S): S {
  return side
}

// ---------- 线上格式 ----------

const HelloMessage = z.object({
  kind: z.literal('hello'),
  protocolVersion: z.number().int(),
  /** 收到对方的 hello 后回复的 hello 为 true，避免无限往返。 */
  ack: z.boolean(),
})
const RequestMessage = z.object({
  kind: z.literal('request'),
  id: Id,
  method: z.string(),
  params: z.unknown(),
})
const ResponseMessage = z.union([
  z.object({ kind: z.literal('response'), id: Id, ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('response'), id: Id, ok: z.literal(false), error: ErrorInfo }),
])
const EventMessage = z.object({ kind: z.literal('event'), name: z.string(), data: z.unknown() })

const WireMessage = z.union([HelloMessage, RequestMessage, ResponseMessage, EventMessage])
type WireMessage = z.infer<typeof WireMessage>

// ---------- 传输 ----------

/** 传输层：发送与接收原始消息（可结构化克隆的对象）。 */
export interface RpcChannel {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
}

// ---------- 端点 ----------

type Params<S extends Side, M extends keyof S['requests']> = z.input<S['requests'][M]['params']>
type ParsedParams<S extends Side, M extends keyof S['requests']> = z.output<
  S['requests'][M]['params']
>
type Result<S extends Side, M extends keyof S['requests']> = z.output<S['requests'][M]['result']>
type ResultInput<S extends Side, M extends keyof S['requests']> = z.input<
  S['requests'][M]['result']
>

export interface RequestOptions {
  /** 超时毫秒数，默认 30 秒；0 表示不超时。 */
  timeoutMs?: number
}

export interface EndpointOptions<Local extends Side, Remote extends Side> {
  local: Local
  remote: Remote
  /** 默认请求超时，默认 30 秒。 */
  defaultTimeoutMs?: number
  /** 收到无法识别或校验失败的消息时调用，用于记录日志。 */
  onProtocolError?: (error: RpcError, message: unknown) => void
}

export interface RpcEndpoint<Local extends Side, Remote extends Side> {
  /** 握手完成后 resolve；协议版本不兼容或连接关闭时 reject。 */
  readonly ready: Promise<void>
  request<M extends keyof Remote['requests'] & string>(
    method: M,
    params: Params<Remote, M>,
    options?: RequestOptions,
  ): Promise<Result<Remote, M>>
  handle<M extends keyof Local['requests'] & string>(
    method: M,
    handler: (
      params: ParsedParams<Local, M>,
    ) => ResultInput<Local, M> | Promise<ResultInput<Local, M>>,
  ): void
  emit<E extends keyof Local['events'] & string>(name: E, data: z.input<Local['events'][E]>): void
  on<E extends keyof Remote['events'] & string>(
    name: E,
    listener: (data: z.output<Remote['events'][E]>) => void,
  ): () => void
  /** 关闭端点：未完成的请求以 rpc.closed 失败。 */
  close(): void
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * protocol 不引入 DOM 或 Node 类型，但所有目标运行时（Node、Electron 渲染进程）都提供计时器。
 * 每次调用时从 globalThis 读取，测试中的假计时器也能生效。
 */
type TimerHandle = { readonly __timer: unique symbol }
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export function createEndpoint<Local extends Side, Remote extends Side>(
  channel: RpcChannel,
  options: EndpointOptions<Local, Remote>,
): RpcEndpoint<Local, Remote> {
  const { local, remote } = options
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const handlers = new Map<string, (params: unknown) => unknown>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const pending = new Map<
    string,
    {
      method: string
      resolve: (v: unknown) => void
      reject: (e: RpcError) => void
      timer?: TimerHandle
    }
  >()
  let nextId = 1
  let closed = false
  let peerVersion: number | undefined

  let resolveReady!: () => void
  let rejectReady!: (e: RpcError) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // 没有人等待 ready 时不产生未处理的 rejection；request() 会自行等待并传播错误。
  ready.catch(() => undefined)

  const protocolError = (code: string, message: unknown, params?: ErrorInfo['params']) =>
    options.onProtocolError?.(new RpcError(code, params), message)

  const send = (message: WireMessage) => {
    if (!closed) channel.post(message)
  }

  const failAll = (error: RpcError) => {
    for (const [id, p] of pending) {
      if (p.timer) timers.clearTimeout(p.timer)
      p.reject(error)
      pending.delete(id)
    }
  }

  const onHello = (msg: z.infer<typeof HelloMessage>) => {
    if (!msg.ack) send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: true })
    if (peerVersion !== undefined) return
    peerVersion = msg.protocolVersion
    if (msg.protocolVersion === PROTOCOL_VERSION) {
      resolveReady()
    } else {
      const error = new RpcError(RpcErrorCode.ProtocolMismatch, {
        local: PROTOCOL_VERSION,
        remote: msg.protocolVersion,
      })
      rejectReady(error)
      failAll(error)
    }
  }

  const onRequest = async (msg: z.infer<typeof RequestMessage>) => {
    const respondError = (error: RpcError) =>
      send({ kind: 'response', id: msg.id, ok: false, error: error.toInfo() })

    if (peerVersion !== PROTOCOL_VERSION) {
      return respondError(new RpcError(RpcErrorCode.ProtocolMismatch))
    }
    const def = local.requests[msg.method]
    const handler = handlers.get(msg.method)
    if (!def || !handler) {
      return respondError(new RpcError(RpcErrorCode.MethodNotFound, { method: msg.method }))
    }
    const params = def.params.safeParse(msg.params)
    if (!params.success) {
      protocolError(RpcErrorCode.InvalidParams, msg, { method: msg.method })
      return respondError(new RpcError(RpcErrorCode.InvalidParams, { method: msg.method }))
    }
    let result: unknown
    try {
      result = await handler(params.data)
    } catch (error) {
      return respondError(
        error instanceof RpcError
          ? error
          : new RpcError(RpcErrorCode.Internal, { method: msg.method }),
      )
    }
    const parsed = def.result.safeParse(result)
    if (!parsed.success) {
      protocolError(RpcErrorCode.InvalidResult, msg, { method: msg.method })
      return respondError(new RpcError(RpcErrorCode.Internal, { method: msg.method }))
    }
    send({ kind: 'response', id: msg.id, ok: true, result: parsed.data })
  }

  const onResponse = (msg: z.infer<typeof ResponseMessage>) => {
    const p = pending.get(msg.id)
    if (!p) return // 已超时或已关闭
    pending.delete(msg.id)
    if (p.timer) timers.clearTimeout(p.timer)
    if (!msg.ok) return p.reject(new RpcError(msg.error.code, msg.error.params))
    const def = remote.requests[p.method]
    const parsed = def?.result.safeParse(msg.result)
    if (!parsed?.success) {
      protocolError(RpcErrorCode.InvalidResult, msg, { method: p.method })
      return p.reject(new RpcError(RpcErrorCode.InvalidResult, { method: p.method }))
    }
    p.resolve(parsed.data)
  }

  const onEvent = (msg: z.infer<typeof EventMessage>) => {
    const schema = remote.events[msg.name]
    if (!schema) return protocolError(RpcErrorCode.MethodNotFound, msg, { event: msg.name })
    const parsed = schema.safeParse(msg.data)
    if (!parsed.success) return protocolError(RpcErrorCode.InvalidParams, msg, { event: msg.name })
    for (const listener of listeners.get(msg.name) ?? []) listener(parsed.data)
  }

  const unsubscribe = channel.onMessage((raw) => {
    if (closed) return
    const parsed = WireMessage.safeParse(raw)
    if (!parsed.success) return protocolError(RpcErrorCode.InvalidParams, raw)
    const msg = parsed.data
    switch (msg.kind) {
      case 'hello':
        return onHello(msg)
      case 'request':
        return void onRequest(msg)
      case 'response':
        return onResponse(msg)
      case 'event':
        if (peerVersion === PROTOCOL_VERSION) onEvent(msg)
        return
    }
  })

  send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ack: false })

  return {
    ready,

    async request(method, params, requestOptions) {
      if (closed) throw new RpcError(RpcErrorCode.Closed)
      const def = remote.requests[method]
      if (!def) throw new RpcError(RpcErrorCode.MethodNotFound, { method })
      const parsedParams = def.params.safeParse(params)
      if (!parsedParams.success) throw new RpcError(RpcErrorCode.InvalidParams, { method })
      await ready
      const id = String(nextId++)
      const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs
      return new Promise((resolve, reject) => {
        const entry: typeof pending extends Map<string, infer V> ? V : never = {
          method,
          resolve: resolve as (v: unknown) => void,
          reject,
        }
        if (timeoutMs > 0) {
          entry.timer = timers.setTimeout(() => {
            pending.delete(id)
            reject(new RpcError(RpcErrorCode.Timeout, { method, timeoutMs }))
          }, timeoutMs)
        }
        pending.set(id, entry)
        send({ kind: 'request', id, method, params: parsedParams.data })
      })
    },

    handle(method, handler) {
      handlers.set(method, handler as (params: unknown) => unknown)
    },

    emit(name, data) {
      const schema = local.events[name]
      if (!schema) throw new RpcError(RpcErrorCode.MethodNotFound, { event: name })
      const parsed = schema.safeParse(data)
      if (!parsed.success) throw new RpcError(RpcErrorCode.InvalidParams, { event: name })
      send({ kind: 'event', name, data: parsed.data })
    },

    on(name, listener) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      const l = listener as (data: unknown) => void
      set.add(l)
      return () => set.delete(l)
    },

    close() {
      if (closed) return
      closed = true
      unsubscribe()
      const error = new RpcError(RpcErrorCode.Closed)
      rejectReady(error)
      failAll(error)
    },
  }
}
