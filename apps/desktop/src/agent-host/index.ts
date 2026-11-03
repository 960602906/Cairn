/**
 * agent 宿主入口（ADR-0003，架构 §4）：由主进程通过 `utilityProcess.fork` 启动。
 *
 * 等待主进程经 `{ type: 'nexus.port' }` 消息转交的专用端口，在其上运行宿主协议（`host.ts`）。
 * 设置 `NEXUS_HOST_TRACE_FILE` 时记录收到的历史（端到端测试用，见 `history-trace.ts`）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type {} from 'electron'
import { HOST_PORT_MESSAGE, portChannel } from '../shared/host-port.js'
import { createFakeHostRuntime } from './fake-model.js'
import { HOST_TRACE_ENV, traceHistory } from './history-trace.js'
import { createAgentHost } from './host.js'

const traceFile = process.env[HOST_TRACE_ENV]

process.parentPort.on('message', (event) => {
  const port = event.ports[0]
  if ((event.data as { type?: unknown } | null)?.type !== HOST_PORT_MESSAGE || !port) return
  port.start()
  createAgentHost({
    channel: portChannel(port),
    createRuntime: (model) => {
      const host = createFakeHostRuntime(model)
      if (!traceFile) return host
      const write = (line: string) => appendFileSync(traceFile, `${line}\n`)
      return { ...host, runtime: traceHistory(host.runtime, write) }
    },
    exit: (code) => process.exit(code),
    createId: randomUUID,
    onError: (error) => console.error('[agent-host]', error),
  })
})
