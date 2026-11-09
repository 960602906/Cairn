import type { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findUnpackedApp,
  errorMessage,
  main,
  unpackedDirectoryName,
  verifyFuses,
  verifyPackage,
} from './verify-package.mjs'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-verify-package-test-'))
  directories.push(directory)
  return directory
}

function write(file: string, content = ''): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

interface FixtureOptions {
  readonly asarFiles?: Readonly<Record<string, string>>
  readonly removeAsarFiles?: readonly string[]
  readonly omitNative?: boolean
  readonly manifestVersion?: string
  readonly desktopVersion?: string
  readonly omitAsar?: boolean
  readonly extraUnpacked?: Readonly<Record<string, string>>
}

interface Fixture {
  readonly root: string
  readonly desktopRoot: string
  readonly outputDir: string
  readonly directory: string
  readonly executable: string
  readonly resources: string
  readonly appAsar: string
  readonly unpacked: string
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = temporaryDirectory()
  const desktopRoot = path.join(root, 'desktop')
  const outputDir = path.join(root, 'dist')
  const directory = path.join(outputDir, 'win-unpacked')
  const resources = path.join(directory, 'resources')
  const appAsar = path.join(resources, 'app.asar')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  const executable = path.join(directory, 'Cairn.exe')
  const version = options.manifestVersion ?? '0.1.0'
  write(
    path.join(desktopRoot, 'package.json'),
    JSON.stringify({ name: '@cairn/desktop', version: options.desktopVersion ?? '0.1.0' }),
  )
  write(executable, 'exe')
  write(path.join(resources, 'skills/example/SKILL.md'), '# Example\n')

  const asarFiles: Record<string, string> = {
    'out/main/index.js': '',
    'out/main/startup.js': '',
    'out/main/agent-host.js': '',
    'out/preload/index.cjs': '',
    'out/renderer/index.html': '<html></html>',
    'out/bin/rg.exe': '',
    'out/build-info.json': JSON.stringify({ version }),
    'out/THIRD_PARTY_NOTICES.txt': 'notices',
    'package.json': JSON.stringify({
      name: '@cairn/desktop',
      version,
      devDependencies: { electron: '45.2.1' },
    }),
    ...options.asarFiles,
  }
  for (const removed of options.removeAsarFiles ?? []) delete asarFiles[removed]
  const asarSource = path.join(root, 'asar-source')
  for (const [relative, content] of Object.entries(asarFiles)) {
    write(path.join(asarSource, relative), content)
  }
  if (options.omitAsar !== true) await createPackage(asarSource, appAsar)

  write(path.join(unpacked, 'out/bin/rg.exe'), '')
  write(path.join(unpacked, 'node_modules/better-sqlite3/prebuilds/win32-x64.node'), 'sqlite')
  write(path.join(unpacked, 'node_modules/koffi/index.js'), '')
  write(path.join(unpacked, 'node_modules/koffi/src/koffi/index.js'), '')
  write(path.join(unpacked, 'node_modules/koffi/index.cjs'), '')
  write(path.join(unpacked, 'node_modules/koffi/src/koffi/index.cjs'), '')
  if (options.omitNative !== true) {
    write(
      path.join(unpacked, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'),
      'koffi',
    )
  }
  for (const [relative, content] of Object.entries(options.extraUnpacked ?? {})) {
    write(path.join(unpacked, relative), content)
  }
  return {
    root,
    desktopRoot,
    outputDir,
    directory,
    executable,
    resources,
    appAsar,
    unpacked,
  }
}

function successfulRunner(): typeof spawnSync {
  return vi.fn((command: string) => {
    if (/rg\.exe$/i.test(command)) {
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 1,
        stdout: 'ripgrep 15.0.0 (rev 3a612f88b8)\n',
        stderr: '',
      }
    }
    return { status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
  }) as unknown as typeof spawnSync
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('unpacked directory lookup', () => {
  it('uses electron-builder output names per platform', () => {
    expect(unpackedDirectoryName('win32')).toBe('win-unpacked')
    expect(unpackedDirectoryName('darwin')).toBe('mac')
    expect(unpackedDirectoryName('linux')).toBe('linux-unpacked')
  })

  it('finds Windows, macOS and Linux executables', () => {
    const output = temporaryDirectory()
    write(path.join(output, 'win-unpacked/Cairn.exe'))
    expect(findUnpackedApp({ outputDir: output, platform: 'win32' })).toEqual({
      directory: path.join(output, 'win-unpacked'),
      executable: path.join(output, 'win-unpacked/Cairn.exe'),
    })

    write(path.join(output, 'mac/Cairn.app/Contents/MacOS/Cairn'))
    expect(findUnpackedApp({ outputDir: output, platform: 'darwin' }).executable).toBe(
      path.join(output, 'mac/Cairn.app/Contents/MacOS/Cairn'),
    )

    write(path.join(output, 'linux-unpacked/cairn'))
    expect(findUnpackedApp({ outputDir: output, platform: 'linux' }).executable).toBe(
      path.join(output, 'linux-unpacked/cairn'),
    )
  })

  it('reports a missing packaged application', () => {
    const output = temporaryDirectory()
    expect(() => findUnpackedApp({ outputDir: output, platform: 'win32' })).toThrow(
      `packaged application was not found in ${path.join(output, 'win-unpacked')}`,
    )
  })
})

describe('verifyFuses', () => {
  const expectedWire = {
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE,
  }

  it('accepts the expected fuse states', async () => {
    await expect(verifyFuses('Cairn.exe', async () => expectedWire)).resolves.toEqual([])
  })

  it('reports mismatched and unreadable fuse wires', async () => {
    await expect(
      verifyFuses('Cairn.exe', async () => ({
        ...expectedWire,
        [FuseV1Options.RunAsNode]: FuseState.ENABLE,
      })),
    ).resolves.toEqual(['fuse is not runAsNode disabled: 49'])
    await expect(
      verifyFuses('Cairn.exe', async () => {
        throw new Error('not an Electron executable')
      }),
    ).resolves.toEqual(['cannot read Electron fuses: not an Electron executable'])
    await expect(
      verifyFuses('Cairn.exe', async () => {
        throw 'bad wire'
      }),
    ).resolves.toEqual(['cannot read Electron fuses: bad wire'])
  })
})

describe('errorMessage', () => {
  it('handles both Error and non-Error values', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed')
    expect(errorMessage('failed as text')).toBe('failed as text')
  })
})

describe('verifyPackage', () => {
  it('accepts a complete unpacked application', async () => {
    const app = await fixture()
    await expect(
      verifyPackage({
        desktopRoot: app.desktopRoot,
        outputDir: app.outputDir,
        platform: 'win32',
        runner: successfulRunner(),
        readFuses: async () => [],
        minimumInstallerBytes: 0,
      }),
    ).resolves.toEqual([])
  })

  it('returns the lookup error when no packaged application exists', async () => {
    const app = await fixture()
    rmSync(app.executable)
    await expect(
      verifyPackage({ desktopRoot: app.desktopRoot, outputDir: app.outputDir, platform: 'win32' }),
    ).resolves.toEqual([
      `packaged application was not found in ${path.join(app.outputDir, 'win-unpacked')}; run \`pnpm package:dir\` first`,
    ])
  })

  it('reports missing asar, skills and required asar entries', async () => {
    const missingAsar = await fixture({ omitAsar: true })
    rmSync(path.join(missingAsar.resources, 'skills'), { recursive: true, force: true })
    const problems = await verifyPackage({
      desktopRoot: missingAsar.desktopRoot,
      outputDir: missingAsar.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        `missing app.asar: ${missingAsar.appAsar}`,
        `missing resources/skills: ${path.join(missingAsar.resources, 'skills/example/SKILL.md')}`,
      ]),
    )

    const incomplete = await fixture({ removeAsarFiles: ['out/build-info.json'] })
    const incompleteProblems = await verifyPackage({
      desktopRoot: incomplete.desktopRoot,
      outputDir: incomplete.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(incompleteProblems).toEqual(
      expect.arrayContaining([
        'app.asar is missing out/build-info.json',
        expect.stringContaining('cannot read out/build-info.json:'),
      ]),
    )
  })

  it('rejects source maps, tests and development content in asar', async () => {
    const app = await fixture({
      asarFiles: {
        'out/main/index.js.map': '{}',
        'out/main/index.test.js': '',
        'src/main/secret.ts': '',
        'e2e/secret.ts': '',
        'spikes/secret.ts': '',
        'node_modules/react/index.js': '',
      },
    })
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'app.asar contains a source map: out/main/index.js.map',
        'app.asar contains a test file: out/main/index.test.js',
        'app.asar contains development content: src/main/secret.ts',
        'app.asar contains development content: e2e/secret.ts',
        'app.asar contains development content: spikes/secret.ts',
        'app.asar contains development content: node_modules/react/index.js',
      ]),
    )
  })

  it('checks manifest version, scripts and development dependencies', async () => {
    const app = await fixture({
      manifestVersion: '9.9.9',
      asarFiles: {
        'package.json': JSON.stringify({
          name: '@cairn/desktop',
          version: '9.9.9',
          scripts: { postinstall: 'echo bad' },
          devDependencies: { electron: '45.2.1', vite: '8.0.0' },
        }),
      },
    })
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'app.asar version 9.9.9 does not match 0.1.0',
        'app.asar package.json contains scripts',
        'app.asar contains development dependencies: electron, vite',
      ]),
    )
  })

  it('reports invalid manifests and build information', async () => {
    const app = await fixture({
      asarFiles: {
        'package.json': '{',
        'out/build-info.json': '{',
      },
    })
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(
      problems.some((problem) => problem.startsWith('cannot read app.asar/package.json:')),
    ).toBe(true)
    expect(problems.some((problem) => problem.startsWith('cannot read out/build-info.json:'))).toBe(
      true,
    )

    const mismatch = await fixture({
      asarFiles: { 'out/build-info.json': JSON.stringify({ version: '0.0.0' }) },
    })
    await expect(
      verifyPackage({
        desktopRoot: mismatch.desktopRoot,
        outputDir: mismatch.outputDir,
        platform: 'win32',
        runner: successfulRunner(),
        readFuses: async () => [],
      }),
    ).resolves.toContain('out/build-info.json version does not match app.asar/package.json')
  })

  it('reports missing and unloadable native files', async () => {
    const app = await fixture({ omitNative: true })
    rmSync(path.join(app.unpacked, 'out/bin/rg.exe'))
    rmSync(path.join(app.unpacked, 'node_modules/better-sqlite3/prebuilds/win32-x64.node'))
    for (const file of [
      'node_modules/koffi/index.js',
      'node_modules/koffi/src/koffi/index.js',
      'node_modules/koffi/index.cjs',
      'node_modules/koffi/src/koffi/index.cjs',
    ]) {
      rmSync(path.join(app.unpacked, file))
    }
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'asarUnpack is missing ripgrep',
        'asarUnpack is missing better-sqlite3 native module',
        'asarUnpack is missing koffi native module',
        'asarUnpack is missing node_modules/koffi/src/koffi/index.js',
      ]),
    )
  })

  it('reports ripgrep and native module execution failures', async () => {
    const app = await fixture()
    const runner = vi.fn((command: string) => {
      if (/rg\.exe$/i.test(command)) {
        return {
          status: 1,
          signal: null,
          output: [],
          pid: 1,
          stdout: '',
          stderr: 'rg failed',
        }
      }
      return {
        status: 1,
        signal: null,
        output: [],
        pid: 1,
        stdout: 'native stdout',
        stderr: 'native stderr',
      }
    }) as unknown as typeof spawnSync
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner,
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'bundled ripgrep cannot run: rg failed',
        expect.stringContaining('better-sqlite3 native module cannot load:'),
        expect.stringContaining('koffi native module cannot load:'),
      ]),
    )

    const silentRunner = vi.fn((command: string) =>
      /rg\.exe$/i.test(command) ? { status: 0, stdout: 'ripgrep 15.0.0\n' } : { status: 1 },
    ) as unknown as typeof spawnSync
    const silent = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: silentRunner,
      readFuses: async () => [],
    })
    expect(silent.some((problem) => problem.endsWith('failed to load'))).toBe(true)
  })

  it('merges fuse problems with the other findings', async () => {
    const app = await fixture()
    await expect(
      verifyPackage({
        desktopRoot: app.desktopRoot,
        outputDir: app.outputDir,
        platform: 'win32',
        runner: successfulRunner(),
        readFuses: async () => ['runAsNode enabled'],
      }),
    ).resolves.toContain('runAsNode enabled')
  })

  it('validates NSIS artifacts and their checksum', async () => {
    const app = await fixture()
    const installer = path.join(app.outputDir, 'Cairn-0.1.0-x64-setup.exe')
    write(installer, 'installer')
    write(`${installer}.blockmap`, 'blockmap')
    write(`${installer}.sha256`, 'bad  installer\n')
    const invalid = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
      target: 'nsis',
      minimumInstallerBytes: 0,
    })
    expect(invalid).toContain('NSIS checksum does not match the installer')

    const hash = createHash('sha256').update('installer').digest('hex')
    write(`${installer}.sha256`, `${hash}  Cairn-0.1.0-x64-setup.exe\n`)
    const tooSmall = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
      target: 'nsis',
      minimumInstallerBytes: 50 * 1024 * 1024,
    })
    expect(tooSmall).toContain('NSIS installer is unexpectedly small: 9')

    await expect(
      verifyPackage({
        desktopRoot: app.desktopRoot,
        outputDir: app.outputDir,
        platform: 'win32',
        runner: successfulRunner(),
        readFuses: async () => [],
        target: 'nsis',
        minimumInstallerBytes: 0,
      }),
    ).resolves.toEqual([])

    rmSync(installer)
    rmSync(`${installer}.blockmap`)
    rmSync(`${installer}.sha256`)
    const missing = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
      target: 'nsis',
    })
    expect(missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing NSIS installer:'),
        expect.stringContaining('missing NSIS blockmap:'),
        expect.stringContaining('missing NSIS checksum:'),
      ]),
    )
  })

  it('detects possible publishing credential leaks', async () => {
    const app = await fixture()
    write(path.join(app.outputDir, 'builder-effective-config.yaml'), 'token: ghp_secret\n')
    write(path.join(app.resources, 'app-update.yml'), 'password: hunter2\n')
    const problems = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'publishing credentials may have leaked into builder-effective-config.yaml',
        'publishing credentials may have leaked into app-update.yml',
      ]),
    )

    write(path.join(app.outputDir, 'builder-effective-config.yaml'), 'publish: never\n')
    write(path.join(app.resources, 'app-update.yml'), 'provider: generic\n')
    const clean = await verifyPackage({
      desktopRoot: app.desktopRoot,
      outputDir: app.outputDir,
      platform: 'win32',
      runner: successfulRunner(),
      readFuses: async () => [],
    })
    expect(clean.some((problem) => problem.includes('credentials may have leaked'))).toBe(false)
  })

  it('supports non-Windows prebuild names', async () => {
    const app = await fixture()
    const linuxDirectory = path.join(app.outputDir, 'linux-unpacked')
    renameSync(app.directory, linuxDirectory)
    write(path.join(linuxDirectory, 'cairn'), '')
    const prebuilds = path.join(
      linuxDirectory,
      'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds',
    )
    renameSync(path.join(prebuilds, 'win32-x64.node'), path.join(prebuilds, 'linux-x64.node'))
    await expect(
      verifyPackage({
        desktopRoot: app.desktopRoot,
        outputDir: app.outputDir,
        platform: 'linux',
        runner: successfulRunner(),
        readFuses: async () => [],
      }),
    ).resolves.toEqual([])
  })

  it('accepts a staged manifest without devDependencies', async () => {
    const app = await fixture({
      asarFiles: {
        'package.json': JSON.stringify({ name: '@cairn/desktop', version: '0.1.0' }),
      },
    })
    await expect(
      verifyPackage({
        desktopRoot: app.desktopRoot,
        outputDir: app.outputDir,
        platform: 'win32',
        runner: successfulRunner(),
        readFuses: async () => [],
      }),
    ).resolves.toEqual([])
  })
})

describe('main', () => {
  it('prints success and failure results', async () => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(main({ verify: async () => [] })).resolves.toBe(0)
      expect(print).toHaveBeenCalledWith('verify: unpacked application passed')
      await expect(main({ verify: async () => ['bad'], target: 'nsis' })).resolves.toBe(1)
      expect(error).toHaveBeenCalledWith('verify: bad')

      const previous = process.argv
      process.argv = ['node', 'verify-package.mjs', '--nsis']
      try {
        await expect(main({ verify: async () => [] })).resolves.toBe(0)
      } finally {
        process.argv = previous
      }
      expect(print).toHaveBeenCalledWith('verify: installer passed')
    } finally {
      print.mockRestore()
      error.mockRestore()
    }
  })
})
