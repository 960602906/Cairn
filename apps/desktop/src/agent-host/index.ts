/**
 * agent 宿主入口（ADR-0003，架构 §4）：由主进程通过 `utilityProcess.fork` 启动。
 *
 * 等待主进程经 `{ type: 'nexus.port' }` 消息转交的专用端口，在其上运行宿主协议（`host.ts`）。
 * 运行时由环境变量选择（`runtime-select.ts`：默认 FakeRuntime，`NEXUS_RUNTIME=pi` 时为 pi 适配器）。
 * 设置 `NEXUS_HOST_TRACE_FILE` 时记录收到的历史（端到端测试用，见 `history-trace.ts`）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { redact } from '@nexus/core'
import type {} from 'electron'
import { HOST_PORT_MESSAGE, portChannel } from '../shared/host-port.js'
import { HOST_TRACE_ENV, traceHistory } from './history-trace.js'
import { createAgentHost } from './host.js'
import { selectHostRuntime } from './runtime-select.js'

const traceFile = process.env[HOST_TRACE_ENV]
const createHostRuntime = selectHostRuntime(process.env)
/** `host.init` 带来的 Key：错误输出前按原文脱敏。 */
const secrets: string[] = []
const reportError = (error: unknown) =>
  console.error('[agent-host]', redact(error, { homeDirs: [homedir()], secrets }))

process.parentPort.on('message', (event) => {
  const port = event.ports[0]
  if ((event.data as { type?: unknown } | null)?.type !== HOST_PORT_MESSAGE || !port) return
  port.start()
  createAgentHost({
    channel: portChannel(port),
    createRuntime: (model, credential, modelConfig) => {
      if (credential) secrets.push(credential.apiKey)
      const host = createHostRuntime(model, credential, modelConfig)
      if (!traceFile) return host
      const write = (line: string) => appendFileSync(traceFile, `${line}\n`)
      return { ...host, runtime: traceHistory(host.runtime, write) }
    },
    exit: (code) => process.exit(code),
    createId: randomUUID,
    caseInsensitive: process.platform === 'win32',
    onError: reportError,
  })
})
