/**
 * @nexus/core —— 领域类型、AgentRuntime 接口、事件归约等（架构 §5、§6）。
 * 只允许依赖 @nexus/protocol。
 * 运行状态机见 run-state.ts（M0-06a）；事件归约在 M0-06b～d 实现，AgentRuntime 与 FakeRuntime 在 M0-07 实现。
 */
import { EVENT_SCHEMA_VERSION } from '@nexus/protocol'

/** core 能处理的最高事件 schema 版本。 */
export const SUPPORTED_EVENT_SCHEMA_VERSION: typeof EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION

export * from './run-state.js'
export * from './session-view.js'
export * from './history.js'
