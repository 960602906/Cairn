/**
 * RPC 错误的定义（从 `rpc.ts` 拆出）：渲染进程也要用到，但**不能**连带引入 zod 与全部 schema。
 * `rpc.ts` 与 `bridge.ts` 都从这里取，保证全局只有一份实现（`instanceof` 判断跨模块可靠）。
 */
import type { ErrorInfo } from './common.js'

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
