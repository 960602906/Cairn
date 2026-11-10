import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRunner } from '@cairn/checkpoint'
import {
  ProjectCloneErrorCode,
  cloneGitRepository,
  workspaceNameFromRemoteUrl,
} from './git-clone.js'

const roots: string[] = []

async function parent() {
  const root = await mkdtemp(path.join(tmpdir(), 'cairn-clone-test-'))
  roots.push(root)
  return root
}

function runner(run: GitRunner['run']): GitRunner {
  return { binary: 'git', run: vi.fn(run) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('cloneGitRepository', () => {
  it('clones into a new folder and forwards the branch', async () => {
    const root = await parent()
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))

    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
        branch: 'main',
      }),
    ).resolves.toBe(path.join(root, 'repo'))
    await expect(stat(path.join(root, 'repo'))).resolves.toMatchObject({})
    expect(git.run).toHaveBeenCalledWith(
      ['clone', '--branch', 'main', '--', 'https://example.com/team/repo.git', '.'],
      expect.objectContaining({ cwd: path.join(root, 'repo'), allowFail: true }),
    )
  })

  it('rejects an existing target, invalid names and relative parents', async () => {
    const root = await parent()
    await mkdir(path.join(root, 'repo'))
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))

    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.TargetExists })
    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: '../escape',
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidName })
    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: 'relative',
        name: 'repo',
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidPath })
  })

  it('rejects remote helper URLs before starting Git', async () => {
    const root = await parent()
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))

    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'ext::sh -c whoami',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidRemote })
    expect(git.run).not.toHaveBeenCalled()
  })

  it('removes the target and reports the last Git error line', async () => {
    const root = await parent()
    const git = runner(async () => ({
      code: 128,
      stdout: Buffer.alloc(0),
      stderr: 'Cloning into...\nfatal: repository not found',
    }))

    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/missing.git',
        parentPath: root,
        name: 'missing',
      }),
    ).rejects.toMatchObject({
      code: ProjectCloneErrorCode.Failed,
      params: { reason: 'fatal: repository not found' },
    })
    await expect(stat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid names, branches and parent directories', async () => {
    const root = await parent()
    const file = path.join(root, 'not-a-directory')
    await writeFile(file, 'x')
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))
    const base = {
      remoteUrl: 'https://example.com/team/repo.git',
      parentPath: root,
      name: 'repo',
    }

    for (const name of [
      '',
      '   ',
      'a'.repeat(201),
      '.',
      '..',
      'a/b',
      `bad${String.fromCharCode(1)}name`,
      'name.',
      'con',
    ]) {
      await expect(cloneGitRepository(git, { ...base, name })).rejects.toMatchObject({
        code: ProjectCloneErrorCode.InvalidName,
      })
    }
    await expect(
      cloneGitRepository(git, { ...base, branch: 'a'.repeat(256) }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidName })
    await expect(
      cloneGitRepository(git, {
        ...base,
        branch: `bad${String.fromCharCode(1)}branch`,
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidName })
    await expect(
      cloneGitRepository(git, { ...base, parentPath: path.join(root, 'missing') }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidPath })
    await expect(cloneGitRepository(git, { ...base, parentPath: file })).rejects.toMatchObject({
      code: ProjectCloneErrorCode.InvalidPath,
    })
  })

  it('rejects empty and overlong remote URLs', async () => {
    const root = await parent()
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))
    for (const remoteUrl of ['', 'a'.repeat(4097), 'https://example.com/\u0001', '::cmd']) {
      await expect(
        cloneGitRepository(git, { remoteUrl, parentPath: root, name: 'repo' }),
      ).rejects.toMatchObject({ code: ProjectCloneErrorCode.InvalidRemote })
    }
  })

  it('reports a non-EEXIST mkdir failure with the underlying reason', async () => {
    const root = await parent()
    const git = runner(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const mkdirSpy = vi.spyOn(fsp, 'mkdir').mockRejectedValueOnce(denied)
    try {
      await expect(
        cloneGitRepository(git, {
          remoteUrl: 'https://example.com/team/repo.git',
          parentPath: root,
          name: 'repo',
        }),
      ).rejects.toMatchObject({
        code: ProjectCloneErrorCode.Failed,
        params: { reason: 'permission denied' },
      })
    } finally {
      mkdirSpy.mockRestore()
    }

    const stringFailure = vi.spyOn(fsp, 'mkdir').mockRejectedValueOnce('denied')
    try {
      await expect(
        cloneGitRepository(git, {
          remoteUrl: 'https://example.com/team/repo.git',
          parentPath: root,
          name: 'repo',
        }),
      ).rejects.toMatchObject({
        code: ProjectCloneErrorCode.Failed,
        params: { reason: 'denied' },
      })
    } finally {
      stringFailure.mockRestore()
    }
  })

  it('maps Git startup failures and generic errors', async () => {
    const root = await parent()
    const unavailable = runner(async () => {
      throw Object.assign(new Error('git missing'), { code: 'checkpoint.git_unavailable' })
    })
    await expect(
      cloneGitRepository(unavailable, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({ code: ProjectCloneErrorCode.GitUnavailable })

    const failed = runner(async () => {
      throw new Error('spawn failed')
    })
    await expect(
      cloneGitRepository(failed, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({
      code: ProjectCloneErrorCode.Failed,
      params: { reason: 'spawn failed' },
    })

    const thrownString = runner(async () => {
      throw 'spawn failed'
    })
    await expect(
      cloneGitRepository(thrownString, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({
      code: ProjectCloneErrorCode.Failed,
      params: { reason: 'spawn failed' },
    })
  })

  it('falls back to the exit code when Git writes no error', async () => {
    const root = await parent()
    const git = runner(async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: '' }))
    await expect(
      cloneGitRepository(git, {
        remoteUrl: 'https://example.com/team/repo.git',
        parentPath: root,
        name: 'repo',
      }),
    ).rejects.toMatchObject({
      code: ProjectCloneErrorCode.Failed,
      params: { reason: 'git exited with 128' },
    })
  })
})

describe('workspaceNameFromRemoteUrl', () => {
  it('derives one path segment for HTTPS and SSH URLs', () => {
    expect(workspaceNameFromRemoteUrl('https://github.com/owner/repo.git')).toBe('repo')
    expect(workspaceNameFromRemoteUrl('git@github.com:owner/repo.git/')).toBe('repo')
    expect(workspaceNameFromRemoteUrl('')).toBe('')
    expect(workspaceNameFromRemoteUrl(`https://github.com/${'a'.repeat(300)}`)).toHaveLength(200)
  })
})
