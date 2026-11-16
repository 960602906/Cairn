import { describe, expect, it } from 'vitest'
import { sandboxPlatformSupport } from './platform.js'

describe('sandboxPlatformSupport', () => {
  it('Windows 支持命令沙箱', () => {
    expect(sandboxPlatformSupport('win32')).toEqual({ supported: true })
  })

  it('Linux 与 macOS 明确不支持，并区分原因', () => {
    expect(sandboxPlatformSupport('linux')).toEqual({
      supported: false,
      reason: 'sandbox.platform_unsupported_linux',
    })
    expect(sandboxPlatformSupport('darwin')).toEqual({
      supported: false,
      reason: 'sandbox.platform_unsupported_macos',
    })
  })

  it('其他平台使用通用原因', () => {
    expect(sandboxPlatformSupport('freebsd')).toEqual({
      supported: false,
      reason: 'sandbox.platform_unsupported',
    })
  })
})
