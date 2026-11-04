/**
 * 把一次场景运行规范化为可比对的轨迹（黄金文件的内容，M1-02a）。比对的是适配器的输出
 * （`RuntimeEvent`、工具钩子收到的调用、导出的历史），而不是 pi 的原始事件：pi 新增而适配器不用的字段
 * 不会造成黄金文件变化。
 *
 * - 去掉每次运行都会变的 `ts`（助手消息与工具结果的时间来自 pi 的 `Date.now()`）；
 * - 工具调用 id 按首次出现顺序替换为 `<toolcall-n>`：Gemini 响应不带 id 时 pi-ai 用
 *   `<名称>_<Date.now()>_<模块级计数>` 生成，既随时间变化，也与同一进程中此前的调用次数有关。
 *
 * 其余内容（增量的切分、用量、推理签名、结束原因、错误码）都来自录制的响应，回放时应完全一致。
 */
import type { ScenarioRun } from './scenarios.js'

export interface Trace {
  readonly events: unknown[]
  readonly toolCalls: unknown[]
  readonly history: unknown[]
}

export function normalizeRun(run: ScenarioRun): Trace {
  const ids = new Map<string, string>()
  const idOf = (id: string) => {
    if (!ids.has(id)) ids.set(id, `<toolcall-${ids.size + 1}>`)
    return ids.get(id)!
  }
  const walk = (value: unknown, inToolCalls = false): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, inToolCalls))
    if (value === null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ts') continue
      if (typeof child === 'string' && (key === 'toolCallId' || (key === 'id' && inToolCalls))) {
        out[key] = idOf(child)
      } else {
        out[key] = walk(child, key === 'toolCalls')
      }
    }
    return out
  }
  return {
    events: run.events.map((e) => walk(e)),
    toolCalls: walk(run.toolCalls, true) as unknown[],
    history: run.history.map((m) => walk(m)),
  }
}

export function serializeTrace(trace: Trace): string {
  return `${JSON.stringify(trace, null, 2)}\n`
}
