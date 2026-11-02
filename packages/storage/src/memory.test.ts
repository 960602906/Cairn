import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from './memory.js'
import { describeStorageContract, userEvent } from './testing/store-contract.js'

describeStorageContract('memory', (now) => createMemoryStorage({ now }))

describe('createMemoryStorage', () => {
  it('uses Date.now by default', () => {
    const storage = createMemoryStorage()
    const before = Date.now()
    const project = storage.projects.create({ projectId: 'p', name: 'P', path: '/p' })
    expect(project.createdAt).toBeGreaterThanOrEqual(before)
    expect(project.createdAt).toBeLessThanOrEqual(Date.now())
  })

  it('refuses to be used after close', () => {
    const storage = createMemoryStorage()
    storage.close()
    expect(() => storage.projects.list()).toThrow('storage is closed')
    expect(() => storage.events.append([userEvent('s', 1)])).toThrow('storage is closed')
  })
})
