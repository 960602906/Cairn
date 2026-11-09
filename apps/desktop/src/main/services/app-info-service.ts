/**
 * 应用信息命令（M5-01）：关于页与诊断入口经 `app.info` 读取版本、通道与构建信息。
 * 只返回启动时解析好的结构，不读文件、不包含用户路径。
 */
import type { AppInfo } from '@cairn/protocol'

export interface AppInfoCommands {
  readonly info: () => AppInfo
}

export function createAppInfoCommands(getInfo: () => AppInfo): AppInfoCommands {
  return { info: () => getInfo() }
}
