import { createMemoryStorage } from '@cairn/storage'
import { describe, expect, it, vi } from 'vitest'
import { createProjectService } from './project-service.js'

const ABS = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'
const CLONED = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'

function setup(
  picked: (string | undefined)[],
  options: {
    cloneRepository?: (input: {
      remoteUrl: string
      parentPath: string
      name: string
      branch?: string | undefined
    }) => Promise<string>
    readGitInfo?: (path: string) => Promise<{ branch?: string; branches?: string[] }>
    checkoutGitBranch?: (path: string, branch: string) => Promise<{ branch?: string }>
  } = {},
) {
  let clock = 0
  const storage = createMemoryStorage({ now: () => ++clock })
  let id = 0
  const service = createProjectService({
    storage,
    pickDirectory: async () => picked.shift(),
    ...(options.cloneRepository ? { cloneRepository: options.cloneRepository } : {}),
    ...(options.readGitInfo ? { readGitInfo: options.readGitInfo } : {}),
    ...(options.checkoutGitBranch ? { checkoutGitBranch: options.checkoutGitBranch } : {}),
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
        enableProjectSkills: true,
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

  it('returns a picked directory without opening it as a project', async () => {
    const { service } = setup([ABS])
    expect(await service.pickDirectory()).toEqual({ path: ABS })
    expect(await service.pickDirectory()).toEqual({})
    expect(service.list().projects).toEqual([])
  })

  it('clones a repository and registers it as a project', async () => {
    const cloneRepository = vi.fn(async () => CLONED)
    const { service } = setup([], { cloneRepository })
    expect(
      await service.clone({
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: process.platform === 'win32' ? 'C:\\work' : '/work',
      }),
    ).toMatchObject({
      project: { projectId: 'p1', name: 'repo', path: CLONED },
    })
    expect(cloneRepository).toHaveBeenCalledWith({
      remoteUrl: 'https://example.com/team/repo.git',
      parentPath: process.platform === 'win32' ? 'C:\\work' : '/work',
      name: 'repo',
    })
  })

  it('forwards an explicit name and branch and rejects missing clone support', async () => {
    const cloneRepository = vi.fn(async () => CLONED)
    const { service } = setup([], { cloneRepository })
    await service.clone({
      remoteUrl: 'https://example.com/team/repo.git',
      parentPath: process.platform === 'win32' ? 'C:\\work' : '/work',
      name: 'custom',
      branch: 'develop',
    })
    expect(cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'custom', branch: 'develop' }),
    )

    const unavailable = setup([]).service
    await expect(
      unavailable.clone({
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: process.platform === 'win32' ? 'C:\\work' : '/work',
      }),
    ).rejects.toMatchObject({ code: 'project.clone_unavailable' })
  })

  it('rejects a relative path', async () => {
    const { service } = setup(['relative/dir'])
    await expect(service.open()).rejects.toMatchObject({
      code: 'project.invalid_path',
      params: { path: 'relative/dir' },
    })
  })

  it('reads Git info for an absolute project path and degrades without Git support', async () => {
    const readGitInfo = vi.fn(async () => ({ branch: 'main', branches: ['main', 'dev'] }))
    const { service } = setup([], { readGitInfo })
    await expect(service.gitInfo({ path: ABS })).resolves.toEqual({
      branch: 'main',
      branches: ['main', 'dev'],
    })
    expect(readGitInfo).toHaveBeenCalledWith(ABS)
    await expect(service.gitInfo({ path: 'relative/dir' })).rejects.toMatchObject({
      code: 'project.invalid_path',
      params: { path: 'relative/dir' },
    })
    await expect(setup([]).service.gitInfo({ path: ABS })).resolves.toEqual({})
  })

  it('switches the Git branch for an absolute project path', async () => {
    const checkoutGitBranch = vi.fn(async () => ({ branch: 'dev' }))
    const { service } = setup([], { checkoutGitBranch })
    await expect(service.gitCheckout({ path: ABS, branch: 'dev' })).resolves.toEqual({
      branch: 'dev',
    })
    expect(checkoutGitBranch).toHaveBeenCalledWith(ABS, 'dev')
    await expect(
      service.gitCheckout({ path: 'relative/dir', branch: 'dev' }),
    ).rejects.toMatchObject({ code: 'project.invalid_path', params: { path: 'relative/dir' } })
    await expect(setup([]).service.gitCheckout({ path: ABS, branch: 'dev' })).rejects.toMatchObject(
      { code: 'project.git_unavailable' },
    )
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
    expect(service.update({ projectId: 'p1', pinned: true })).toMatchObject({
      isPinned: true,
      pinnedAt: expect.any(Number),
    })
    expect(service.update({ projectId: 'p1', archived: true })).toMatchObject({
      archivedAt: expect.any(Number),
    })
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

  it('uses a generated id and keeps a project unchanged for an empty patch', async () => {
    const storage = createMemoryStorage()
    const service = createProjectService({
      storage,
      pickDirectory: async () => ABS,
    })
    const opened = await service.open()
    expect(opened.project?.projectId).toMatch(/[0-9a-f-]{36}/)
    expect(service.update({ projectId: opened.project!.projectId })).toMatchObject({
      name: 'demo',
      path: ABS,
    })
  })
})
