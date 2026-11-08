/**
 * 改动集（M4-09）的真实 Git 集成测试：用影子仓库为项目建基线提交，再按生产路径创建隔离工作区、
 * 修改文件、生成改动集并合并回主工作区。断言只看主工作区的实际内容、数据库记录与事件，不依赖服务
 * 内部状态。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGitRunner, isolatedGitEnv, openShadowRepo, type ShadowRepo } from '@cairn/checkpoint'
import { createMemoryStorage, type Storage } from '@cairn/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlobStore } from './blob-store.js'
import {
  CHANGE_SET_MAX_FILE_BYTES,
  CHANGE_SET_MAX_PATCH_BYTES,
  ChangeSetErrorCode,
  createChangeSetService,
  type ChangeSetService,
  type ChangeSetServiceOptions,
} from './change-set-service.js'
import { createWorkspaceService, type WorkspaceService } from './workspace-service.js'

let tmp: string
let project: string
let gitDir: string
let worktreeRoot: string
let blobDir: string
let storage: Storage
let workspaces: WorkspaceService
let repo: ShadowRepo
let checkpoints: { create(sessionId: string): Promise<{ checkpointId: string }> }
let published: { type: string; payload: Record<string, unknown> }[]
let busy: Set<string>
let service: ChangeSetService
let baseCommit: string
let ids: number

const projectFile = (rel: string) => path.join(project, ...rel.split('/'))

const writeProject = (rel: string, content: string | Uint8Array) => {
  const file = projectFile(rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const readProject = (rel: string) => fs.readFileSync(projectFile(rel))
const textProject = (rel: string) => readProject(rel).toString('utf8')
const projectHas = (rel: string) => fs.existsSync(projectFile(rel))

const workspacePath = (runId = 'r1') => path.join(worktreeRoot, 's1', runId)
const workspaceFile = (rel: string, runId = 'r1') =>
  path.join(workspacePath(runId), ...rel.split('/'))

const writeWorkspace = (rel: string, content: string | Uint8Array, runId = 'r1') => {
  const file = workspaceFile(rel, runId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const removeWorkspace = (rel: string, runId = 'r1') =>
  fs.rmSync(workspaceFile(rel, runId), { force: true })

async function isolate(runId = 'r1') {
  return workspaces.createIsolated({
    projectPath: project,
    gitDir,
    baseCommit,
    sessionId: 's1',
    runId,
  })
}

const createChangeSet = (runId = 'r1', parentRunId = 'run-parent') =>
  service.create({ sessionId: 's1', runId, parentRunId })

/** `list` / `get` 是同步的，直接调用会抛错。 */
const expectSyncCode = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected ${code}`)
}

const serviceOptions = () => ({
  storage,
  blobs: createBlobStore(blobDir),
  events: {
    publish: (batch: readonly { type: string; payload: unknown }[]) => {
      for (const event of batch) {
        published.push({ type: event.type, payload: event.payload as Record<string, unknown> })
      }
      return []
    },
  },
  workspaces,
  checkpoints,
  git: createGitRunner({
    env: isolatedGitEnv(process.env, path.join(worktreeRoot, 'no-global-config')),
  }),
  isBusy: (sessionId: string) => busy.has(sessionId),
  now: () => 100,
  createId: () => `cs-${++ids}`,
})

const makeService = (overrides: Partial<ChangeSetServiceOptions> = {}) =>
  createChangeSetService({ ...serviceOptions(), ...overrides })

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-changeset-'))
  project = path.join(tmp, 'project')
  gitDir = path.join(tmp, 'checkpoints', 'p1.git')
  worktreeRoot = path.join(tmp, 'worktrees')
  blobDir = path.join(tmp, 'blobs')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.dirname(gitDir), { recursive: true })
  writeProject('src/a.ts', 'export const a = 1\n')
  writeProject('src/b.ts', 'export const b = 1\n')
  writeProject('docs/guide.md', '# Guide\n')
  writeProject('node_modules/dep/index.js', 'dep\n')
  repo = await openShadowRepo({
    gitDir,
    workTree: project,
    extraExcludes: ['node_modules/', '.venv/'],
  })
  baseCommit = (await repo.checkpoint('baseline')).commit

  storage = createMemoryStorage({ now: () => 100 })
  storage.projects.create({ projectId: 'p1', name: 'Demo', path: project })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: project,
    title: 'Demo',
  })
  workspaces = createWorkspaceService({ root: worktreeRoot })
  published = []
  busy = new Set()
  ids = 0
  checkpoints = {
    create: async () => ({ checkpointId: (await repo.checkpoint('before merge')).commit }),
  }
  service = makeService()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('create', () => {
  it('computes added, modified and removed files with patches and line counts', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'export const a = 2\nexport const c = 3\n')
    writeWorkspace('src/new.ts', 'export const created = true\n')
    removeWorkspace('docs/guide.md')

    const created = await createChangeSet()
    expect(created).toEqual({
      changeSetId: 'cs-1',
      files: [
        { path: 'docs/guide.md', added: 0, removed: 1 },
        { path: 'src/a.ts', added: 2, removed: 1 },
        { path: 'src/new.ts', added: 1, removed: 0 },
      ],
    })

    const { changeSet } = service.get({ sessionId: 's1', changeSetId: 'cs-1' })
    expect(changeSet).toMatchObject({
      changeSetId: 'cs-1',
      sessionId: 's1',
      runId: 'r1',
      parentRunId: 'run-parent',
      baseCommit,
      status: 'pending',
      createdAt: 100,
      conflicts: 0,
    })
    expect(changeSet.files.map((file) => [file.path, file.kind, file.binary, file.large])).toEqual([
      ['docs/guide.md', 'removed', false, false],
      ['src/a.ts', 'modified', false, false],
      ['src/new.ts', 'added', false, false],
    ])
    const modified = changeSet.files.find((file) => file.path === 'src/a.ts')!
    expect(modified.patch).toContain('-export const a = 1')
    expect(modified.patch).toContain('+export const a = 2')
    expect(modified.patch).toContain('+export const c = 3')

    expect(published).toEqual([
      {
        type: 'changeset.created',
        payload: {
          changeSetId: 'cs-1',
          childRunId: 'r1',
          files: 3,
          added: 3,
          removed: 2,
        },
      },
    ])
  })

  it('records an empty change set when the child changed nothing', async () => {
    await isolate()
    const created = await createChangeSet()
    expect(created.files).toEqual([])
    expect(published[0]).toMatchObject({
      type: 'changeset.created',
      payload: { files: 0, added: 0, removed: 0 },
    })
    const applied = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(applied).toEqual({
      changeSet: expect.objectContaining({ status: 'applied' }),
      applied: [],
      conflicts: [],
    })
  })

  it('lists applied change sets without a parent run id', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await service.create({ sessionId: 's1', runId: 'r1' })
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })

    const { changeSets } = service.list({ sessionId: 's1' })
    expect(changeSets[0]).toMatchObject({
      changeSetId: created.changeSetId,
      runId: 'r1',
      status: 'applied',
      mergedAt: 100,
    })
    expect(changeSets[0]).not.toHaveProperty('parentRunId')
  })

  it('lists change sets with totals and reads them by session', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'changed\n')
    await createChangeSet()
    await isolate('r2')
    writeWorkspace('src/b.ts', 'changed\n', 'r2')
    writeWorkspace('src/extra.ts', 'x\n', 'r2')
    await createChangeSet('r2')

    const { changeSets } = service.list({ sessionId: 's1' })
    expect(
      changeSets.map((item) => [item.changeSetId, item.files, item.added, item.removed]),
    ).toEqual([
      ['cs-1', 1, 1, 1],
      ['cs-2', 2, 2, 1],
    ])
    expect(changeSets[1]).toMatchObject({
      runId: 'r2',
      parentRunId: 'run-parent',
      status: 'pending',
    })
  })

  it('rejects unknown sessions and workspaces', async () => {
    await expect(service.create({ sessionId: 'missing', runId: 'r1' })).rejects.toMatchObject({
      code: ChangeSetErrorCode.NotFound,
    })
    await expect(createChangeSet('missing')).rejects.toMatchObject({
      code: ChangeSetErrorCode.NotFound,
    })
  })

  it('rejects a workspace created for another session', async () => {
    await isolate()
    storage.projects.create({
      projectId: 'p2',
      name: 'Other',
      path: path.join(tmp, 'other'),
    })
    storage.sessions.create({
      sessionId: 's2',
      projectId: 'p2',
      workspacePath: path.join(tmp, 'other'),
      title: 'Other',
    })
    await expect(service.create({ sessionId: 's2', runId: 'r1' })).rejects.toMatchObject({
      code: ChangeSetErrorCode.NotFound,
    })
  })

  it('ignores malformed, symbolic link and submodule baseline records', async () => {
    await isolate()
    const oid = 'a'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          const records = [
            `100644 blob ${oid}\tsrc/a.ts`,
            'malformed',
            `120000 blob ${oid}\tsrc/link`,
            `160000 commit ${oid}\tsrc/submodule`,
            '',
          ]
          return {
            code: 0,
            stdout: Buffer.from(records.join('\0')),
            stderr: '',
          }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'missing' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.map((file) => file.path)).toEqual([
      'docs/guide.md',
      'src/a.ts',
      'src/b.ts',
    ])
  })

  it('falls back to reading the blob when git reports an invalid size', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const oid = 'c'.repeat(40)
    const baseline = 'export const a = 1\n'
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tsrc/a.ts\0`),
            stderr: '',
          }
        }
        if (args.includes('-s')) {
          return { code: 0, stdout: Buffer.from('not-a-size'), stderr: '' }
        }
        if (args.includes('blob')) {
          return { code: 0, stdout: Buffer.from(baseline), stderr: '' }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: '' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'src/a.ts')).toMatchObject({
      kind: 'modified',
      large: false,
    })
  })
})

describe('apply', () => {
  it('merges every file after creating a checkpoint and publishes the applied event', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'export const a = 2\n')
    writeWorkspace('src/new.ts', 'created\n')
    removeWorkspace('docs/guide.md')
    const created = await createChangeSet()

    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.applied).toEqual(['docs/guide.md', 'src/a.ts', 'src/new.ts'])
    expect(result.conflicts).toEqual([])
    expect(textProject('src/a.ts')).toBe('export const a = 2\n')
    expect(textProject('src/new.ts')).toBe('created\n')
    expect(projectHas('docs/guide.md')).toBe(false)
    expect(result.changeSet).toMatchObject({
      status: 'applied',
      mergedAt: 100,
      checkpointCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(published.at(-1)).toEqual({
      type: 'changeset.applied',
      payload: {
        changeSetId: created.changeSetId,
        paths: ['docs/guide.md', 'src/a.ts', 'src/new.ts'],
        checkpointCommit: result.changeSet.checkpointCommit,
      },
    })
  })

  it('can be rolled back by restoring the checkpoint taken before the merge', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'export const a = 2\n')
    writeWorkspace('src/new.ts', 'created\n')
    const created = await createChangeSet()
    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(textProject('src/a.ts')).toBe('export const a = 2\n')

    await repo.restore(result.changeSet.checkpointCommit!)
    expect(textProject('src/a.ts')).toBe('export const a = 1\n')
    expect(projectHas('src/new.ts')).toBe(false)
  })

  it('accepts files one by one and keeps the change set pending until every file is resolved', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child a\n')
    writeWorkspace('src/b.ts', 'child b\n')
    const created = await createChangeSet()

    const first = await service.apply({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      paths: ['src/a.ts'],
    })
    expect(first.applied).toEqual(['src/a.ts'])
    expect(first.changeSet.status).toBe('pending')
    expect(textProject('src/a.ts')).toBe('child a\n')
    expect(textProject('src/b.ts')).toBe('export const b = 1\n')

    const second = await service.reject({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      paths: ['src/b.ts'],
    })
    expect(second.changeSet.status).toBe('applied')
    expect(second.changeSet.files.map((file) => [file.path, file.status])).toEqual([
      ['src/a.ts', 'accepted'],
      ['src/b.ts', 'rejected'],
    ])
  })

  it('rejects the whole change set without touching the workspace', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    const result = await service.reject({
      sessionId: 's1',
      changeSetId: created.changeSetId,
    })
    expect(result.changeSet.status).toBe('rejected')
    expect(result.changeSet.files[0]?.status).toBe('rejected')
    expect(textProject('src/a.ts')).toBe('export const a = 1\n')
    expect(published.at(-1)).toEqual({
      type: 'changeset.rejected',
      payload: { changeSetId: created.changeSetId },
    })
  })

  it('merges after the isolated workspace has been cleaned up', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'survives cleanup\n')
    const created = await createChangeSet()
    expect(await workspaces.cleanup('r1')).toBe(true)
    expect(fs.existsSync(workspacePath())).toBe(false)

    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.applied).toEqual(['src/a.ts'])
    expect(textProject('src/a.ts')).toBe('survives cleanup\n')
  })

  it('refuses to change a change set that is no longer pending', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotPending })
    await expect(
      service.reject({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotPending })
  })

  it('rejects unknown paths and refuses to merge while the session is busy', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    await expect(
      service.apply({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        paths: ['src/missing.ts'],
      }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotFound })
    await expect(
      service.reject({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        paths: ['src/missing.ts'],
      }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotFound })

    busy.add('s1')
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.Busy })
    busy.clear()
  })

  it('rejects change sets that belong to another session', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    storage.projects.create({
      projectId: 'p2',
      name: 'Other',
      path: path.join(tmp, 'other'),
    })
    storage.sessions.create({
      sessionId: 's2',
      projectId: 'p2',
      workspacePath: project,
      title: 'Other',
    })
    expectSyncCode(
      () => service.get({ sessionId: 's2', changeSetId: created.changeSetId }),
      ChangeSetErrorCode.NotFound,
    )
    await expect(
      service.apply({ sessionId: 's2', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotFound })
    expectSyncCode(
      () => service.get({ sessionId: 's1', changeSetId: 'missing' }),
      ChangeSetErrorCode.NotFound,
    )
  })
})

describe('conflicts', () => {
  it('marks a file as a conflict when the main workspace changed after the baseline', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    writeProject('src/a.ts', 'main\n')

    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.applied).toEqual([])
    expect(result.conflicts).toEqual(['src/a.ts'])
    expect(textProject('src/a.ts')).toBe('main\n')
    expect(result.changeSet).toMatchObject({ status: 'pending', conflicts: 1 })
    expect(result.changeSet.files[0]?.status).toBe('conflict')
    expect(published.at(-1)).toEqual({
      type: 'changeset.conflict',
      payload: { changeSetId: created.changeSetId, path: 'src/a.ts', resolution: 'pending' },
    })
  })

  it('keeps the main workspace version when resolving with keep-main', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    writeProject('src/a.ts', 'main\n')
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })

    const result = await service.resolveConflict({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      path: 'src/a.ts',
      resolution: 'keep-main',
    })
    expect(textProject('src/a.ts')).toBe('main\n')
    expect(result.changeSet.status).toBe('rejected')
    expect(result.changeSet.files[0]?.status).toBe('rejected')
    expect(published.at(-1)).toMatchObject({
      type: 'changeset.conflict',
      payload: { resolution: 'keep-main' },
    })
  })

  it('takes the child version when resolving with take-child', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    writeProject('src/a.ts', 'main\n')
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })

    const result = await service.resolveConflict({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      path: 'src/a.ts',
      resolution: 'take-child',
    })
    expect(textProject('src/a.ts')).toBe('child\n')
    expect(result.changeSet.status).toBe('applied')
    expect(result.changeSet.files[0]?.status).toBe('accepted')
    expect(published.at(-1)).toMatchObject({
      type: 'changeset.conflict',
      payload: { resolution: 'take-child' },
    })
  })

  it('reuses the merge checkpoint when taking the child version after a partial merge', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child a\n')
    writeWorkspace('src/b.ts', 'child b\n')
    const created = await createChangeSet()
    writeProject('src/b.ts', 'main b\n')
    const applied = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(applied.applied).toEqual(['src/a.ts'])
    expect(applied.conflicts).toEqual(['src/b.ts'])
    const checkpoint = applied.changeSet.checkpointCommit
    expect(checkpoint).toMatch(/^[0-9a-f]{40}$/)

    const resolved = await service.resolveConflict({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      path: 'src/b.ts',
      resolution: 'take-child',
    })
    expect(resolved.changeSet.checkpointCommit).toBe(checkpoint)
    expect(textProject('src/b.ts')).toBe('child b\n')
  })

  it('creates a checkpoint when taking the child version without a previous merge', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    writeProject('src/a.ts', 'main\n')
    const applied = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    // 只有冲突时没有写文件，因此还没有检查点。
    expect(applied.changeSet.checkpointCommit).toBeUndefined()

    const resolved = await service.resolveConflict({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      path: 'src/a.ts',
      resolution: 'take-child',
    })
    expect(resolved.changeSet.checkpointCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(textProject('src/a.ts')).toBe('child\n')
  })

  it('leaves the file for manual handling', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    writeProject('src/a.ts', 'main\n')
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })

    const result = await service.resolveConflict({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      path: 'src/a.ts',
      resolution: 'manual',
    })
    expect(textProject('src/a.ts')).toBe('main\n')
    expect(result.changeSet.status).toBe('pending')
    expect(result.changeSet.files[0]?.status).toBe('manual')
  })

  it('conflicts when an added file already exists and when a removed file changed', async () => {
    await isolate()
    writeWorkspace('src/new.ts', 'child\n')
    removeWorkspace('src/b.ts')
    const created = await createChangeSet()
    writeProject('src/new.ts', 'already here\n')
    writeProject('src/b.ts', 'main changed it\n')

    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.conflicts).toEqual(['src/b.ts', 'src/new.ts'])
    expect(textProject('src/new.ts')).toBe('already here\n')
    expect(textProject('src/b.ts')).toBe('main changed it\n')
  })

  it('does not conflict when the main workspace still matches the baseline', async () => {
    await isolate()
    removeWorkspace('src/b.ts')
    const created = await createChangeSet()
    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.conflicts).toEqual([])
    expect(result.applied).toEqual(['src/b.ts'])
    expect(projectHas('src/b.ts')).toBe(false)
  })

  it('rejects resolving an unknown path and refuses to write while busy', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    await expect(
      service.resolveConflict({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        path: 'src/missing.ts',
        resolution: 'manual',
      }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotFound })

    writeProject('src/a.ts', 'main\n')
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    busy.add('s1')
    await expect(
      service.resolveConflict({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        path: 'src/a.ts',
        resolution: 'take-child',
      }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.Busy })
  })
})

describe('binary and large files', () => {
  it('records binary files without a patch and still merges them', async () => {
    const binary = Buffer.from([0, 1, 2, 3, 0, 255])
    writeProject('assets/logo.bin', Buffer.from([0, 9, 9]))
    baseCommit = (await repo.checkpoint('binary baseline')).commit
    await isolate()
    writeWorkspace('assets/logo.bin', binary)

    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files[0]).toMatchObject({
      path: 'assets/logo.bin',
      kind: 'modified',
      binary: true,
      large: false,
      added: 0,
      removed: 0,
    })
    expect(changeSet.files[0]?.patch).toBeUndefined()

    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(readProject('assets/logo.bin').equals(binary)).toBe(true)
  })

  it('records a large text file without a patch but still merges it', async () => {
    await isolate()
    const big = 'x'.repeat(CHANGE_SET_MAX_PATCH_BYTES + 10)
    writeWorkspace('big.txt', big)
    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files[0]).toMatchObject({
      path: 'big.txt',
      kind: 'added',
      large: true,
      binary: false,
    })
    expect(changeSet.files[0]?.patch).toBeUndefined()
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(textProject('big.txt')).toBe(big)
  })

  it('records a removed binary file without a patch', async () => {
    writeProject('assets/logo.bin', Buffer.from([0, 1, 2]))
    baseCommit = (await repo.checkpoint('binary baseline')).commit
    await isolate()
    removeWorkspace('assets/logo.bin')
    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'assets/logo.bin')).toMatchObject({
      kind: 'removed',
      binary: true,
    })
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(projectHas('assets/logo.bin')).toBe(false)
  })

  it('records an added binary file without a patch and merges it', async () => {
    const binary = Buffer.from([0, 7, 8, 0, 255])
    await isolate()
    writeWorkspace('assets/new.bin', binary)
    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'assets/new.bin')).toMatchObject({
      kind: 'added',
      binary: true,
      large: false,
      added: 0,
      removed: 0,
    })
    expect(changeSet.files.find((file) => file.path === 'assets/new.bin')?.patch).toBeUndefined()

    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(readProject('assets/new.bin').equals(binary)).toBe(true)
  })

  it('treats a baseline file above the read limit as manual', async () => {
    await isolate()
    const oid = 'b'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tsrc/a.ts\0`),
            stderr: '',
          }
        }
        if (args.includes('-s')) {
          return {
            code: 0,
            stdout: Buffer.from(String(CHANGE_SET_MAX_FILE_BYTES + 1)),
            stderr: '',
          }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: '' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'src/a.ts')).toMatchObject({
      kind: 'modified',
      status: 'manual',
      large: true,
    })
  })

  it('marks an oversized edit to a baseline file as manual', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'x'.repeat(CHANGE_SET_MAX_FILE_BYTES + 1))
    const oid = 'd'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tsrc/a.ts\0`),
            stderr: '',
          }
        }
        if (args.includes('-s')) {
          return {
            code: 0,
            stdout: Buffer.from(String(CHANGE_SET_MAX_FILE_BYTES + 1)),
            stderr: '',
          }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: '' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'src/a.ts')).toMatchObject({
      kind: 'modified',
      status: 'manual',
      large: true,
    })
  })

  it('marks a removed baseline file above the read limit as manual', async () => {
    await isolate()
    const oid = 'e'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tgone.txt\0`),
            stderr: '',
          }
        }
        if (args.includes('-s')) {
          return {
            code: 0,
            stdout: Buffer.from(String(CHANGE_SET_MAX_FILE_BYTES + 1)),
            stderr: '',
          }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: '' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'gone.txt')).toMatchObject({
      kind: 'removed',
      status: 'manual',
      large: true,
    })
  })

  it('leaves files above the read limit for manual handling', async () => {
    await isolate()
    writeWorkspace('huge.txt', 'y'.repeat(CHANGE_SET_MAX_FILE_BYTES + 1))
    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files[0]).toMatchObject({
      path: 'huge.txt',
      status: 'manual',
      kind: 'added',
      large: true,
    })

    const applied = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(applied.applied).toEqual([])
    expect(projectHas('huge.txt')).toBe(false)

    const explicit = await service.apply({
      sessionId: 's1',
      changeSetId: created.changeSetId,
      paths: ['huge.txt'],
    })
    expect(explicit.applied).toEqual(['huge.txt'])
    expect(explicit.changeSet.status).toBe('applied')
    expect(projectHas('huge.txt')).toBe(false)
  })
})

describe('real Git history', () => {
  it('treats a path whose case changed as a removal plus an addition', async () => {
    await isolate()
    const source = workspaceFile('src/a.ts')
    const renamed = workspaceFile('src/A.ts')
    fs.renameSync(source, renamed)

    const created = await createChangeSet()
    const { changeSet } = service.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.map((file) => [file.path, file.kind])).toEqual([
      ['src/A.ts', 'added'],
      ['src/a.ts', 'removed'],
    ])
  })

  it('ignores shared dependency directories and symbolic links', async () => {
    await isolate()
    fs.writeFileSync(workspaceFile('node_modules/dep/index.js'), 'changed\n')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n')
    fs.symlinkSync(
      outside,
      workspaceFile('linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const created = await createChangeSet()
    expect(created.files).toEqual([])
  })
})

describe('failure paths', () => {
  const failingGit = {
    binary: 'git',
    run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'boom' }),
  }

  it('reports a failed baseline read and calls the error hook', async () => {
    await isolate()
    const onError = vi.fn()
    const custom = makeService({
      git: {
        binary: 'git',
        run: async () => {
          throw new Error('cannot spawn git')
        },
      },
      onError,
    })
    await expect(custom.create({ sessionId: 's1', runId: 'r1' })).rejects.toMatchObject({
      code: ChangeSetErrorCode.Failed,
    })
    expect(onError).toHaveBeenCalled()
  })

  it('reports a non-zero ls-tree exit as a failure', async () => {
    await isolate()
    const custom = makeService({ git: failingGit })
    await expect(custom.create({ sessionId: 's1', runId: 'r1' })).rejects.toMatchObject({
      code: ChangeSetErrorCode.Failed,
    })
  })

  it('treats a baseline entry whose blob is missing as an addition', async () => {
    await isolate()
    const oid = 'b'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tsrc/a.ts\0`),
            stderr: '',
          }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'missing' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.find((file) => file.path === 'src/a.ts')).toMatchObject({
      kind: 'added',
      added: 1,
    })
  })

  it('treats a missing isolated directory as deleting every baseline file', async () => {
    await isolate()
    fs.rmSync(workspacePath(), { recursive: true, force: true })
    const created = await createChangeSet()
    // 目录不见了：基线里的文件都算删除。
    expect(created.files).toEqual([
      { path: 'docs/guide.md', added: 0, removed: 1 },
      { path: 'src/a.ts', added: 0, removed: 1 },
      { path: 'src/b.ts', added: 0, removed: 1 },
    ])
  })

  it('treats a non-directory workspace as empty', async () => {
    await isolate()
    fs.rmSync(workspacePath(), { recursive: true, force: true })
    fs.writeFileSync(workspacePath(), 'not a directory')
    const created = await createChangeSet()
    expect(created.files).toEqual([
      { path: 'docs/guide.md', added: 0, removed: 1 },
      { path: 'src/a.ts', added: 0, removed: 1 },
      { path: 'src/b.ts', added: 0, removed: 1 },
    ])
  })

  it('skips a missing baseline blob for a file removed from the workspace', async () => {
    await isolate()
    const oid = 'f'.repeat(40)
    const git = {
      binary: 'git',
      run: async (args: readonly string[]) => {
        if (args.includes('ls-tree')) {
          return {
            code: 0,
            stdout: Buffer.from(`100644 blob ${oid}\tgone.txt\0`),
            stderr: '',
          }
        }
        if (args.includes('-s')) {
          return { code: 0, stdout: Buffer.from('1'), stderr: '' }
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'missing' }
      },
    }
    const custom = makeService({ git })
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    const { changeSet } = custom.get({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(changeSet.files.some((file) => file.path === 'gone.txt')).toBe(false)
  })

  it('reports a missing blob when a file has no stored content', async () => {
    await isolate()
    const created = await createChangeSet()
    storage.changeSets.addFile({
      changeSetId: created.changeSetId,
      path: 'ghost.txt',
      kind: 'added',
      added: 1,
      removed: 0,
      binary: false,
      large: false,
    })
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.BlobMissing })
  })

  it('reports a missing content blob when the stored hash is present', async () => {
    await isolate()
    const created = await createChangeSet()
    storage.changeSets.addFile({
      changeSetId: created.changeSetId,
      path: 'ghost.txt',
      kind: 'added',
      added: 1,
      removed: 0,
      binary: false,
      large: false,
      contentHash: 'f'.repeat(64),
    })
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.BlobMissing })
  })

  it('rejects a stored path outside the workspace', async () => {
    await isolate()
    const created = await createChangeSet()
    storage.changeSets.addFile({
      changeSetId: created.changeSetId,
      path: '../escape.txt',
      kind: 'added',
      added: 1,
      removed: 0,
      binary: false,
      large: false,
      contentHash: 'a'.repeat(64),
    })
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: 'path.outside_workspace' })
    expect(fs.existsSync(path.join(project, '..', 'escape.txt'))).toBe(false)
  })

  it('refuses to write a conflict whose stored path escapes the workspace', async () => {
    await isolate()
    const created = await createChangeSet()
    storage.changeSets.addFile({
      changeSetId: created.changeSetId,
      path: '../escape.txt',
      kind: 'added',
      added: 1,
      removed: 0,
      binary: false,
      large: false,
      contentHash: 'a'.repeat(64),
    })
    storage.changeSets.setFileStatus(created.changeSetId, '../escape.txt', 'conflict')
    await expect(
      service.resolveConflict({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        path: '../escape.txt',
        resolution: 'take-child',
      }),
    ).rejects.toMatchObject({ code: 'path.outside_workspace' })
  })

  it('reports a failed write to the main workspace', async () => {
    await isolate()
    writeWorkspace('src/blocked/x.ts', 'x\n')
    const created = await createChangeSet()
    writeProject('src/blocked', 'not a directory\n')
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.Failed })
  })

  it('ignores a removal whose directory is already gone', async () => {
    await isolate()
    removeWorkspace('docs/guide.md')
    const created = await createChangeSet()
    fs.rmSync(path.join(project, 'docs'), { recursive: true, force: true })
    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.applied).toEqual(['docs/guide.md'])
  })

  it('accepts a removal when the main file is already gone', async () => {
    await isolate()
    removeWorkspace('docs/guide.md')
    const created = await createChangeSet()
    fs.rmSync(projectFile('docs/guide.md'))
    const result = await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    expect(result.applied).toEqual(['docs/guide.md'])
    expect(projectHas('docs/guide.md')).toBe(false)
  })

  it('propagates a non-not-found error while checking the main workspace', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    fs.rmSync(projectFile('src/a.ts'))
    fs.mkdirSync(projectFile('src/a.ts'))
    await expect(
      service.apply({ sessionId: 's1', changeSetId: created.changeSetId }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) })
  })

  it('refuses to resolve a conflict on a finished change set', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const created = await createChangeSet()
    await service.apply({ sessionId: 's1', changeSetId: created.changeSetId })
    await expect(
      service.resolveConflict({
        sessionId: 's1',
        changeSetId: created.changeSetId,
        path: 'src/a.ts',
        resolution: 'manual',
      }),
    ).rejects.toMatchObject({ code: ChangeSetErrorCode.NotPending })
  })

  it('uses the system clock and random ids when they are not injected', async () => {
    await isolate()
    writeWorkspace('src/a.ts', 'child\n')
    const { now: _now, createId: _createId, ...rest } = serviceOptions()
    const custom = createChangeSetService(rest)
    const created = await custom.create({ sessionId: 's1', runId: 'r1' })
    expect(created.changeSetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})
