/**
 * 宿主历史记录的开关（端到端测试用，见 `agent-host/history-trace.ts`）。记录含对话原文，因此只在未打包
 * 的构建中生效：打包后的应用启动宿主时去掉这个环境变量。
 */
export const HOST_TRACE_ENV = 'NEXUS_HOST_TRACE_FILE'

/** 宿主进程的环境变量：打包后的应用去掉测试用的历史记录开关，其余原样传入。 */
export function hostEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || (packaged && key === HOST_TRACE_ENV)) continue
    out[key] = value
  }
  return out
}
