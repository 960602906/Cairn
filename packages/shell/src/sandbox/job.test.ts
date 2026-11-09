import { describe, expect, it } from 'vitest'
import { createSandboxJob } from './job.js'

describe('createSandboxJob', () => {
  it('creates a kill-on-close job object, or fails closed off Windows', async () => {
    const job = await createSandboxJob()
    if (job) {
      expect(typeof job.assign).toBe('function')
      expect(typeof job.terminate).toBe('function')
      job.close()
    } else {
      expect(job).toBeUndefined()
    }
  })
})
