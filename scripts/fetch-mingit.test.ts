import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundledGitLayout } from '../apps/desktop/src/main/services/git-locator'
import {
  MINGIT_SHA256,
  directoryUsage,
  downloadArchive,
  fetchMingit,
  isPrunedEntryAllowed,
  main,
  mingitEnv,
  mingitLayout,
  pruneArchive,
  sha256Hex,
  verifyArchive,
  verifyBundledGit,
  writeArchive,
} from './fetch-mingit.mjs'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-mingit-test-'))
  directories.push(directory)
  return directory
}

function layoutFiles(directory: string, prefix = 'ucrt64'): void {
  for (const relative of [
    `${prefix}/bin/git.exe`,
    `${prefix}/libexec/git-core/git-sh-setup`,
    `${prefix}/share/git-core/templates/description`,
  ]) {
    const file = path.join(directory, prefix, relative.replace(`${prefix}/`, ''))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'x')
  }
  writeFileSync(path.join(directory, 'LICENSE.txt'), 'GPLv2')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('checksums', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const hash = sha256Hex(bytes)

  it('accepts the expected digest and rejects anything else', () => {
    expect(verifyArchive(bytes, hash)).toBe(hash)
    expect(() => verifyArchive(bytes, 'deadbeef')).toThrow(
      `MinGit archive checksum mismatch: expected deadbeef, got ${hash}`,
    )
    expect(MINGIT_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('pruning', () => {
  it('keeps only the checkpoint allowlist and rejects unsafe paths', () => {
    for (const name of [
      'LICENSE.txt',
      'cmd/git.exe',
      'ucrt64/bin/git.exe',
      'ucrt64/bin/libpcre2-8-0.dll',
      'ucrt64/libexec/git-core/git-sh-setup',
      'ucrt64/share/git-core/templates/description',
      'mingw64/bin/git.exe',
    ]) {
      expect(isPrunedEntryAllowed(name), name).toBe(true)
    }
    for (const name of [
      'README.md',
      'usr/bin/bash.exe',
      'ucrt64/share/locale/de/LC_MESSAGES/git.mo',
      '../escape.txt',
      '/absolute.txt',
      'C:/windows/system32/git.exe',
      'ucrt64/bin/git-remote-https.exe',
      'ucrt64/bin/git-credential-manager.exe',
      'ucrt64/bin/Avalonia.Base.dll',
      'ucrt64/bin/libSkiaSharp.dll',
      'cmd/scalar.exe',
    ]) {
      expect(isPrunedEntryAllowed(name), name).toBe(false)
    }
  })

  it('drops directory entries and reports the kept size', () => {
    const result = pruneArchive({
      'ucrt64/': new Uint8Array(),
      'README.md': new Uint8Array(5),
      'LICENSE.txt': new Uint8Array(3),
      'ucrt64/bin/git.exe': new Uint8Array(7),
    })
    expect(Object.keys(result.files)).toEqual(['LICENSE.txt', 'ucrt64/bin/git.exe'])
    expect(result.bytes).toBe(10)
    expect(result.removed).toBe(2)
  })

  it('writes files and clears stale content', () => {
    const directory = temporaryDirectory()
    writeFileSync(path.join(directory, 'stale.txt'), 'old')
    writeArchive({ 'ucrt64/bin/git.exe': new Uint8Array([1]) }, directory)
    expect(readFileSync(path.join(directory, 'ucrt64/bin/git.exe'))).toEqual(Buffer.from([1]))
    expect(() => readFileSync(path.join(directory, 'stale.txt'))).toThrow()
    expect(directoryUsage(directory)).toEqual({ files: 1, bytes: 1 })
  })
})

describe('environment and layout', () => {
  it('matches the runtime locator layout', () => {
    const directory = temporaryDirectory()
    layoutFiles(directory)
    expect(mingitLayout(directory)).toEqual(bundledGitLayout(directory, () => true))

    const mingw = temporaryDirectory()
    layoutFiles(mingw, 'mingw64')
    expect(mingitLayout(mingw)).toEqual(bundledGitLayout(mingw, (file) => existsSync(file)))
  })

  it('builds the bundled environment', () => {
    const layout = mingitLayout(temporaryDirectory())
    expect(mingitEnv(layout, { PATH: 'C:/Windows' }, 'win32')['PATH']).toBe(
      `${layout.binDir};C:/Windows`,
    )
    expect(mingitEnv(layout, {}, 'win32')['PATH']).toBe(layout.binDir)
    expect(mingitEnv(layout, { PATH: '/bin' }, 'linux')['PATH']).toBe(`${layout.binDir}:/bin`)
  })
})

describe('verifyBundledGit', () => {
  function fixtureRun(version = 'git version 2.56.0.windows.4') {
    return (file: string, args: string[], options: { cwd: string }) => {
      void file
      if (args.includes('--version')) return version
      if (args.includes('rev-parse')) return 'a'.repeat(40)
      if (args.includes('cat-file')) return 'tree 123\n\nmessage'
      if (args.includes('diff')) return ' a.txt | 2 +-'
      if (args.includes('checkout')) {
        writeFileSync(path.join(options.cwd, 'a.txt'), 'one\n')
        return ''
      }
      if (args.includes('init')) {
        writeFileSync(path.join(options.cwd, 'a.txt'), 'one\n')
        return ''
      }
      return ''
    }
  }

  it('runs the real checkpoint command set', () => {
    const directory = temporaryDirectory()
    layoutFiles(directory)
    const run = vi.fn(fixtureRun())
    const result = verifyBundledGit(directory, { base: { PATH: 'C:/Windows', GIT_DIR: '/x' }, run })
    expect(result.version).toBe('git version 2.56.0.windows.4')
    expect(result.files).toBe(4)
    expect(run).toHaveBeenCalledWith(
      mingitLayout(directory).binary,
      ['--version'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_EXEC_PATH: mingitLayout(directory).execPath,
          GIT_TEMPLATE_DIR: mingitLayout(directory).templateDir,
        }),
      }),
    )
    expect(run.mock.calls.flatMap(([, args]) => args)).toEqual(
      expect.arrayContaining([
        'init',
        'add',
        'commit',
        'rev-parse',
        'cat-file',
        'diff',
        'checkout',
      ]),
    )
  })

  it('fails on a missing binary or unexpected version', () => {
    const directory = temporaryDirectory()
    expect(() => verifyBundledGit(directory)).toThrow('bundled git is missing')

    layoutFiles(directory)
    expect(() =>
      verifyBundledGit(directory, {
        run: () => 'git version 2.20.0',
      }),
    ).toThrow('unexpected bundled git version')
  })

  it('runs the default process runner when no runner is injected', () => {
    const directory = temporaryDirectory()
    layoutFiles(directory)
    // 用 Node 本体冒充 git.exe：默认 execFileSync 路径必须真的执行进程，输出不是 Git 版本即失败。
    cpSync(process.execPath, path.join(directory, 'ucrt64/bin/git.exe'))
    expect(() => verifyBundledGit(directory)).toThrow('unexpected bundled git version')
  })

  it('fails when rev-parse, cat-file, diff or checkout misbehave', () => {
    const directory = temporaryDirectory()
    layoutFiles(directory)
    const cases: ((file: string, args: string[]) => string)[] = [
      () => 'git version 2.56.0.windows.4',
      (file, args) => {
        if (args.includes('--version')) return 'git version 2.56.0.windows.4'
        if (args.includes('rev-parse')) return 'not-a-hash'
        return ''
      },
      (file, args) => {
        if (args.includes('--version')) return 'git version 2.56.0.windows.4'
        if (args.includes('rev-parse')) return 'a'.repeat(40)
        if (args.includes('cat-file')) return 'missing'
        return ''
      },
      (file, args) => {
        if (args.includes('--version')) return 'git version 2.56.0.windows.4'
        if (args.includes('rev-parse')) return 'a'.repeat(40)
        if (args.includes('cat-file')) return 'tree 1'
        if (args.includes('diff')) return ''
        return ''
      },
    ]
    expect(() => verifyBundledGit(directory, { run: cases[0]! })).toThrow('rev-parse failed')
    expect(() => verifyBundledGit(directory, { run: cases[1]! })).toThrow('rev-parse failed')
    expect(() => verifyBundledGit(directory, { run: cases[2]! })).toThrow('cat-file failed')
    expect(() => verifyBundledGit(directory, { run: cases[3]! })).toThrow('diff failed')
  })

  it('fails when checkout does not restore the modified file', () => {
    const directory = temporaryDirectory()
    layoutFiles(directory)
    const run = (_file: string, args: string[]) => {
      if (args.includes('--version')) return 'git version 2.56.0.windows.4'
      if (args.includes('rev-parse')) return 'a'.repeat(40)
      if (args.includes('cat-file')) return 'tree 1'
      if (args.includes('diff')) return 'a.txt | 2 +-'
      return ''
    }
    expect(() => verifyBundledGit(directory, { run })).toThrow('checkout failed')
  })

  const bundledDir = path.resolve(import.meta.dirname, '../apps/desktop/resources/git')
  it.skipIf(bundledGitLayout(bundledDir) === undefined)(
    'verifies the real downloaded MinGit artifact',
    () => {
      const result = verifyBundledGit(bundledDir)
      expect(result.version).toContain('git version 2.56')
      expect(result.files).toBeGreaterThan(0)
      expect(result.bytes).toBeGreaterThan(0)
    },
  )
})

describe('downloadArchive', () => {
  const zip = new Uint8Array([9, 9, 9])
  const expected = sha256Hex(zip)

  it('uses a valid cache and re-downloads an invalid one', async () => {
    const directory = temporaryDirectory()
    const cacheFile = path.join(directory, 'mingit.zip')
    writeFileSync(cacheFile, zip)
    const fetchImpl = vi.fn()
    expect(Array.from(await downloadArchive({ cacheFile, expected, fetchImpl }))).toEqual(
      Array.from(zip),
    )
    expect(fetchImpl).not.toHaveBeenCalled()

    writeFileSync(cacheFile, new Uint8Array([1]))
    const log = vi.fn()
    await expect(
      downloadArchive({
        cacheFile,
        expected,
        fetchImpl: async () => new Response(zip),
        log,
      }),
    ).resolves.toEqual(zip)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cached archive is invalid'))
    expect(readFileSync(cacheFile)).toEqual(Buffer.from(zip))
  })

  it('falls back to the next URL and reports every failure', async () => {
    const directory = temporaryDirectory()
    const cacheFile = path.join(directory, 'mingit.zip')
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(new Response(zip))
    await expect(
      downloadArchive({ cacheFile, expected, urls: ['https://a', 'https://b'], fetchImpl }),
    ).resolves.toEqual(zip)

    await expect(
      downloadArchive({
        cacheFile: path.join(directory, 'missing.zip'),
        expected,
        urls: ['https://a'],
        fetchImpl: async () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow('cannot download MinGit: offline')

    await expect(
      downloadArchive({
        cacheFile: path.join(directory, 'bad.zip'),
        expected,
        urls: ['https://a', 'https://b'],
        fetchImpl: async () => new Response('wrong'),
      }),
    ).rejects.toThrow('checksum mismatch')

    await expect(
      downloadArchive({
        cacheFile: path.join(directory, 'text-error.zip'),
        expected,
        urls: ['https://a'],
        fetchImpl: async () => {
          throw 'offline as text'
        },
      }),
    ).rejects.toThrow('cannot download MinGit: offline as text')
  })
})

describe('fetchMingit', () => {
  function archiveWithLayout(): Uint8Array {
    return zipSync({
      'LICENSE.txt': new TextEncoder().encode('GPLv2'),
      'cmd/git.exe': new Uint8Array([1]),
      'ucrt64/bin/git.exe': new TextEncoder().encode('git'),
      'ucrt64/libexec/git-core/git-sh-setup': new Uint8Array([1]),
      'ucrt64/share/git-core/templates/description': new Uint8Array([1]),
      'doc/README.md': new Uint8Array([1]),
    })
  }

  it('prunes, verifies and installs the archive', async () => {
    const target = path.join(temporaryDirectory(), 'git')
    const log = vi.fn()
    const verify = vi.fn(() => ({ version: 'git version 2.56.0', files: 4, bytes: 10 }))
    const archive = archiveWithLayout()
    const result = await fetchMingit({
      target,
      archive,
      expected: sha256Hex(archive),
      verify,
      log,
    })
    expect(result).toEqual({
      target,
      files: 4,
      bytes: 10,
      version: 'git version 2.56.0',
    })
    expect(mingitLayout(target).binary).toBe(path.join(target, 'ucrt64/bin/git.exe'))
    expect(() => readFileSync(path.join(target, 'doc/README.md'))).toThrow()
    expect(verify).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('5 files'))
  })

  it('keeps an already installed copy without downloading', async () => {
    const target = path.join(temporaryDirectory(), 'git')
    layoutFiles(target)
    const download = vi.fn()
    const verify = vi.fn(() => ({ version: 'git version 2.56.0', files: 4, bytes: 10 }))
    await expect(fetchMingit({ target, download, verify })).resolves.toMatchObject({ target })
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads and verifies when no archive is injected', async () => {
    const target = path.join(temporaryDirectory(), 'git')
    const archive = archiveWithLayout()
    const download = vi.fn(async () => archive)
    const verify = vi.fn(() => ({ version: 'git version 2.56.0', files: 4, bytes: 10 }))
    await expect(
      fetchMingit({ target, download, verify, expected: sha256Hex(archive) }),
    ).resolves.toMatchObject({
      target,
      version: 'git version 2.56.0',
    })
    expect(download).toHaveBeenCalledTimes(1)
    expect(existsSync(path.join(target, 'ucrt64/bin/git.exe'))).toBe(true)
  })
})

describe('main', () => {
  it('verifies, installs and reports failures with the expected exit codes', async () => {
    const log = vi.fn()
    const error = vi.fn()
    const verify = vi.fn(() => ({ version: 'git version 2.56.0', files: 1, bytes: 1 }))

    await expect(main({ argv: ['--check'], log, error, verify, target: 'C:/git' })).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith('mingit: git version 2.56.0 verified at C:/git')

    const fetch = vi.fn(async () => ({
      target: 'C:/git',
      files: 1,
      bytes: 1,
      version: 'git version 2.56.0',
    }))
    await expect(main({ argv: ['--force'], log, error, fetch })).resolves.toBe(0)
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ force: true }))

    await expect(
      main({
        argv: [],
        log,
        error,
        fetch: async () => {
          throw new Error('offline')
        },
      }),
    ).resolves.toBe(1)
    expect(error).toHaveBeenCalledWith('offline')

    await expect(
      main({
        argv: [],
        log,
        error,
        fetch: async () => {
          throw 'text failure'
        },
      }),
    ).resolves.toBe(1)
    expect(error).toHaveBeenCalledWith('text failure')
  })
})
