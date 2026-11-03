// @ts-check
/**
 * 把 pi-agent-core 的事件序列规范化为可比对的轨迹（黄金文件的内容）。
 *
 * - 去掉每次运行都会变的字段：`timestamp`、`durationMs`；
 * - 工具调用 id 按首次出现顺序替换为 `<toolcall-n>`：Gemini 响应不带 id 时 pi-ai 用
 *   `<名称>_<Date.now()>_<模块级计数>` 生成，既随时间变化，也与同一进程中此前的调用次数有关；
 * - `message_update` 中的 `message` 与 `assistantMessageEvent.partial` 是当前消息的完整快照，
 *   可由前面的增量推出，去掉以减小黄金文件；
 * - `message_start` 只保留 `role`：助手消息的 `message` 是 pi-ai 正在填充的同一个对象，发出事件时
 *   已解析到哪里取决于网络分块（Anthropic 的首个 SSE 事件带用量与 id，与开始事件同一批到达时，
 *   `message_start` 里就已有用量），不属于契约。
 *
 * 其余字段（增量的切分、用量、`responseId`、`rawStopReason`、错误信息）都来自录制的响应，
 * 回放时应完全一致。
 */

const VOLATILE_KEYS = new Set(['timestamp', 'durationMs'])

/** @param {any[]} events */
export function normalizeEvents(events) {
  /** @type {Map<string, string>} */
  const ids = new Map()
  const idOf = (/** @type {string} */ id) => {
    if (!ids.has(id)) ids.set(id, `<toolcall-${ids.size + 1}>`)
    return /** @type {string} */ (ids.get(id))
  }

  /** @param {any} value @returns {any} */
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object') return value
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue
      if (key === 'toolCallId' && typeof child === 'string') out[key] = idOf(child)
      else if (key === 'id' && value.type === 'toolCall' && typeof child === 'string') {
        out[key] = idOf(child)
      } else out[key] = walk(child)
    }
    return out
  }

  return events.map((event) => {
    if (event.type === 'message_start') return { type: event.type, role: event.message.role }
    if (event.type !== 'message_update') return walk(event)
    const { partial: _partial, ...assistantMessageEvent } = event.assistantMessageEvent
    return walk({ type: event.type, assistantMessageEvent })
  })
}
