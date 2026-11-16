/**
 * 平台适配的统一入口（M6-01）。
 *
 * 共享包不直接比较 `process.platform`：平台差异收在这里的具名函数，调用方传入
 * `process.platform`（或测试用的假平台），新增平台只改这里，不触碰调用方。
 * 函数都是纯函数，便于用注入的平台标识覆盖每个分支。审计与动机见
 * [M6-00 预研报告](../../../docs/plan/m6-spikes.md) §3。
 */
import type { PathStyle } from './workspace-path.js'

/** 项目直接支持的平台。其余值按「其他平台」处理，语义与 posix 相同。 */
export type SupportedPlatform = 'win32' | 'darwin' | 'linux'

/** 是否为 Windows。 */
export function isWindows(platform: string): boolean {
  return platform === 'win32'
}

/** 是否为 macOS。 */
export function isMac(platform: string): boolean {
  return platform === 'darwin'
}

/** 是否为 Linux。 */
export function isLinux(platform: string): boolean {
  return platform === 'linux'
}

/**
 * 平台对应的路径风格：Windows 为 `win32`，其余（macOS、Linux）为 `posix`。
 *
 * 这是路径分隔符与文本语义的选择，与文件系统是否大小写敏感无关（见
 * `caseInsensitiveFileSystem`）。
 */
export function pathStyleFor(platform: string): PathStyle {
  return isWindows(platform) ? 'win32' : 'posix'
}

/**
 * 平台默认卷是否大小写不敏感：Windows 与 macOS 默认不敏感，Linux 敏感。
 *
 * 用于权限规则匹配与路径去重：若文件系统不区分大小写却做区分大小写的匹配，
 * 针对 `.env` 的拒绝规则可能被 `.ENV` 绕过。具体卷可以格式化得与默认相反
 * （例如 macOS 的大小写敏感 APFS），这里是保守默认；需要精确判断时由调用方探测文件系统。
 */
export function caseInsensitiveFileSystem(platform: string): boolean {
  return isWindows(platform) || isMac(platform)
}

/**
 * 平台的可执行文件名：Windows 上没有扩展名的名称追加 `.exe`，已带扩展名或其他平台原样返回。
 *
 * 例如 `platformBinaryName('rg', 'win32') === 'rg.exe'`，`platformBinaryName('rg', 'linux') === 'rg'`，
 * `platformBinaryName('git.exe', 'win32') === 'git.exe'`。
 */
export function platformBinaryName(name: string, platform: string): string {
  if (!isWindows(platform) || /\.[a-z0-9]+$/i.test(name)) return name
  return `${name}.exe`
}
