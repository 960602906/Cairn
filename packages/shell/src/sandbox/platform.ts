/**
 * 命令沙箱的平台能力（M6-05）：把“这个平台有没有可用的 OS 级命令沙箱”集中到一处。
 *
 * 只有 Windows 实现了命令沙箱（受限令牌 + 低完整性 + Job Object，ADR-0034）。Linux 与
 * macOS 尚未实现，返回明确的“不支持”与原因，调用方据此失败关闭；不得把“没有隔离”表述为
 * 已隔离，也不提供看起来可用、实际不生效的档位（ADR-0034 跨平台补记）。
 */

/** 平台不支持命令沙箱时的原因代码；界面按代码显示说明。 */
export type SandboxPlatformUnsupportedReason =
  | 'sandbox.platform_unsupported_linux'
  | 'sandbox.platform_unsupported_macos'
  | 'sandbox.platform_unsupported'

export type SandboxPlatformSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: SandboxPlatformUnsupportedReason }

/** 按平台给出命令沙箱能力。新增平台时只改这里，调用方保持不变。 */
export function sandboxPlatformSupport(platform: string): SandboxPlatformSupport {
  switch (platform) {
    case 'win32':
      return { supported: true }
    case 'linux':
      return { supported: false, reason: 'sandbox.platform_unsupported_linux' }
    case 'darwin':
      return { supported: false, reason: 'sandbox.platform_unsupported_macos' }
    default:
      return { supported: false, reason: 'sandbox.platform_unsupported' }
  }
}
