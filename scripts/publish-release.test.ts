import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubDownloadBase,
  githubReleaseCommands,
  listFiles,
  main,
  publishRelease,
  rcloneCommand,
  verifyPublishedArtifacts,
} from './publish-release.mjs'

const dirs: string[] = []

function releaseDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-publish-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'Cairn-0.1.1-x64-setup.exe'), 'installer')
  writeFileSync(path.join(dir, 'beta.yml'), 'metadata')
  writeFileSync(path.join(dir, 'release-notes.md'), '# notes')
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeFetch(bytes: string, status = 200) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(bytes),
  })) as unknown as typeof fetch
}

describe('upload commands', () => {
  it('builds an anonymous GitHub download base', () => {
    expect(
      githubDownloadBase({
        serverUrl: 'https://github.com/',
        repo: 'owner/repo',
        tag: 'v0.1.1 beta',
      }),
    ).toBe('https://github.com/owner/repo/releases/download/v0.1.1%20beta/')
  })

  it('creates and uploads a GitHub release', () => {
    const directory = releaseDirectory()
    const stable = githubReleaseCommands({
      tag: 'v0.1.1',
      directory,
      notesFile: path.join(directory, 'release-notes.md'),
      channel: 'stable',
      repo: 'owner/repo',
    })
    expect(stable[0]).toEqual([
      'release',
      'create',
      'v0.1.1',
      '--repo',
      'owner/repo',
      '--title',
      'Cairn 0.1.1',
      '--notes-file',
      path.join(directory, 'release-notes.md'),
    ])
    expect(stable[1]).toEqual([
      'release',
      'upload',
      'v0.1.1',
      ...listFiles(directory),
      '--repo',
      'owner/repo',
      '--clobber',
    ])

    const beta = githubReleaseCommands({
      tag: 'v0.1.2-beta.1',
      directory,
      notesFile: path.join(directory, 'release-notes.md'),
      channel: 'beta',
      repo: 'owner/repo',
    })
    expect(beta[0]).toContain('--prerelease')
    expect(rcloneCommand({ directory, remote: 'r2:cairn/beta' })).toEqual([
      'copy',
      directory,
      'r2:cairn/beta',
      '--checksum',
    ])
  })

  it('rejects an unreadable release directory', () => {
    expect(() => listFiles(path.join(tmpdir(), 'cairn-missing-release'))).toThrow(
      /cannot read release directory/,
    )
  })
})

describe('public verification', () => {
  it('accepts byte-identical downloads', async () => {
    const directory = releaseDirectory()
    const problems = await verifyPublishedArtifacts({
      baseUrl: 'https://updates.example/beta/',
      directory,
      fetchImpl: fakeFetch('installer'),
      attempts: 1,
    })
    // The fake returns the same bytes for every file, so the metadata file cannot match.
    expect(problems).toEqual([
      expect.stringContaining('beta.yml downloaded from'),
      expect.stringContaining('release-notes.md downloaded from'),
    ])
  })

  it('reports hash mismatches, HTTP errors and network failures', async () => {
    const directory = releaseDirectory()
    const mismatch = await verifyPublishedArtifacts({
      baseUrl: 'https://updates.example/',
      directory,
      files: [path.join(directory, 'beta.yml')],
      fetchImpl: fakeFetch('other'),
      attempts: 1,
    })
    expect(mismatch).toEqual([expect.stringContaining('does not match its SHA-256')])

    const notFound = await verifyPublishedArtifacts({
      baseUrl: 'https://updates.example/',
      directory,
      files: [path.join(directory, 'beta.yml')],
      fetchImpl: fakeFetch('', 404),
      attempts: 1,
    })
    expect(notFound).toEqual([expect.stringContaining('HTTP 404')])

    const network = await verifyPublishedArtifacts({
      baseUrl: 'https://updates.example/',
      directory,
      files: [path.join(directory, 'beta.yml')],
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      attempts: 1,
    })
    expect(network).toEqual([expect.stringContaining('offline')])
  })
})

describe('publishing', () => {
  it('rejects invalid input before running a command', async () => {
    const error = vi.fn()
    const base = {
      tag: 'v0.1.1',
      directory: releaseDirectory(),
      notesFile: path.join(releaseDirectory(), 'release-notes.md'),
      channel: 'beta' as const,
      repo: 'owner/repo',
      verifyBaseUrl: 'https://updates.example/',
      error,
    }
    expect(await publishRelease({ ...base, method: 's3' as never })).toBe(1)
    expect(await publishRelease({ ...base, method: 'github', directory: '/missing' })).toBe(1)
    expect(await publishRelease({ ...base, method: 'github', notesFile: '/missing-notes' })).toBe(1)
    expect(error).toHaveBeenCalledTimes(3)
  })

  it('creates a release and verifies public downloads', async () => {
    const directory = releaseDirectory()
    const commands: string[][] = []
    const runner = ((_command: string, args: string[]) => {
      commands.push(args)
      return { status: 0 }
    }) as never
    const verify = vi.fn(async () => [])
    expect(
      await publishRelease({
        method: 'github',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'stable',
        repo: 'owner/repo',
        verifyBaseUrl: 'https://updates.example/',
        runner,
        verify,
      }),
    ).toBe(0)
    expect(commands.map((args) => args[0])).toEqual(['release', 'release'])
    expect(verify).toHaveBeenCalledWith({
      baseUrl: 'https://updates.example/',
      directory,
    })
  })

  it('updates notes when the release already exists', async () => {
    const directory = releaseDirectory()
    const commands: string[][] = []
    let calls = 0
    const runner = ((_command: string, args: string[]) => {
      commands.push(args)
      calls += 1
      return { status: calls === 1 ? 1 : 0 }
    }) as never
    expect(
      await publishRelease({
        method: 'github',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'stable',
        repo: 'owner/repo',
        verifyBaseUrl: 'https://updates.example/',
        runner,
        verify: async () => [],
      }),
    ).toBe(0)
    expect(commands[1]?.slice(0, 3)).toEqual(['release', 'edit', 'v0.1.1'])
  })

  it('fails when upload or verification fails', async () => {
    const directory = releaseDirectory()
    const error = vi.fn()
    expect(
      await publishRelease({
        method: 'github',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'stable',
        repo: 'owner/repo',
        verifyBaseUrl: 'https://updates.example/',
        runner: (() => ({ status: 1 })) as never,
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed with 1'))

    expect(
      await publishRelease({
        method: 'github',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'stable',
        repo: 'owner/repo',
        verifyBaseUrl: 'https://updates.example/',
        runner: (() => ({ status: 0 })) as never,
        verify: async () => ['hash mismatch'],
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith('publish: hash mismatch')
  })

  it('requires a remote for rclone and uploads successfully', async () => {
    const directory = releaseDirectory()
    const error = vi.fn()
    expect(
      await publishRelease({
        method: 'rclone',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'beta',
        repo: 'owner/repo',
        verifyBaseUrl: 'https://updates.example/',
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('CAIRN_UPLOAD_REMOTE'))

    const commands: string[][] = []
    expect(
      await publishRelease({
        method: 'rclone',
        tag: 'v0.1.1',
        directory,
        notesFile: path.join(directory, 'release-notes.md'),
        channel: 'beta',
        repo: 'owner/repo',
        remote: 'r2:bucket',
        verifyBaseUrl: 'https://updates.example/',
        runner: ((_command: string, args: string[]) => {
          commands.push(args)
          return { status: 0 }
        }) as never,
        verify: async () => [],
      }),
    ).toBe(0)
    expect(commands[0]).toEqual(['copy', directory, 'r2:bucket', '--checksum'])
  })
})

describe('CLI', () => {
  it('supports dry runs and rejects incomplete publishing input', async () => {
    const error = vi.fn()
    const log = vi.fn()
    expect(await main({ argv: [], error })).toBe(1)
    expect(await main({ argv: ['--tag', 'v0.1.1', '--dir', '/missing'], error })).toBe(1)

    const directory = releaseDirectory()
    expect(
      await main({
        argv: ['--tag', 'v0.1.1', '--dir', directory, '--dry-run'],
        log,
      }),
    ).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dry run'))

    expect(
      await main({
        argv: ['--tag', 'v0.1.1', '--dir', directory, '--channel', 'nightly'],
        error,
      }),
    ).toBe(1)
    expect(
      await main({
        argv: ['--tag', 'v0.1.1', '--dir', directory, '--method', 'rclone'],
        env: {},
        error,
      }),
    ).toBe(1)
  })

  it('publishes to GitHub with a derived verification URL', async () => {
    const directory = releaseDirectory()
    const verified: string[] = []
    expect(
      await main({
        argv: ['--tag', 'v0.1.1', '--dir', directory],
        env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.com' },
        runner: (() => ({ status: 0 })) as never,
        verify: async ({ baseUrl }: { baseUrl: string }) => {
          verified.push(baseUrl)
          return []
        },
      }),
    ).toBe(0)
    expect(verified).toEqual(['https://github.com/owner/repo/releases/download/v0.1.1/'])
  })

  it('prints errors to the console when no logger is injected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        await main({ argv: ['--method', 'rclone', '--tag', 'v0.1.1', '--dir', '/missing'] }),
      ).toBe(1)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
