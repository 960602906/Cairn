import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkInstalledLayout,
  installedArtifacts,
  installerArguments,
  installerPath,
  queryUninstallRegistry,
  readVersion,
  runCli,
  runProcess,
  smokeInstalled,
  uninstallerArguments,
} from './smoke-installed.mjs'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-installed-test-'))
  directories.push(directory)
  return directory
}

function write(file: string, content = ''): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

interface FakeChild extends EventEmitter {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
    kill: {
      value: vi.fn(() => {
        child.emit('exit', null, 'SIGTERM')
      }),
    },
  })
  return child
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('installation paths and arguments', () => {
  it('reads the desktop version and derives the installer name', () => {
    const root = temporaryDirectory()
    write(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    expect(readVersion({ desktopRoot: root })).toBe('0.1.0')
    expect(installerPath({ desktopRoot: root })).toBe(
      path.join(root, 'dist', 'Cairn-0.1.0-x64-setup.exe'),
    )
  })

  it('rejects a manifest without a version', () => {
    const root = temporaryDirectory()
    write(path.join(root, 'package.json'), '{}')
    expect(() => readVersion({ desktopRoot: root })).toThrow(
      'apps/desktop/package.json is missing version',
    )
  })

  it('requires an absolute install directory and puts /D last', () => {
    const directory = path.resolve('Cairn')
    expect(installerArguments(directory)).toEqual(['/S', `/D=${directory}`])
    expect(() => installerArguments('relative')).toThrow('NSIS install directory must be absolute')
    expect(uninstallerArguments()).toEqual(['/S', '/currentuser'])
  })

  it('derives executable, uninstaller, shortcuts and resources', () => {
    expect(
      installedArtifacts({
        installDir: 'C:/Apps/Cairn',
        env: { USERPROFILE: 'C:/Users/test', APPDATA: 'C:/Users/test/AppData/Roaming' },
      }),
    ).toEqual({
      executable: path.join('C:/Apps/Cairn', 'Cairn.exe'),
      uninstaller: path.join('C:/Apps/Cairn', 'Uninstall Cairn.exe'),
      shortcuts: [
        path.join('C:/Users/test', 'Desktop', 'Cairn.lnk'),
        path.join(
          'C:/Users/test/AppData/Roaming',
          'Microsoft/Windows/Start Menu/Programs',
          'Cairn.lnk',
        ),
      ],
      resources: path.join('C:/Apps/Cairn', 'resources'),
    })
  })

  it('falls back to the operating system home directory', () => {
    const artifacts = installedArtifacts({ installDir: 'C:/Apps/Cairn', env: {} })
    expect(artifacts.shortcuts).toEqual([
      path.join(homedir(), 'Desktop', 'Cairn.lnk'),
      path.join(homedir(), 'AppData/Roaming', 'Microsoft/Windows/Start Menu/Programs', 'Cairn.lnk'),
    ])
  })
})

describe('checkInstalledLayout', () => {
  const installDir = 'C:/Temp/cairn-install'
  const home = 'C:/Users/test'
  const env = { USERPROFILE: home, APPDATA: `${home}/AppData/Roaming` }

  it('accepts a complete installation', () => {
    expect(
      checkInstalledLayout({
        installDir,
        version: '0.1.0',
        registryOutput: `DisplayName Cairn 0.1.0\nUninstallString ${installDir}\\Uninstall Cairn.exe`,
        env,
        exists: () => true,
      }),
    ).toEqual([])
  })

  it('reports missing files, shortcuts and registry details', () => {
    const problems = checkInstalledLayout({
      installDir,
      version: '0.1.0',
      registryOutput: 'unrelated',
      env,
      exists: () => false,
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('installed app is missing main executable:'),
        expect.stringContaining('installed app is missing uninstaller:'),
        expect.stringContaining('installed app is missing app.asar:'),
        expect.stringContaining('installed app is missing asarUnpack ripgrep:'),
        expect.stringContaining('installed app is missing built-in skills:'),
        expect.stringContaining('installed app is missing shortcut:'),
        'uninstall registry entry does not contain Cairn 0.1.0',
        'uninstall registry entry does not point at the temporary install directory',
      ]),
    )
  })

  it('accepts an explicit home directory', () => {
    expect(
      checkInstalledLayout({
        installDir,
        version: '0.1.0',
        registryOutput: `DisplayName Cairn 0.1.0\nUninstallString ${installDir}\\Uninstall Cairn.exe`,
        env,
        home,
        exists: () => true,
      }),
    ).toEqual([])
  })
})

describe('queryUninstallRegistry', () => {
  it('returns the entry only when it points at the temporary installation', () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: 'DisplayName Cairn 0.1.0\nUninstallString C:\\Temp\\Cairn\\Uninstall Cairn.exe\n',
      stderr: '',
    }))
    expect(queryUninstallRegistry({ installDir: 'C:\\Temp\\Cairn', runner })).toContain(
      'Uninstall Cairn.exe',
    )
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe('reg.exe')
    expect(args).toEqual([
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s',
      '/f',
      'Cairn',
    ])
    expect(options).toMatchObject({ encoding: 'utf8', windowsHide: true })
    expect(queryUninstallRegistry({ installDir: 'C:\\Other', runner })).toBe('')
  })

  it('treats missing runner output as no match', () => {
    const runner = vi.fn(() => ({ status: 1, stdout: null, stderr: null }))
    expect(queryUninstallRegistry({ installDir: 'C:\\Temp', runner: runner as never })).toBe('')
  })
})

describe('runProcess', () => {
  it('captures output and exit status', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child)
    const promise = runProcess({
      file: 'Cairn.exe',
      args: ['--version'],
      spawnProcess: spawnProcess as never,
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      'Cairn.exe',
      ['--version'],
      expect.objectContaining({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    )
    child.stdout.write('stdout\n')
    child.stderr.write('stderr\n')
    child.emit('exit', 0, null)
    await expect(promise).resolves.toEqual({
      code: 0,
      signal: null,
      output: 'stdout\nstderr\n',
      timedOut: false,
    })
    child.emit('exit', 1, null)
    await expect(promise).resolves.toMatchObject({ code: 0, signal: null })
  })

  it('reports spawn errors and timeouts', async () => {
    const broken = fakeChild()
    const errorPromise = runProcess({
      file: 'missing.exe',
      spawnProcess: (() => broken) as never,
    })
    broken.emit('error', new Error('spawn ENOENT'))
    await expect(errorPromise).resolves.toMatchObject({
      code: null,
      error: 'spawn ENOENT',
      timedOut: false,
    })

    vi.useFakeTimers()
    const slow = fakeChild()
    const timeoutPromise = runProcess({
      file: 'slow.exe',
      timeoutMs: 10,
      spawnProcess: (() => slow) as never,
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(slow.kill).toHaveBeenCalledOnce()
    await expect(timeoutPromise).resolves.toMatchObject({ timedOut: true })
  })
})

describe('smokeInstalled', () => {
  it('rejects non-Windows platforms and missing installers', async () => {
    await expect(smokeInstalled({ platform: 'linux' })).resolves.toEqual([
      'installed-app smoke supports Windows only (ADR-0035)',
    ])
    const root = temporaryDirectory()
    write(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    const missing = path.join(root, 'missing.exe')
    await expect(smokeInstalled({ platform: 'win32', desktopRoot: root })).resolves.toEqual([
      `NSIS installer was not found: ${path.join(root, 'dist', 'Cairn-0.1.0-x64-setup.exe')}`,
    ])
    await expect(smokeInstalled({ platform: 'win32', installer: missing })).resolves.toEqual([
      `NSIS installer was not found: ${missing}`,
    ])
  })
})

const SMOKE_RESULT =
  'CAIRN_SMOKE_RESULT {"ok":true,"turnCompleted":true,"search":"hit","skills":["example"],"native":"job-object"}\n'
const verifyGit = () => ({ version: 'git version 2.56.0', files: 1, bytes: 1 })

function createInstallation(installDir: string): ReturnType<typeof installedArtifacts> {
  const artifacts = installedArtifacts({ installDir })
  for (const file of [
    artifacts.executable,
    artifacts.uninstaller,
    path.join(artifacts.resources, 'app.asar'),
    path.join(artifacts.resources, 'app.asar.unpacked/out/bin/rg.exe'),
    path.join(artifacts.resources, 'skills/example/SKILL.md'),
    ...artifacts.shortcuts,
  ]) {
    write(file)
  }
  return artifacts
}

interface WorkflowOptions {
  installer: string
  application?: 'pass' | 'timeout'
  uninstall?: 'pass' | 'timeout' | 'error'
  ripgrep?: 'pass' | 'fail'
}

function workflowSpawn({
  installer,
  application = 'pass',
  uninstall = 'pass',
  ripgrep = 'pass',
}: WorkflowOptions) {
  const state: { installDir: string; artifacts?: ReturnType<typeof installedArtifacts> } = {
    installDir: '',
  }
  return vi.fn(
    (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): FakeChild => {
      const child = fakeChild()
      if (file === installer) {
        state.installDir = args[1]!.slice(3)
        state.artifacts = createInstallation(state.installDir)
        queueMicrotask(() => child.emit('exit', 0, null))
      } else if (file.endsWith('rg.exe')) {
        queueMicrotask(() => {
          if (ripgrep === 'pass') child.stdout.write('installed-command.txt\n')
          child.emit('exit', ripgrep === 'pass' ? 0 : 1, null)
        })
      } else if (file === state.artifacts?.executable) {
        queueMicrotask(() => {
          if (application === 'timeout') return
          const userData = options.env['CAIRN_USER_DATA_DIR']!
          for (const relative of ['data/cairn.db', 'data/blobs', 'checkpoints', 'logs']) {
            write(path.join(userData, relative))
          }
          child.stdout.write(SMOKE_RESULT)
          child.emit('exit', 0, null)
        })
      } else if (uninstall === 'timeout') {
        // 卸载器永不退出，由超时逻辑终止。
      } else if (uninstall === 'error') {
        queueMicrotask(() => child.emit('error', new Error('boom')))
      } else {
        rmSync(state.installDir, { recursive: true, force: true })
        for (const shortcut of state.artifacts?.shortcuts ?? []) rmSync(shortcut, { force: true })
        queueMicrotask(() => child.emit('exit', 0, null))
      }
      return child
    },
  )
}

describe('smokeInstalled workflow', () => {
  let home = ''

  beforeEach(() => {
    home = temporaryDirectory()
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('APPDATA', path.join(home, 'AppData/Roaming'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function fixture(): { root: string; installer: string } {
    const root = temporaryDirectory()
    write(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    const installer = path.join(root, 'dist', 'Cairn-0.1.0-x64-setup.exe')
    write(installer, 'setup')
    return { root, installer }
  }

  it('installs, smokes and uninstalls a complete application', async () => {
    const { root, installer } = fixture()
    const log = vi.fn()
    const spawnProcess = workflowSpawn({ installer })

    const problems = await smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: spawnProcess as never,
      verifyGit,
      log,
    })

    expect(problems.filter((problem) => !problem.startsWith('uninstall registry entry'))).toEqual(
      [],
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`installing ${installer}`))
    expect(log).toHaveBeenCalledWith('installed: running application smoke checks')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CAIRN_SMOKE_RESULT'))
    expect(log).toHaveBeenCalledWith('installed: uninstalling')
    expect(installerPath({ desktopRoot: root, outputDir: path.join(root, 'other') })).toBe(
      path.join(root, 'other', 'Cairn-0.1.0-x64-setup.exe'),
    )
  })

  it('verifies signatures of the installed app and uninstaller when requested', async () => {
    const { root, installer } = fixture()
    const verifySignatures = vi.fn(() => ['uninstaller is not signed'])
    const problems = await smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: workflowSpawn({ installer }) as never,
      verifyGit,
      verifySignatures: verifySignatures as never,
      env: {
        CAIRN_VERIFY_SIGNATURES: '1',
        CAIRN_SIGN_MODE: 'pfx',
        CAIRN_UPDATE_PUBLISHER: 'CN=Cairn, O=Cairn',
        WINDOWS_CERTIFICATE: 'base64-pfx',
        WINDOWS_CERTIFICATE_PASSWORD: 'pfx-fixture-passphrase',
      },
      log: vi.fn(),
    })
    expect(problems.filter((problem) => !problem.startsWith('uninstall registry entry'))).toEqual([
      'uninstaller is not signed',
    ])
    expect(verifySignatures).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.1.0',
        config: expect.objectContaining({ mode: 'pfx', publisher: 'CN=Cairn, O=Cairn' }),
        installedDir: expect.stringContaining('app'),
      }),
    )
  })

  it('reports an installer that never exits', async () => {
    vi.useFakeTimers()
    const { root, installer } = fixture()
    const promise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: (() => fakeChild()) as never,
      log: vi.fn(),
    })

    await vi.runAllTimersAsync()

    await expect(promise).resolves.toEqual([
      'NSIS installer timed out',
      'NSIS installer exited with null (SIGTERM)',
      'NSIS installer did not create the installed executable',
    ])
  })

  it('reports an installer that cannot be started or exits non-zero', async () => {
    const { root, installer } = fixture()
    const broken = fakeChild()
    const errorPromise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: (() => broken) as never,
      log: vi.fn(),
    })
    broken.emit('error', new Error('boom'))
    await expect(errorPromise).resolves.toEqual([
      'cannot start NSIS installer: boom',
      'NSIS installer did not create the installed executable',
    ])

    const failed = fakeChild()
    const exitPromise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: (() => failed) as never,
      log: vi.fn(),
    })
    failed.emit('exit', 2, null)
    await expect(exitPromise).resolves.toEqual([
      'NSIS installer exited with 2 (null)',
      'NSIS installer did not create the installed executable',
    ])
  })

  it('reports command, application and uninstall failures', async () => {
    vi.useFakeTimers()
    const { root, installer } = fixture()
    const promise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: workflowSpawn({
        installer,
        application: 'timeout',
        uninstall: 'timeout',
        ripgrep: 'fail',
      }) as never,
      verifyGit,
      log: vi.fn(),
    })

    await vi.runAllTimersAsync()

    await expect(promise).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('installed ripgrep command failed'),
        'installed application smoke timed out',
        'no valid smoke result was printed',
        'missing data/cairn.db',
        'missing data/blobs',
        'missing checkpoints',
        'missing logs',
        'application exited with null (SIGTERM)',
        'NSIS uninstaller timed out',
        'uninstall did not remove files, shortcuts and registry entry',
        'uninstall removed the user data directory',
      ]),
    )
  })

  it('reports an uninstaller that cannot be started', async () => {
    vi.useFakeTimers()
    const { root, installer } = fixture()
    const promise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: workflowSpawn({ installer, uninstall: 'error' }) as never,
      verifyGit,
      log: vi.fn(),
    })

    await vi.runAllTimersAsync()

    const problems = await promise
    expect(problems.filter((problem) => !problem.startsWith('uninstall registry entry'))).toEqual([
      'cannot start NSIS uninstaller: boom',
      'uninstall did not remove files, shortcuts and registry entry',
    ])
  })

  it('writes progress to stdout by default', async () => {
    const { root, installer } = fixture()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await smokeInstalled({
        installer,
        desktopRoot: root,
        platform: 'win32',
        spawnProcess: workflowSpawn({ installer }) as never,
        verifyGit,
      })
      expect(write).toHaveBeenCalledWith(expect.stringContaining('installed: uninstalling'))
    } finally {
      write.mockRestore()
    }
  })

  it('reports a broken bundled MinGit', async () => {
    vi.useFakeTimers()
    const { root, installer } = fixture()
    const promise = smokeInstalled({
      installer,
      desktopRoot: root,
      platform: 'win32',
      spawnProcess: workflowSpawn({ installer, uninstall: 'timeout' }) as never,
      verifyGit: () => {
        throw new Error('bad git')
      },
      log: vi.fn(),
    })

    await vi.runAllTimersAsync()

    await expect(promise).resolves.toEqual(
      expect.arrayContaining(['installed bundled MinGit failed: bad git']),
    )
  })
})

describe('runCli', () => {
  it('prints success and failure with the expected exit code', async () => {
    const print = vi.fn()
    const error = vi.fn()
    const setExitCode = vi.fn()
    await expect(runCli({ run: async () => [], print, error, setExitCode })).resolves.toBe(0)
    expect(print).toHaveBeenCalledWith('smoke:installed: passed')
    expect(setExitCode).toHaveBeenCalledWith(0)
    await expect(runCli({ run: async () => ['bad'], print, error, setExitCode })).resolves.toBe(1)
    expect(error).toHaveBeenCalledWith('smoke:installed: bad')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('uses the default reporters and exit code handling', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const previousExitCode = process.exitCode
    try {
      await expect(runCli({ run: async () => [] })).resolves.toBe(0)
      expect(log).toHaveBeenCalledWith('smoke:installed: passed')
      expect(process.exitCode).toBe(0)
      await expect(runCli({ run: async () => ['bad'] })).resolves.toBe(1)
      expect(error).toHaveBeenCalledWith('smoke:installed: bad')
      expect(process.exitCode).toBe(1)
    } finally {
      log.mockRestore()
      error.mockRestore()
      process.exitCode = previousExitCode
    }
  })
})
