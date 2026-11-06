/**
 * 宿主收到的历史记录（端到端测试用，M0-16b）。启动应用时设置 `CAIRN_HOST_TRACE_FILE`，宿主每次创建
 * 运行时会话都把 `host.init` 带来的历史追加为一行 JSON，测试据此确认重启后宿主拿到了完整历史。
 *
 * 记录的是对话原文，只在测试中开启；未设置时宿主不做任何记录。打包后的应用启动宿主时去掉这个环境变量
 * （`shared/host-trace.ts`），因此正式版不会记录。
 */
import type { AgentRuntime } from '@cairn/core'
import type { CanonicalMessage } from '@cairn/protocol'

export { HOST_TRACE_ENV } from '../shared/host-trace.js'

/** 记录文件中的一行。 */
export interface HostTraceRecord {
  readonly history: readonly CanonicalMessage[]
}

/** 包装运行时：创建会话之前写出收到的历史。 */
export function traceHistory(runtime: AgentRuntime, write: (line: string) => void): AgentRuntime {
  return {
    id: runtime.id,
    createSession(init) {
      const record: HostTraceRecord = { history: init.history }
      write(JSON.stringify(record))
      return runtime.createSession(init)
    },
  }
}
