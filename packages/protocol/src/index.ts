/**
 * @nexus/protocol —— IPC 协议与事件定义（ADR-0009，架构 §7、§15）。
 * 最底层的包：不得依赖任何其他 @nexus/* 包。
 * IPC 消息在 M0-05 实现。
 */
export * from './common.js'
export * from './events.js'
