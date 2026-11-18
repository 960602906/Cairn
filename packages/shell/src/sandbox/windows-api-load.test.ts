import { describe, expect, it, vi } from 'vitest'

vi.mock('koffi', () => {
  throw new Error('koffi is not installed')
})

const { loadSandboxNativeApi } = await import('./windows-api.js')

describe('loadSandboxNativeApi', () => {
  it('非 Windows 返回 undefined', async () => {
    await expect(loadSandboxNativeApi('linux')).resolves.toBeUndefined()
  })

  it('koffi 加载失败时返回 undefined', async () => {
    await expect(loadSandboxNativeApi('win32')).resolves.toBeUndefined()
  })
})
