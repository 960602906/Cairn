import { describe, expect, it, vi } from 'vitest'

vi.mock('../job-object.js', () => ({
  loadKernel32: async () => {
    throw new Error('koffi unavailable')
  },
  createJobObject: () => {
    throw new Error('should not create a job object')
  },
}))

const { createSandboxJob } = await import('./job.js')

describe('createSandboxJob（加载失败）', () => {
  it('koffi 不可用时失败关闭，返回 undefined', async () => {
    await expect(createSandboxJob()).resolves.toBeUndefined()
  })
})
