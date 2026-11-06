/**
 * preload 的实际逻辑（ADR-0009，架构 §17）：在 IPC 通道上创建渲染一侧的端点，
 * 通过 `contextBridge` 只暴露 `exposeEndpoint` 包装后的三个函数。不暴露 `ipcRenderer`，
 * 界面也无法指定 IPC 通道名或发送任意消息；方法与参数由端点按 `MainForRenderer` 校验。
 *
 * Electron 对象由入口注入，便于单元测试。
 */
import {
  MainForRenderer,
  RendererForMain,
  createEndpoint,
  exposeEndpoint,
  type RpcBridge,
  type RpcChannel,
} from '@cairn/protocol'
import { API_KEY, RPC_CHANNEL } from '../shared/ipc.js'

/** 用到的 `ipcRenderer` 接口。 */
export interface IpcRendererLike {
  send(channel: string, message: unknown): void
  on(channel: string, listener: (event: unknown, message: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, message: unknown) => void): unknown
}

/** 用到的 `contextBridge` 接口。 */
export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: RpcBridge): void
}

export function createIpcChannel(ipc: IpcRendererLike): RpcChannel {
  return {
    post: (message) => ipc.send(RPC_CHANNEL, message),
    onMessage(listener) {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipc.on(RPC_CHANNEL, handler)
      return () => ipc.removeListener(RPC_CHANNEL, handler)
    },
  }
}

export function exposeRendererApi(deps: {
  readonly contextBridge: ContextBridgeLike
  readonly ipcRenderer: IpcRendererLike
}): RpcBridge {
  const endpoint = createEndpoint(createIpcChannel(deps.ipcRenderer), {
    local: RendererForMain,
    remote: MainForRenderer,
  })
  const api = exposeEndpoint(endpoint)
  deps.contextBridge.exposeInMainWorld(API_KEY, api)
  return api
}
