import { createMemoryStorage } from '@cairn/storage'
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
    expect(first).toEqual({
      project: {
        projectId: 'p1',
        name: 'demo',
        path: ABS,
        createdAt: 1,
        sessionCount: 0,
        readAgentsMd: true,
        enableProjectSkills: false,
      },
    })
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

  it('renames, toggles and removes a project, then restores it when opened again', async () => {
    const { storage, service } = setup([ABS, ABS])
    await service.open()
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: ABS,
      title: '',
    })
    expect(
      service.update({ projectId: 'p1', name: '  示例  ', readAgentsMd: false }),
    ).toMatchObject({
      name: '示例',
      readAgentsMd: false,
      sessionCount: 1,
      lastUsedAt: 2,
    })
    expect(service.update({ projectId: 'p1', enableProjectSkills: true }).enableProjectSkills).toBe(
      true,
    )
    expect(service.remove({ projectId: 'p1' })).toEqual({})
    expect(service.list().projects).toEqual([])
    expect(storage.sessions.get('s1')?.projectId).toBe('p1')
    const again = await service.open()
    expect(again.project).toMatchObject({
      projectId: 'p1',
      name: '示例',
      readAgentsMd: false,
      enableProjectSkills: true,
      sessionCount: 1,
    })
  })

  it('rejects an empty name and a missing project', async () => {
    const { service } = setup([ABS])
    await service.open()
    expect(() => service.update({ projectId: 'p1', name: '   ' })).toThrow(
      expect.objectContaining({ code: 'project.invalid_name' }),
    )
    expect(() => service.update({ projectId: 'missing', name: 'x' })).toThrow(
      expect.objectContaining({ code: 'project.not_found' }),
    )
    service.remove({ projectId: 'p1' })
    expect(() => service.remove({ projectId: 'p1' })).toThrow(
      expect.objectContaining({ code: 'project.not_found' }),
    )
  })

  it('names a root directory after its path', async () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    const { service } = setup([root])
    expect((await service.open()).project).toMatchObject({ name: root, path: root })
  })
})
