/**
 * 界面访问主进程的唯一入口：preload 暴露的 `window.cairn`（ADR-0009，架构 §17）。
 * 还原为按 `MainForRenderer` 类型化的接口，失败时抛出 `RpcError`。
 */
import {
  createBridgeClient,
  type BridgeClient,
  type MainForRenderer,
  type RpcBridge,
} from '@cairn/protocol'

declare global {
  interface Window {
    readonly cairn?: RpcBridge
  }
}

export type MainApi = BridgeClient<typeof MainForRenderer>

/** preload 未加载时（如在普通浏览器中打开）返回 undefined。 */
export function getMainApi(target: { readonly cairn?: RpcBridge } = window): MainApi | undefined {
  return target.cairn ? createBridgeClient<typeof MainForRenderer>(target.cairn) : undefined
}
