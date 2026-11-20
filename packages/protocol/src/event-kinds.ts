/**
 * 事件类型的划分（从 `events.ts` 拆出）：增量事件只用于实时显示，其余事件写入数据库。
 *
 * 界面与会话投影都需要 `isPersistedEvent`，但只需要这几个字符串，不该为此加载 zod 与全部 payload
 * schema；schema 在 `events.ts` 里，登记情况由 `events.test.ts` 检查。
 */
import type { EventEnvelope, PersistedEvent } from './events.js'

/** 只用于实时显示、不写数据库的增量事件（架构 §7.3）。 */
export const LIVE_EVENT_TYPES = [
  'message.assistant.delta',
  'message.reasoning.delta',
  'tool.output.delta',
  'command.output.delta',
] as const

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number]

const liveTypes: ReadonlySet<string> = new Set(LIVE_EVENT_TYPES)

export function isLiveEventType(type: string): type is LiveEventType {
  return liveTypes.has(type)
}

/** 会写入数据库的事件。增量事件在类型上无法赋值给它。 */
export function isPersistedEvent(event: EventEnvelope): event is PersistedEvent {
  return !isLiveEventType(event.type)
}
