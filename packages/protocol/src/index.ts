/**
 * @nexus/protocol —— IPC 协议与事件定义（ADR-0009，架构 §7、§15）。
 * 最底层的包：不得依赖任何其他 @nexus/* 包。
 * 事件 schema 在 M0-04 实现，IPC 消息在 M0-05 实现。
 */

/** 事件信封的 schema 版本（架构 §7.1 `EventEnvelope.v`）。 */
export const EVENT_SCHEMA_VERSION = 1 as const
