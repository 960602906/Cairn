/**
 * 端到端测试中与 agent 宿主进程相关的操作（M0-16b、M0-16c）：查找宿主进程，读取宿主收到的历史。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { HOST_TRACE_ENV, type HostTraceRecord } from '../src/agent-host/history-trace.js'
import { HOST_SERVICE_NAME } from '../src/main/services/host-process.js'
import { contentText } from './database.js'

/** 正在运行的宿主进程的 pid（`app.getAppMetrics()` 中名称为宿主服务名的进程）。 */
export function agentHostPids(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(
    ({ app }, name) =>
      app
        .getAppMetrics()
        .filter((metric) => metric.name === name)
        .map((metric) => metric.pid),
    HOST_SERVICE_NAME,
  )
}

/** 让宿主记录收到的历史（`history-trace.ts`），返回启动应用时要加的环境变量与记录文件。 */
export function hostTrace(userData: string) {
  const file = path.join(userData, 'host-trace.jsonl')
  return { env: { [HOST_TRACE_ENV]: file }, file }
}

/** 每次创建运行时会话收到的历史，每条消息简化为 `[role, 文本]`。 */
export function readHostHistories(file: string): [string, string][][] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) =>
      (JSON.parse(line) as HostTraceRecord).history.map((message): [string, string] => [
        message.role,
        contentText(message.content),
      ]),
    )
}
