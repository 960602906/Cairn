import type { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AFTER_PACK_HOOK,
  createStagedManifest,
  electronBuilderCli,
  extractModuleSpecifiers,
  installProductionDependencies,
  main,
  packageNameOf,
  pruneStagedDependencies,
  readJsonFile,
  resolveRuntimeDependencies,
  runElectronBuilder,
  stageApplication,
  writeChecksum,
} from './packaging.mjs'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-packaging-test-'))
  directories.push(directory)
  return directory
}

function write(file: string, content = ''): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function desktopFixture(): string {
  const root = temporaryDirectory()
  for (const file of [
    'out/main/index.js',
    'out/main/startup.js',
    'out/main/agent-host.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/bin/rg.exe',
    'out/build-info.json',
    'out/THIRD_PARTY_NOTICES.txt',
  ]) {
    write(path.join(root, file))
  }
  write(path.join(root, 'out/main/index.js'), "import { z } from 'zod'\n")
  write(path.join(root, 'resources/skills/example/SKILL.md'), '# Example\n')
  write(path.join(root, 'build/icons/icon.ico'))
  write(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@cairn/desktop',
      version: '0.1.0',
      type: 'module',
      main: './out/main/index.js',
      productName: 'Cairn',
      dependencies: { zod: '4.6.6' },
      devDependencies: { electron: '45.2.1' },
    }),
  )
  return root
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('packageNameOf', () => {
  it.each([
    ['zod', 'zod'],
    ['zod/v4', 'zod'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/subpath', '@scope/pkg'],
    ['@scope', undefined],
    ['', undefined],
    ['./local.js', undefined],
    ['../local.js', undefined],
    ['/absolute.js', undefined],
    [path.resolve('absolute.js'), undefined],
    ['https://example.com/module.js', undefined],
    ['electron', undefined],
    ['node:fs', undefined],
  ])('maps %j to %j', (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected)
  })
})

describe('extractModuleSpecifiers', () => {
  it('extracts static and dynamic imports without treating comments as imports', async () => {
    const source = `
      // require('comment-only')
      /* import value from 'also-not-real' */
      import local from './local.js'
      export * from 'zod'
      const dynamic = await import('yaml')
      const metadata = import.meta.url
    `
    const specifiers = await extractModuleSpecifiers(source)
    expect(specifiers).toEqual(expect.arrayContaining(['./local.js', 'zod', 'yaml']))
    expect(specifiers).not.toContain('comment-only')
    expect(specifiers).not.toContain('also-not-real')
  })
})

describe('resolveRuntimeDependencies', () => {
  it('resolves, de-duplicates and sorts packages imported by built output', async () => {
    const root = desktopFixture()
    write(
      path.join(root, 'out/main/startup.js'),
      "import 'zod'\nimport { parse } from '@scope/pkg/subpath'\nimport fs from 'node:fs'\n",
    )
    write(path.join(root, 'out/preload/index.cjs'), "import 'zod'\n")
    const result = await resolveRuntimeDependencies({
      desktopRoot: root,
      dependencies: { zod: '4.6.6', '@scope/pkg': '1.0.0', unused: '1.0.0' },
    })
    expect(result).toEqual({
      dependencies: { '@scope/pkg': '1.0.0', zod: '4.6.6' },
      modules: ['@scope/pkg', 'zod'],
    })
  })

  it('fails when a runtime import is missing from dependencies', async () => {
    const root = desktopFixture()
    write(path.join(root, 'out/main/startup.js'), "import 'yaml'\n")
    await expect(
      resolveRuntimeDependencies({ desktopRoot: root, dependencies: { zod: '4.6.6' } }),
    ).rejects.toThrow(
      'runtime imports are missing from apps/desktop/package.json dependencies: yaml',
    )
  })

  it('returns an empty dependency set when there are no scan directories', async () => {
    const root = temporaryDirectory()
    await expect(
      resolveRuntimeDependencies({ desktopRoot: root, dependencies: { zod: '4.6.6' } }),
    ).resolves.toEqual({ dependencies: {}, modules: [] })
  })
})

describe('createStagedManifest', () => {
  const manifest = {
    name: '@cairn/desktop',
    version: '0.1.0',
    type: 'module',
    main: './out/main/index.js',
    productName: 'Cairn',
    description: 'Cairn',
    author: 'Cairn contributors',
    copyright: 'Copyright',
    private: false,
    devDependencies: { electron: '45.2.1', vite: '8.0.0' },
  }

  it('keeps only runtime fields and the Electron version', () => {
    expect(createStagedManifest({ manifest, dependencies: { zod: '4.6.6' } })).toEqual({
      name: '@cairn/desktop',
      version: '0.1.0',
      productName: 'Cairn',
      description: 'Cairn',
      author: 'Cairn contributors',
      copyright: 'Copyright',
      private: true,
      type: 'module',
      main: './out/main/index.js',
      dependencies: { zod: '4.6.6' },
      devDependencies: { electron: '45.2.1' },
      allowScripts: { koffi: true },
    })
  })

  it('supplies defaults for optional metadata', () => {
    expect(
      createStagedManifest({
        manifest: {
          name: '@cairn/desktop',
          version: '0.1.0',
          type: 'module',
          main: './out/main/index.js',
          devDependencies: { electron: '45.2.1' },
        },
        dependencies: { zod: '4.6.6' },
      }),
    ).toMatchObject({
      productName: 'Cairn',
      description: 'Cairn desktop application',
      author: 'Cairn contributors',
      copyright: '',
    })
  })

  it.each(['name', 'version', 'type', 'main'])('rejects a missing %s', (field) => {
    expect(() =>
      createStagedManifest({
        manifest: { ...manifest, [field]: '' },
        dependencies: { zod: '4.6.6' },
      }),
    ).toThrow(`apps/desktop/package.json is missing ${field}`)
  })

  it('requires Electron and at least one runtime dependency', () => {
    expect(() =>
      createStagedManifest({
        manifest: { ...manifest, devDependencies: {} },
        dependencies: { zod: '4.6.6' },
      }),
    ).toThrow('apps/desktop/package.json is missing the electron devDependency')
    expect(() => createStagedManifest({ manifest, dependencies: {} })).toThrow(
      'no runtime dependencies were discovered in the built main process',
    )
  })
})

describe('readJsonFile', () => {
  it('reads a JSON object and rejects other shapes', () => {
    const directory = temporaryDirectory()
    const valid = path.join(directory, 'valid.json')
    write(valid, '{"version":"0.1.0"}')
    expect(readJsonFile(valid)).toEqual({ version: '0.1.0' })

    const array = path.join(directory, 'array.json')
    write(array, '[]')
    expect(() => readJsonFile(array)).toThrow(`${array} is not a JSON object`)

    const invalid = path.join(directory, 'invalid.json')
    write(invalid, '{')
    expect(() => readJsonFile(invalid)).toThrow()
  })
})

describe('stageApplication', () => {
  it('copies build output and resource files and writes a runtime-only manifest', () => {
    const root = desktopFixture()
    const stage = path.join(root, '.package/app')
    const result = stageApplication({
      desktopRoot: root,
      stageDir: stage,
      dependencies: { zod: '4.6.6' },
      platform: 'win32',
    })
    expect(result.modules).toEqual(['zod'])
    expect(existsSync(path.join(stage, 'out/renderer/index.html'))).toBe(true)
    expect(existsSync(path.join(stage, 'resources/skills/example/SKILL.md'))).toBe(true)
    expect(existsSync(path.join(stage, 'build/icons/icon.ico'))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8'))).toMatchObject({
      name: '@cairn/desktop',
      version: '0.1.0',
      dependencies: { zod: '4.6.6' },
    })
    const npmrc = readFileSync(path.join(stage, '.npmrc'), 'utf8')
    expect(npmrc).toContain('registry=https://registry.npmjs.org/')
    expect(npmrc).toContain('audit=false')
  })

  it('replaces an existing staging directory', () => {
    const root = desktopFixture()
    const stage = path.join(root, '.package/app')
    write(path.join(stage, 'stale.txt'), 'stale')
    stageApplication({
      desktopRoot: root,
      stageDir: stage,
      dependencies: { zod: '4.6.6' },
      platform: 'win32',
    })
    expect(existsSync(path.join(stage, 'stale.txt'))).toBe(false)
  })

  it('fails before copying when a required build artifact is missing', () => {
    const root = desktopFixture()
    rmSync(path.join(root, 'out/bin/rg.exe'))
    expect(() =>
      stageApplication({
        desktopRoot: root,
        stageDir: path.join(root, '.package/app'),
        dependencies: { zod: '4.6.6' },
        platform: 'win32',
      }),
    ).toThrow('apps/desktop/out/bin/rg.exe is missing; run `pnpm build` first')
  })

  it('expects the platform-native ripgrep name on macOS and Linux', () => {
    const root = desktopFixture()
    rmSync(path.join(root, 'out/bin/rg.exe'))
    write(path.join(root, 'out/bin/rg'))
    const stage = path.join(root, '.package/app')
    stageApplication({
      desktopRoot: root,
      stageDir: stage,
      dependencies: { zod: '4.6.6' },
      platform: 'darwin',
    })
    expect(existsSync(path.join(stage, 'out/bin/rg'))).toBe(true)
    expect(() =>
      stageApplication({
        desktopRoot: root,
        stageDir: stage,
        dependencies: { zod: '4.6.6' },
        platform: 'linux',
      }),
    ).not.toThrow()
  })

  it('fails when built-in skills are missing', () => {
    const root = desktopFixture()
    rmSync(path.join(root, 'resources'), { recursive: true, force: true })
    expect(() =>
      stageApplication({
        desktopRoot: root,
        stageDir: path.join(root, '.package/app'),
        dependencies: { zod: '4.6.6' },
        platform: 'win32',
      }),
    ).toThrow('built-in skills are missing')
  })
})

describe('installProductionDependencies', () => {
  it('uses npm.cmd and a shell on Windows with isolated config', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    installProductionDependencies({
      stageDir: directory,
      runner,
      platform: 'win32',
      env: {
        npm_config_allow_scripts: 'true',
        NPM_CONFIG_ALLOW_SCRIPTS: 'true',
        KEEP_ME: 'yes',
      },
    })
    expect(runner).toHaveBeenCalledOnce()
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe('npm.cmd')
    expect(args).toEqual([
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
    ])
    expect(options).toMatchObject({ cwd: directory, shell: true, stdio: 'inherit' })
    expect(options?.env).toMatchObject({
      KEEP_ME: 'yes',
      NPM_CONFIG_USERCONFIG: path.join(directory, '.npmrc'),
      npm_config_userconfig: path.join(directory, '.npmrc'),
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    })
    expect(options?.env).not.toHaveProperty('npm_config_allow_scripts')
    expect(options?.env).not.toHaveProperty('NPM_CONFIG_ALLOW_SCRIPTS')
  })

  it('uses a bare npm command without a shell on other platforms', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    installProductionDependencies({ stageDir: directory, runner, platform: 'linux' })
    expect(runner.mock.calls[0]?.[0]).toBe('npm')
    expect(runner.mock.calls[0]?.[2]).toMatchObject({ shell: false })
  })

  it('reports the exit status or signal when installation fails', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 2,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    expect(() =>
      installProductionDependencies({ stageDir: directory, runner, platform: 'linux' }),
    ).toThrow('npm install in the staging directory failed with 2')

    const signaled = vi.fn<typeof spawnSync>(() => ({
      status: null,
      signal: 'SIGTERM',
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    expect(() =>
      installProductionDependencies({ stageDir: directory, runner: signaled, platform: 'linux' }),
    ).toThrow('npm install in the staging directory failed with SIGTERM')
  })
})

describe('pruneStagedDependencies', () => {
  it('removes unrelated SQLite prebuilds and C sources', () => {
    const directory = temporaryDirectory()
    const prebuilds = path.join(directory, 'node_modules/better-sqlite3/prebuilds')
    write(path.join(prebuilds, 'win32-x64.node'))
    write(path.join(prebuilds, 'linux-x64.node'))
    write(path.join(prebuilds, 'darwin-arm64.node'))
    mkdirSync(path.join(prebuilds, 'nested'), { recursive: true })
    write(path.join(directory, 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c'))

    expect(
      pruneStagedDependencies({ stageDir: directory, platform: 'win32', arch: 'x64' }),
    ).toEqual({
      removed: ['darwin-arm64.node', 'linux-x64.node', 'better-sqlite3/deps'],
      kept: ['win32-x64.node'],
    })
    expect(readdirSync(prebuilds).sort()).toEqual(['nested', 'win32-x64.node'])
    expect(existsSync(path.join(directory, 'node_modules/better-sqlite3/deps'))).toBe(false)
  })

  it('keeps both macOS prebuilds for a dual-architecture build', () => {
    const directory = temporaryDirectory()
    const prebuilds = path.join(directory, 'node_modules/better-sqlite3/prebuilds')
    for (const name of [
      'darwin-arm64.node',
      'darwin-x64.node',
      'linux-x64.node',
      'win32-x64.node',
    ]) {
      write(path.join(prebuilds, name))
    }
    expect(
      pruneStagedDependencies({ stageDir: directory, platform: 'darwin', arch: 'arm64' }),
    ).toEqual({
      removed: ['linux-x64.node', 'win32-x64.node'],
      kept: ['darwin-arm64.node', 'darwin-x64.node'],
    })
    expect(readdirSync(prebuilds).sort()).toEqual(['darwin-arm64.node', 'darwin-x64.node'])
  })

  it('is a no-op when optional native directories do not exist', () => {
    const directory = temporaryDirectory()
    expect(pruneStagedDependencies({ stageDir: directory })).toEqual({
      removed: [],
      kept: [`${process.platform}-${process.arch}.node`],
    })
  })
})

describe('electron-builder invocation', () => {
  it('resolves the installed electron-builder CLI', () => {
    expect(existsSync(electronBuilderCli())).toBe(true)
  })

  it('passes the staging directory, config and --publish never', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    runElectronBuilder({
      target: 'dir',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'win32',
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'true' },
    })
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toContain('--projectDir')
    expect(args).toContain(directory)
    expect(args).toContain('--publish')
    expect(args).toContain('never')
    expect(args).toContain('--dir')
    expect(args).toContain('--config.afterPack')
    expect(args).toContain(AFTER_PACK_HOOK)
    expect(options?.env).toMatchObject({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' })
  })

  it('requests an NSIS installer and defaults to no certificate discovery', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    runElectronBuilder({
      target: 'nsis',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'win32',
      env: {},
    })
    expect(runner.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--win', 'nsis']))
    expect(runner.mock.calls[0]?.[2]?.env).toMatchObject({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
  })

  it('passes signing configuration to electron-builder without exposing the certificate', () => {
    const directory = temporaryDirectory()
    const certificate = 'base64-pfx-fixture'
    const password = 'pfx-fixture-passphrase'
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    runElectronBuilder({
      target: 'nsis',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'win32',
      env: {},
      signing: {
        mode: 'pfx',
        publisher: 'CN=Cairn, O=Cairn',
        timestampUrl: 'https://timestamp.digicert.com',
        certificate,
        password,
      },
    })
    const [, args, options] = runner.mock.calls[0]!
    expect(args).toEqual(
      expect.arrayContaining([
        '--config.win.signExecutable=true',
        '--config.win.signtoolOptions.publisherName=CN=Cairn, O=Cairn',
        '--config.win.signtoolOptions.signingHashAlgorithms=sha256',
        '--config.win.signtoolOptions.rfc3161TimeStampServer=https://timestamp.digicert.com',
      ]),
    )
    expect(args.some((argument) => argument.includes(certificate))).toBe(false)
    expect(args.some((argument) => argument.includes(password))).toBe(false)
    expect(options?.env).toMatchObject({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      WIN_CSC_LINK: certificate,
    })
  })

  it('builds macOS DMG and ZIP with Developer ID configuration', () => {
    const directory = temporaryDirectory()
    const certificate = 'base64-p12-fixture'
    const password = '{{SECRET_mac8k2xq}}'
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    runElectronBuilder({
      target: 'mac',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'darwin',
      env: {},
      macSigning: {
        mode: 'developer-id',
        identity: 'Developer ID Application: Cairn (TEAMID)',
        certificate,
        password,
        notarize: { appleId: 'ci@example.com', appleIdPassword: 'app-password', teamId: 'TEAMID' },
      },
    })
    const [, args, options] = runner.mock.calls[0]!
    expect(args).toEqual(expect.arrayContaining(['--mac', 'dmg', 'zip']))
    expect(args).toEqual(
      expect.arrayContaining([
        '--config.mac.identity=Developer ID Application: Cairn (TEAMID)',
        '--config.mac.notarize=true',
      ]),
    )
    expect(args.some((argument) => argument.includes(certificate))).toBe(false)
    expect(args.some((argument) => argument.includes(password))).toBe(false)
    expect(options?.env).toMatchObject({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: certificate,
      CSC_KEY_PASSWORD: password,
      APPLE_ID: 'ci@example.com',
      APPLE_TEAM_ID: 'TEAMID',
    })
  })

  it('reads macOS signing configuration from the environment by default', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: '',
      stderr: '',
    }))
    runElectronBuilder({
      target: 'mac',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'darwin',
      env: {},
    })
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toContain('--mac')
    expect(args.some((arg) => String(arg).startsWith('--config.mac.identity='))).toBe(false)
    expect(options?.env).toMatchObject({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  })

  it('builds Linux AppImage and deb without a signing environment', () => {
    const directory = temporaryDirectory()
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: '',
      stderr: '',
    }))
    const env = { PATH: '/usr/bin' }
    runElectronBuilder({
      target: 'linux',
      stageDir: directory,
      outputDir: path.join(directory, 'dist'),
      runner,
      platform: 'linux',
      env,
    })
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual(expect.arrayContaining(['--linux', 'AppImage', 'deb']))
    expect(args.some((arg) => String(arg).startsWith('--config.win'))).toBe(false)
    expect(options?.env).toBe(env)
  })

  it('only builds each installer on its own platform and reports builder failures', () => {
    expect(() => runElectronBuilder({ target: 'nsis', platform: 'linux' })).toThrow(
      'NSIS packaging is supported on Windows only (ADR-0035)',
    )
    expect(() => runElectronBuilder({ target: 'mac', platform: 'win32' })).toThrow(
      'macOS packaging must run on macOS (ADR-0041)',
    )
    expect(() => runElectronBuilder({ target: 'linux', platform: 'win32' })).toThrow(
      'Linux packaging must run on Linux (ADR-0042)',
    )
    const runner = vi.fn<typeof spawnSync>(() => ({
      status: 1,
      signal: null,
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    expect(() => runElectronBuilder({ target: 'dir', runner, platform: 'win32' })).toThrow(
      'electron-builder failed with 1',
    )

    const signaled = vi.fn<typeof spawnSync>(() => ({
      status: null,
      signal: 'SIGTERM',
      output: [],
      pid: 1,
      stdout: null,
      stderr: null,
    }))
    expect(() =>
      runElectronBuilder({ target: 'dir', runner: signaled, platform: 'win32' }),
    ).toThrow('electron-builder failed with SIGTERM')
  })
})

describe('writeChecksum', () => {
  it('writes the SHA-256 and file name next to the artifact', () => {
    const directory = temporaryDirectory()
    const file = path.join(directory, 'Cairn-0.1.0-x64-setup.exe')
    write(file, 'installer bytes')
    const checksum = writeChecksum(file)
    const expected = createHash('sha256').update('installer bytes').digest('hex')
    expect(checksum).toBe(`${file}.sha256`)
    expect(readFileSync(checksum, 'utf8')).toBe(`${expected}  Cairn-0.1.0-x64-setup.exe\n`)
  })
})

describe('main', () => {
  function packagingFixture(): {
    desktopRoot: string
    stageDir: string
    outputDir: string
  } {
    const desktopRoot = desktopFixture()
    return {
      desktopRoot,
      stageDir: path.join(desktopRoot, '.package/app'),
      outputDir: path.join(desktopRoot, 'dist'),
    }
  }

  it('rejects an invocation without a target', async () => {
    await expect(main({ argv: [], desktopRoot: desktopFixture() })).rejects.toThrow(
      'usage: packaging.mjs --dir|--nsis|--mac|--linux',
    )
  })

  it('stages, installs, builds and verifies an unpacked application', async () => {
    const paths = packagingFixture()
    const install = vi.fn()
    const build = vi.fn()
    const verify = vi.fn(async () => [])
    const log = vi.fn()
    const code = await main({
      argv: ['--dir'],
      ...paths,
      platform: 'win32',
      install,
      build,
      verify,
      log,
    })
    expect(code).toBe(0)
    expect(install).toHaveBeenCalledWith({ stageDir: paths.stageDir })
    expect(build).toHaveBeenCalledWith({
      target: 'dir',
      desktopRoot: paths.desktopRoot,
      stageDir: paths.stageDir,
      outputDir: paths.outputDir,
      platform: 'win32',
    })
    expect(verify).toHaveBeenCalledWith({
      desktopRoot: paths.desktopRoot,
      outputDir: paths.outputDir,
      target: 'dir',
      platform: 'win32',
    })
    expect(log.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        'package: 1 runtime dependencies: zod',
        expect.stringContaining('package: staged Cairn 0.1.0'),
        'package: pruned 0 unnecessary native/source entries',
        'package: unpacked application verified',
      ]),
    )
  })

  it('uses the default console logger', async () => {
    const paths = packagingFixture()
    const print = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(
        main({
          argv: ['--dir'],
          ...paths,
          platform: 'win32',
          install: vi.fn(),
          build: vi.fn(),
          verify: vi.fn(async () => []),
        }),
      ).resolves.toBe(0)
      expect(print).toHaveBeenCalledWith('package: unpacked application verified')
    } finally {
      print.mockRestore()
    }
  })

  it('uses an empty dependency object when the manifest has no dependencies', async () => {
    const paths = packagingFixture()
    write(path.join(paths.desktopRoot, 'out/main/index.js'), '')
    write(
      path.join(paths.desktopRoot, 'package.json'),
      JSON.stringify({
        name: '@cairn/desktop',
        version: '0.1.0',
        type: 'module',
        main: './out/main/index.js',
        devDependencies: { electron: '45.2.1' },
      }),
    )
    await expect(
      main({
        argv: ['--dir'],
        ...paths,
        platform: 'win32',
        install: vi.fn(),
        build: vi.fn(),
        verify: vi.fn(async () => []),
        log: vi.fn(),
      }),
    ).rejects.toThrow('no runtime dependencies were discovered in the built main process')
  })

  it('writes a checksum for a successful NSIS build', async () => {
    const paths = packagingFixture()
    const build = vi.fn(({ outputDir }) => {
      write(path.join(outputDir, 'Cairn-0.1.0-x64-setup.exe'), 'installer')
    })
    const code = await main({
      argv: ['--nsis'],
      ...paths,
      platform: 'win32',
      install: vi.fn(),
      build,
      verify: vi.fn(async () => []),
      log: vi.fn(),
    })
    expect(code).toBe(0)
    expect(existsSync(path.join(paths.outputDir, 'Cairn-0.1.0-x64-setup.exe.sha256'))).toBe(true)
  })

  it('fails when the NSIS installer is missing or verification finds problems', async () => {
    const paths = packagingFixture()
    await expect(
      main({
        argv: ['--nsis'],
        ...paths,
        platform: 'win32',
        install: vi.fn(),
        build: vi.fn(),
        verify: vi.fn(async () => []),
        log: vi.fn(),
      }),
    ).rejects.toThrow('NSIS installer was not created')

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await main({
        argv: ['--dir'],
        ...paths,
        platform: 'win32',
        install: vi.fn(),
        build: vi.fn(),
        verify: vi.fn(async () => ['bad package']),
        log: vi.fn(),
      })
      expect(code).toBe(1)
      expect(error).toHaveBeenCalledWith('package: bad package')
    } finally {
      error.mockRestore()
    }
  })

  it('writes checksums for both macOS architectures and verifies the DMG set', async () => {
    const paths = packagingFixture()
    rmSync(path.join(paths.desktopRoot, 'out/bin/rg.exe'))
    write(path.join(paths.desktopRoot, 'out/bin/rg'))
    const verify = vi.fn(async () => [])
    const code = await main({
      argv: ['--mac'],
      ...paths,
      platform: 'darwin',
      install: vi.fn(),
      build: vi.fn(({ outputDir }) => {
        for (const arch of ['arm64', 'x64']) {
          for (const ext of ['dmg', 'zip']) {
            write(path.join(outputDir, `Cairn-0.1.0-${arch}.${ext}`), `${arch} ${ext}`)
          }
        }
      }),
      verify,
      log: vi.fn(),
    })
    expect(code).toBe(0)
    expect(verify).toHaveBeenCalledWith({
      desktopRoot: paths.desktopRoot,
      outputDir: paths.outputDir,
      target: 'mac',
      platform: 'darwin',
    })
    for (const arch of ['arm64', 'x64']) {
      expect(existsSync(path.join(paths.outputDir, `Cairn-0.1.0-${arch}.dmg.sha256`))).toBe(true)
      expect(existsSync(path.join(paths.outputDir, `Cairn-0.1.0-${arch}.zip.sha256`))).toBe(true)
    }
  })

  it('writes checksums for the Linux AppImage and deb', async () => {
    const paths = packagingFixture()
    rmSync(path.join(paths.desktopRoot, 'out/bin/rg.exe'))
    write(path.join(paths.desktopRoot, 'out/bin/rg'))
    const verify = vi.fn(async () => [])
    const code = await main({
      argv: ['--linux'],
      ...paths,
      platform: 'linux',
      install: vi.fn(),
      build: vi.fn(({ outputDir }) => {
        write(path.join(outputDir, 'Cairn-0.1.0-x64.AppImage'), 'appimage')
        write(path.join(outputDir, 'Cairn-0.1.0-x64.deb'), 'deb')
      }),
      verify,
      log: vi.fn(),
    })
    expect(code).toBe(0)
    expect(verify).toHaveBeenCalledWith({
      desktopRoot: paths.desktopRoot,
      outputDir: paths.outputDir,
      target: 'linux',
      platform: 'linux',
    })
    expect(existsSync(path.join(paths.outputDir, 'Cairn-0.1.0-x64.AppImage.sha256'))).toBe(true)
    expect(existsSync(path.join(paths.outputDir, 'Cairn-0.1.0-x64.deb.sha256'))).toBe(true)
  })

  it('lists every Linux artifact when the builder produces nothing', async () => {
    const paths = packagingFixture()
    rmSync(path.join(paths.desktopRoot, 'out/bin/rg.exe'))
    write(path.join(paths.desktopRoot, 'out/bin/rg'))
    await expect(
      main({
        argv: ['--linux'],
        ...paths,
        platform: 'linux',
        install: vi.fn(),
        build: vi.fn(),
        verify: vi.fn(async () => []),
        log: vi.fn(),
      }),
    ).rejects.toThrow(
      'Linux artifacts were not created: Cairn-0.1.0-x64.AppImage, Cairn-0.1.0-x64.deb',
    )
  })

  it('lists every macOS artifact when the builder produces nothing', async () => {
    const paths = packagingFixture()
    rmSync(path.join(paths.desktopRoot, 'out/bin/rg.exe'))
    write(path.join(paths.desktopRoot, 'out/bin/rg'))
    const verify = vi.fn(async () => [])
    await expect(
      main({
        argv: ['--mac'],
        ...paths,
        platform: 'darwin',
        install: vi.fn(),
        build: vi.fn(),
        verify,
        log: vi.fn(),
      }),
    ).rejects.toThrow(
      'macOS artifacts were not created: Cairn-0.1.0-arm64.dmg, Cairn-0.1.0-arm64.zip, Cairn-0.1.0-x64.dmg, Cairn-0.1.0-x64.zip',
    )
    expect(verify).not.toHaveBeenCalled()
  })

  it('fails when a macOS artifact is missing', async () => {
    const paths = packagingFixture()
    rmSync(path.join(paths.desktopRoot, 'out/bin/rg.exe'))
    write(path.join(paths.desktopRoot, 'out/bin/rg'))
    await expect(
      main({
        argv: ['--mac'],
        ...paths,
        platform: 'darwin',
        install: vi.fn(),
        build: vi.fn(({ outputDir }) => {
          write(path.join(outputDir, 'Cairn-0.1.0-arm64.dmg'), 'dmg')
        }),
        verify: vi.fn(async () => []),
        log: vi.fn(),
      }),
    ).rejects.toThrow('macOS artifacts were not created: Cairn-0.1.0-arm64.zip')
  })
})
