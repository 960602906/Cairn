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
  type WindowControlsApi,
} from '@cairn/protocol'
import { API_KEY, RPC_CHANNEL } from '../shared/ipc.js'
import { WINDOW_CONTROLS_CHANNEL } from '../shared/window-controls.js'

/** 用到的 `ipcRenderer` 接口。 */
export interface IpcRendererLike {
  send(channel: string, message: unknown): void
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
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
  readonly platform: string
}): RpcBridge & { readonly windowControls: WindowControlsApi } {
  const endpoint = createEndpoint(createIpcChannel(deps.ipcRenderer), {
    local: RendererForMain,
    remote: MainForRenderer,
  })
  const api = exposeEndpoint(endpoint)
  const windowControls: WindowControlsApi = {
    platform: deps.platform,
    minimize: async () => {
      await deps.ipcRenderer.invoke(WINDOW_CONTROLS_CHANNEL.minimize)
    },
    toggleMaximize: async () =>
      (await deps.ipcRenderer.invoke(WINDOW_CONTROLS_CHANNEL.toggleMaximize)) === true,
    close: async () => {
      await deps.ipcRenderer.invoke(WINDOW_CONTROLS_CHANNEL.close)
    },
    isMaximized: async () =>
      (await deps.ipcRenderer.invoke(WINDOW_CONTROLS_CHANNEL.isMaximized)) === true,
    onMaximizedChange: (listener) => {
      const handler = (_event: unknown, value: unknown) => {
        if (typeof value === 'boolean') listener(value)
      }
      deps.ipcRenderer.on(WINDOW_CONTROLS_CHANNEL.maximizedChanged, handler)
      return () =>
        deps.ipcRenderer.removeListener(WINDOW_CONTROLS_CHANNEL.maximizedChanged, handler)
    },
  }
  const exposed = { ...api, windowControls }
  deps.contextBridge.exposeInMainWorld(API_KEY, exposed)
  return exposed
}
