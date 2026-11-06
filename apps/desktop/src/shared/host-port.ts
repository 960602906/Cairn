/**
 * 主进程与 agent 宿主之间的专用 MessagePort（ADR-0003，架构 §15.3）。主进程与宿主共用。
 *
 * 主进程用 `MessageChannelMain` 建立端口，把其中一端随 `{ type: 'cairn.port' }` 消息交给宿主，
 * 之后双方的 RPC 只走这个端口。Electron 对象以结构化接口表示，便于在 Node 中测试。
 */
import type { RpcChannel } from '@cairn/protocol'

/** 宿主收到端口的消息类型。 */
export const HOST_PORT_MESSAGE = 'cairn.port'

/** `MessagePortMain` 中用到的部分。 */
export interface MessagePortMainLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
}

/** 把 MessagePort 包装成 RPC 通道。 */
export function portChannel(port: MessagePortMainLike): RpcChannel {
  return {
    post: (message) => port.postMessage(message),
    onMessage(listener) {
      const handler = (event: { data: unknown }) => listener(event.data)
      port.on('message', handler)
      return () => port.removeListener('message', handler)
    },
  }
}
