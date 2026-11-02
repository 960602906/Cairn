/**
 * 启动 agent 宿主进程（M0-13c，ADR-0003，架构 §4、§15.3）。
 *
 * 用 `utilityProcess.fork` 启动 `agent-host.js`，再用 `MessageChannelMain` 建立专用的 MessagePort：
 * 主进程保留 `port1`，把 `port2` 随 `{ type: 'nexus.port' }` 消息转交给宿主。之后主进程与宿主
 * 之间的 RPC 只走这个端口（凭据在 M1 也只经它传递，ADR-0010）。
 *
 * Electron 对象以结构化接口注入，便于在 Node 中测试。
 */
import type { RpcChannel } from '@nexus/protocol'

/** 宿主收到端口的消息类型（宿主入口 M0-14 按此接收）。 */
export const HOST_PORT_MESSAGE = 'nexus.port'

/** 正在运行的宿主进程。 */
export interface HostProcess {
  /** 与宿主之间的 RPC 通道（MessagePort）。 */
  readonly channel: RpcChannel
  readonly pid: number | undefined
  /** 强制结束进程。 */
  kill(): void
  /** 进程退出时调用一次（`code` 为退出码）。 */
  onExit(listener: (code: number) => void): void
}

export type SpawnHost = (sessionId: string) => HostProcess

export interface MessagePortMainLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
}

export interface UtilityProcessLike {
  readonly pid: number | undefined
  postMessage(message: unknown, transfer?: MessagePortMainLike[]): void
  kill(): boolean
  once(event: 'exit', listener: (code: number) => void): unknown
}

export interface UtilityHostSpawnerOptions {
  /** 构建后的宿主入口（`out/main/agent-host.js`）。 */
  readonly entry: string
  readonly fork: (
    modulePath: string,
    args: string[],
    options: { serviceName: string },
  ) => UtilityProcessLike
  readonly createMessageChannel: () => { port1: MessagePortMainLike; port2: MessagePortMainLike }
}

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

export function createUtilityHostSpawner(options: UtilityHostSpawnerOptions): SpawnHost {
  return () => {
    const child = options.fork(options.entry, [], { serviceName: 'NEXUS-OS Agent Host' })
    const { port1, port2 } = options.createMessageChannel()
    child.postMessage({ type: HOST_PORT_MESSAGE }, [port2])
    port1.start()
    let exited = false
    const exitListeners: ((code: number) => void)[] = []
    child.once('exit', (code) => {
      exited = true
      port1.close()
      for (const listener of exitListeners) listener(code)
    })
    return {
      channel: portChannel(port1),
      pid: child.pid,
      kill: () => {
        if (!exited) child.kill()
      },
      onExit: (listener) => {
        exitListeners.push(listener)
      },
    }
  }
}
