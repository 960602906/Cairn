/**
 * 渲染进程 IPC 传输（M0-13b，架构 §17）：把 `ipcMain` 上的 `nexus:rpc` 通道变成某个窗口专属的
 * `RpcChannel`，交给 IPC 网关。
 *
 * 发送方校验：只接受来自该窗口主框架、且页面是应用自己页面的消息（`isAppUrl`）。子框架、
 * 导航到其他页面后发出的消息、其他窗口的消息一律丢弃（可通过 `onRejected` 记录）。
 *
 * Electron 对象以结构化接口注入，便于在 Node 中测试。
 */
import type { RpcChannel } from '@nexus/protocol'
import { RPC_CHANNEL } from '../../shared/ipc.js'
import { isAppUrl, type NavigationPolicy } from '../security.js'

export interface IpcSenderFrameLike {
  readonly url: string
  /** 主框架为 null。 */
  readonly parent: unknown
}

export interface IpcMainEventLike {
  readonly sender: { readonly id: number }
  /** 框架已销毁时为 null。 */
  readonly senderFrame: IpcSenderFrameLike | null
}

type IpcListener = (event: IpcMainEventLike, message: unknown) => void

export interface IpcMainLike {
  on(channel: string, listener: IpcListener): unknown
  removeListener(channel: string, listener: IpcListener): unknown
}

export interface RendererContentsLike {
  readonly id: number
  send(channel: string, message: unknown): void
  isDestroyed(): boolean
}

export type IpcRejectReason = 'no_frame' | 'subframe' | 'untrusted_url'

/** 校验消息是否来自应用页面的主框架；返回拒绝原因，通过时返回 undefined。 */
export function checkIpcSender(
  event: IpcMainEventLike,
  policy: NavigationPolicy,
): IpcRejectReason | undefined {
  const frame = event.senderFrame
  if (!frame) return 'no_frame'
  if (frame.parent !== null) return 'subframe'
  if (!isAppUrl(frame.url, policy)) return 'untrusted_url'
  return undefined
}

export interface RendererChannelOptions {
  readonly ipcMain: IpcMainLike
  readonly contents: RendererContentsLike
  readonly policy: NavigationPolicy
  readonly onRejected?: (reason: IpcRejectReason, url: string | undefined) => void
}

export function createRendererChannel(options: RendererChannelOptions): RpcChannel {
  const { ipcMain, contents, policy, onRejected } = options
  return {
    post(message) {
      if (!contents.isDestroyed()) contents.send(RPC_CHANNEL, message)
    },
    onMessage(listener) {
      const handler: IpcListener = (event, message) => {
        if (event.sender.id !== contents.id) return
        const rejected = checkIpcSender(event, policy)
        if (rejected) {
          onRejected?.(rejected, event.senderFrame?.url)
          return
        }
        listener(message)
      }
      ipcMain.on(RPC_CHANNEL, handler)
      return () => ipcMain.removeListener(RPC_CHANNEL, handler)
    },
  }
}
