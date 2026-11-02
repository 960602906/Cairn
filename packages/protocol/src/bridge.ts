/**
 * 跨 `contextBridge` 暴露端点（ADR-0009，架构 §15、§17）。
 *
 * preload 中创建 `RpcEndpoint`，用 `exposeEndpoint` 包装成只含普通函数的对象，通过
 * `contextBridge.exposeInMainWorld` 交给界面；界面用 `createBridgeClient` 还原为类型化的接口。
 *
 * `contextBridge` 只保留错误的 message，`RpcError` 的错误码和参数会丢失，因此请求结果以
 * `{ ok, result | error }` 传递，在界面一侧重新抛出 `RpcError`。
 */
import type { z } from 'zod'
import type { ErrorInfo } from './common.js'
import { RpcError, RpcErrorCode, type RequestOptions, type RpcEndpoint, type Side } from './rpc.js'

export type BridgeResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ErrorInfo }

/** 暴露给界面的对象：只有普通函数与可结构化克隆的数据。 */
export interface RpcBridge {
  /** 握手完成后 resolve 为 `{ ok: true }`；失败时带错误码。 */
  ready(): Promise<BridgeResult>
  request(method: string, params: unknown, options?: RequestOptions): Promise<BridgeResult>
  /** 订阅事件，返回取消订阅的函数。 */
  on(name: string, listener: (data: unknown) => void): () => void
}

function toErrorInfo(error: unknown): ErrorInfo {
  return error instanceof RpcError ? error.toInfo() : { code: RpcErrorCode.Internal }
}

async function settle(promise: Promise<unknown>): Promise<BridgeResult> {
  try {
    return { ok: true, result: await promise }
  } catch (error) {
    return { ok: false, error: toErrorInfo(error) }
  }
}

/** preload 一侧：把端点包装成可以跨 `contextBridge` 传递的对象。 */
export function exposeEndpoint<Local extends Side, Remote extends Side>(
  endpoint: RpcEndpoint<Local, Remote>,
): RpcBridge {
  // 方法名与参数由端点按 Remote 的定义校验，不在定义中的方法返回 rpc.method_not_found
  const untyped = endpoint as unknown as {
    readonly ready: Promise<void>
    request(method: string, params: unknown, options?: RequestOptions): Promise<unknown>
    on(name: string, listener: (data: unknown) => void): () => void
  }
  return {
    ready: () => settle(untyped.ready),
    request: (method, params, options) =>
      settle(Promise.resolve().then(() => untyped.request(method, params, options))),
    on: (name, listener) => untyped.on(name, listener),
  }
}

type Params<S extends Side, M extends keyof S['requests']> = z.input<S['requests'][M]['params']>
type Result<S extends Side, M extends keyof S['requests']> = z.output<S['requests'][M]['result']>

/** 界面一侧的类型化接口。 */
export interface BridgeClient<Remote extends Side> {
  ready(): Promise<void>
  request<M extends keyof Remote['requests'] & string>(
    method: M,
    params: Params<Remote, M>,
    options?: RequestOptions,
  ): Promise<Result<Remote, M>>
  on<E extends keyof Remote['events'] & string>(
    name: E,
    listener: (data: z.output<Remote['events'][E]>) => void,
  ): () => void
}

function unwrap(result: BridgeResult): unknown {
  if (result.ok) return result.result
  throw new RpcError(result.error.code, result.error.params)
}

/**
 * 界面一侧：把 preload 暴露的对象还原为类型化接口，失败时抛出 `RpcError`。
 * 数据已在 preload 中按协议校验，这里只做类型转换。
 */
export function createBridgeClient<Remote extends Side>(bridge: RpcBridge): BridgeClient<Remote> {
  return {
    ready: async () => {
      unwrap(await bridge.ready())
    },
    request: async (method, params, options) =>
      unwrap(await bridge.request(method, params, options)) as never,
    on: (name, listener) => bridge.on(name, listener as (data: unknown) => void),
  }
}
