/**
 * 渲染进程使用的轻量入口：RPC 错误、桥接客户端、长度上限与几个纯判定。
 *
 * 这里刻意不引入 zod 与任何 schema：界面只需要这些运行时值，校验发生在主进程与宿主。
 * 类型仍从 `@cairn/protocol` 主入口 `import type` 取（编译后不产生运行时依赖）。
 */
export { RpcError, RpcErrorCode } from './errors.js'
export { createBridgeClient, type BridgeClient, type RpcBridge } from './bridge.js'
export {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  INSTRUCTIONS_MAX_LENGTH,
  PLAN_FEEDBACK_MAX,
  PROJECT_NAME_MAX_LENGTH,
  SESSION_TITLE_MAX_LENGTH,
} from './limits.js'
export { isAgentDraftRef } from './agent-ref.js'
export { RUN_STATES } from './run-states.js'
export {
  isLiveEventType,
  isPersistedEvent,
  LIVE_EVENT_TYPES,
  type LiveEventType,
} from './event-kinds.js'
export { taskListIdForPlan } from './task-list-id.js'
