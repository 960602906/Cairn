/**
 * 应用信息命令（M5-01）：关于页与诊断入口经 `app.info` 读取版本、通道与构建信息。
 * 只返回启动时解析好的结构，不读文件、不包含用户路径。
 */
import type { AppInfo, AppLicenses } from '@cairn/protocol'

export interface AppInfoCommands {
  readonly info: () => AppInfo
  /** 第三方许可声明（M5-07）；读取失败时返回 `available: false`。 */
  readonly licenses: () => AppLicenses
}

const NO_LICENSES: AppLicenses = { available: false, text: '', truncated: false }

export function createAppInfoCommands(
  getInfo: () => AppInfo,
  getLicenses: () => AppLicenses = () => NO_LICENSES,
): AppInfoCommands {
  return { info: () => getInfo(), licenses: () => getLicenses() }
}
