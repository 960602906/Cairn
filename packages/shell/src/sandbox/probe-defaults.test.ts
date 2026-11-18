import { describe, expect, it, vi } from 'vitest'

const loadCalls = vi.hoisted(() => [] as NodeJS.Platform[])

vi.mock('./windows-api.js', () => ({
  loadSandboxNativeApi: async (platform: NodeJS.Platform) => {
    loadCalls.push(platform)
    return {
      createRestrictedToken: () => 1n,
      closeHandle: () => undefined,
      deriveAppContainer: () => 2n,
    }
  },
}))

vi.mock('./job.js', () => ({
  createSandboxJob: async () => undefined,
}))

const { probeCapability } = await import('./probe.js')

describe('probeCapability 的默认参数', () => {
  it('不传平台时使用当前平台，不传 api 时按平台加载', async () => {
    const capability = await probeCapability({ api: null })
    // 只有 Windows 有命令沙箱；其他平台按不支持的平台返回原因
    if (process.platform === 'win32') {
      expect(capability).toMatchObject({ supported: true, reason: 'sandbox.native_unavailable' })
    } else {
      expect(capability).toMatchObject({
        supported: false,
        reason:
          process.platform === 'linux'
            ? 'sandbox.platform_unsupported_linux'
            : process.platform === 'darwin'
              ? 'sandbox.platform_unsupported_macos'
              : 'sandbox.platform_unsupported',
      })
    }
    expect(loadCalls).toEqual([])

    const loaded = await probeCapability({ platform: 'win32' })
    expect(loadCalls).toEqual(['win32'])
    // 默认 jobFactory 不可用：受限令牌可用但作业对象不可用，整体不可用
    expect(loaded).toMatchObject({
      available: false,
      checks: { restrictedToken: true, lowIntegrity: true, jobObject: false },
      reason: 'sandbox.restricted_token_unavailable',
    })
  })
})
