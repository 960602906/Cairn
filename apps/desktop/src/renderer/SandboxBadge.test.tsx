// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { SandboxExecution } from '@cairn/protocol'
import { SandboxBadge } from './SandboxBadge.js'

const i18n = createI18n('zh-CN')
afterEach(cleanup)

const execution = (over: Partial<SandboxExecution> = {}): SandboxExecution => ({
  profile: 'workspace-write',
  network: 'none',
  mechanism: 'restricted-token',
  enforced: true,
  networkIsolated: false,
  ...over,
})

const badge = (props: Parameters<typeof SandboxBadge>[0]) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SandboxBadge {...props} />
    </I18nextProvider>,
  )

describe('SandboxBadge', () => {
  it('shows the actual profile and exposes it as data attributes', () => {
    badge({ execution: execution({ profile: 'read-only' }) })
    const el = screen.getByTestId('sandbox-badge')
    expect(el.getAttribute('data-sandbox-profile')).toBe('read-only')
    expect(el.getAttribute('data-sandbox-enforced')).toBe('true')
    expect(el.className).toContain('text-muted')
    expect(el.textContent).toBe('沙箱：只读 · 网络未隔离')
    expect(el.getAttribute('title')).toContain('受限令牌机制不能隔离网络')
  })

  it('gives a sandboxed command with an isolated network no warning', () => {
    badge({ execution: execution({ mechanism: 'appcontainer', networkIsolated: true }) })
    const el = screen.getByTestId('sandbox-badge')
    expect(el.textContent).toBe('沙箱：工作区可写 · 无网络')
    expect(el.getAttribute('title')).toBe('沙箱：工作区可写 · 无网络')
  })

  it('marks an unsandboxed command in the danger color with the reason', () => {
    badge({
      execution: execution({
        enforced: false,
        mechanism: 'none',
        reason: 'sandbox.full_access',
      }),
    })
    const el = screen.getByTestId('sandbox-badge')
    expect(el.getAttribute('data-sandbox-enforced')).toBe('false')
    expect(el.className).toContain('text-danger')
    expect(el.textContent).toBe('未沙箱化：这条命令不使用沙箱')
    expect(el.getAttribute('title')).toContain('这条命令将在命令沙箱之外运行')
  })

  it('supports a compact layout', () => {
    badge({ execution: execution(), compact: true })
    expect(screen.getByTestId('sandbox-badge').className).toContain('max-w-[230px]')
  })
})
