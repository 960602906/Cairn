/**
 * @cairn/core —— 领域类型、AgentRuntime 接口、事件归约等（架构 §5、§6）。
 * 只允许依赖 @cairn/protocol（以及 zod，用于工具参数的 JSON Schema 校验）。
 * 运行状态机见 run-state.ts（M0-06a）；事件归约在 M0-06b～d 实现，AgentRuntime 与 FakeRuntime 在 M0-07 实现。
 */
import { EVENT_SCHEMA_VERSION } from '@cairn/protocol'

/** core 能处理的最高事件 schema 版本。 */
export const SUPPORTED_EVENT_SCHEMA_VERSION: typeof EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION

export * from './run-state.js'
export * from './session-view.js'
export * from './history.js'
export * from './runtime.js'
export * from './fake-runtime.js'
export * from './run-engine.js'
export * from './run-supervisor.js'
export * from './redact.js'
export * from './logger.js'
export * from './credentials.js'
export * from './provider-templates.js'
export * from './tools.js'
export * from './tool-pipeline.js'
export * from './context-budget.js'
export * from './usage.js'
export * from './system-prompt.js'
export * from './agents-md.js'
export * from './workspace-path.js'
export * from './glob.js'
export * from './command-match.js'
export * from './permissions.js'
export * from './permission-guards.js'
export * from './ansi.js'
