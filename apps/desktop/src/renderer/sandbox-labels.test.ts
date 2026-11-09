import { describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SandboxExecution } from '@cairn/protocol'
import { sandboxLabels, sandboxReason } from './sandbox-labels.js'

const t = createI18n('zh-CN').getFixedT('zh-CN', 'common')
const execution = (over: Partial<SandboxExecution> = {}): SandboxExecution => ({
  profile: 'workspace-write',
  network: 'none',
  mechanism: 'restricted-token',
  enforced: true,
  networkIsolated: false,
  ...over,
})

describe('sandboxLabels', () => {
  it('describes an enforced sandbox with an isolated network', () => {
    const labels = sandboxLabels(t, execution({ mechanism: 'appcontainer', networkIsolated: true }))
    expect(labels.profile).toBe('工作区可写')
    expect(labels.mechanism).toBe('AppContainer')
    expect(labels.network).toBe('无网络')
    expect(labels.summary).toBe('沙箱：工作区可写 · 无网络')
    expect(labels.warning).toBeUndefined()
    expect(labels.reason).toBeUndefined()
  })

  it('warns that the restricted-token mechanism cannot isolate the network', () => {
    const labels = sandboxLabels(t, execution())
    expect(labels.network).toBe('网络未隔离')
    expect(labels.summary).toBe('沙箱：工作区可写 · 网络未隔离')
    expect(labels.warning).toBe('受限令牌机制不能隔离网络，命令仍可连接网络。')
  })

  it('explains why a command runs outside the sandbox', () => {
    const labels = sandboxLabels(
      t,
      execution({ enforced: false, mechanism: 'none', reason: 'sandbox.unavailable' }),
    )
    expect(labels.reason).toBe('沙箱不可用')
    expect(labels.summary).toBe('未沙箱化：沙箱不可用')
    expect(labels.network).toBe('网络未隔离')
    expect(labels.warning).toContain('这条命令将在命令沙箱之外运行')
  })

  it('falls back for unknown or missing reason codes', () => {
    expect(sandboxReason(t, 'sandbox.not_a_code')).toBe('原因未知')
    expect(sandboxReason(t, undefined)).toBe('沙箱不可用')
  })

  it('maps nested reason codes from error identifiers', () => {
    expect(sandboxReason(t, 'sandbox.setup_failed')).toBe('沙箱准备失败')
    expect(sandboxReason(t, 'sandbox.appcontainer.unavailable')).toBe('AppContainer 不可用')
  })
})
