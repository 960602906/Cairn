/**
 * agent 宿主入口（ADR-0003，架构 §4）：由主进程通过 `utilityProcess.fork` 启动。
 *
 * 等待主进程经 `{ type: 'nexus.port' }` 消息转交的专用端口，在其上运行宿主协议（`host.ts`）。
 */
import { randomUUID } from 'node:crypto'
import type {} from 'electron'
import { HOST_PORT_MESSAGE, portChannel } from '../shared/host-port.js'
import { createFakeHostRuntime } from './fake-model.js'
import { createAgentHost } from './host.js'

process.parentPort.on('message', (event) => {
  const port = event.ports[0]
  if ((event.data as { type?: unknown } | null)?.type !== HOST_PORT_MESSAGE || !port) return
  port.start()
  createAgentHost({
    channel: portChannel(port),
    createRuntime: (model) => createFakeHostRuntime(model),
    exit: (code) => process.exit(code),
    createId: randomUUID,
    onError: (error) => console.error('[agent-host]', error),
  })
})
