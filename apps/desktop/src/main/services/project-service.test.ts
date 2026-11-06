import { createMemoryStorage } from '@nexus/storage'
import { describe, expect, it } from 'vitest'
import { createProjectService } from './project-service.js'

const ABS = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'

function setup(picked: (string | undefined)[]) {
  let clock = 0
  const storage = createMemoryStorage({ now: () => ++clock })
  let id = 0
  const service = createProjectService({
    storage,
    pickDirectory: async () => picked.shift(),
    createId: () => `p${++id}`,
  })
  return { storage, service }
}

describe('project service', () => {
  it('opens a directory as a project, reusing an existing record', async () => {
    const { service } = setup([ABS, ABS])
    expect(service.list()).toEqual({ projects: [] })
    const first = await service.open()
    expect(first).toEqual({ project: { projectId: 'p1', name: 'demo', path: ABS, createdAt: 1 } })
    expect(await service.open()).toEqual(first)
    expect(service.list().projects).toEqual([first.project])
  })

  it('returns no project when the dialog is cancelled', async () => {
    const { service } = setup([undefined])
    expect(await service.open()).toEqual({})
    expect(service.list().projects).toEqual([])
  })

  it('rejects a relative path', async () => {
    const { service } = setup(['relative/dir'])
    await expect(service.open()).rejects.toMatchObject({
      code: 'project.invalid_path',
      params: { path: 'relative/dir' },
    })
  })

  it('names a root directory after its path', async () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    const { service } = setup([root])
    expect((await service.open()).project).toMatchObject({ name: root, path: root })
  })
})
