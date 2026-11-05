import { join } from 'node:path'
import { createMemoryStorage } from '@nexus/storage'
import { describe, expect, it } from 'vitest'
import { checkpointLocation } from './checkpoint-location.js'

describe('checkpointLocation', () => {
  it('uses one shadow repository per project and one ref per session', () => {
    const storage = createMemoryStorage({ now: () => 1 })
    storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
    storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: '/work', title: '' })
    storage.sessions.create({
      sessionId: 'a/b',
      projectId: 'p1',
      workspacePath: '/work',
      title: '',
    })
    expect(checkpointLocation('/data/checkpoints', storage, 's1')).toEqual({
      gitDir: join('/data/checkpoints', 'p1.git'),
      ref: 'refs/nexus/sessions/s1',
    })
    expect(checkpointLocation('/data/checkpoints', storage, 'missing')).toBeUndefined()
    expect(checkpointLocation('/data/checkpoints', storage, 'a/b')).toBeUndefined()
  })
})
