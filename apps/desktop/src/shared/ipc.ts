/**
 * 主进程与 preload 共用的 IPC 常量。
 */

/** 渲染进程 ↔ 主进程的 RPC 消息走这一个 IPC 通道（协议见 `@nexus/protocol`）。 */
export const RPC_CHANNEL = 'nexus:rpc'

/** preload 在 `window` 上暴露 API 的名称（`window.nexus`）。 */
export const API_KEY = 'nexus'
