import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli, smokePackaged } from './smoke-packaged.mjs'

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

const app = { directory: 'C:/cairn', executable: 'C:/cairn/Cairn.exe' }

function options(child: FakeChild, overrides: Record<string, unknown> = {}) {
  const cleanup = vi.fn()
  const checkResult = vi.fn(() => [])
  const log = vi.fn()
  const spawnProcess = vi.fn(() => child)
  return {
    spawnProcess,
    cleanup,
    checkResult,
    log,
    locateApp: () => app,
    createUserData: () => ({ path: 'C:/temp/cairn', cleanup }),
    timeoutMs: 1_000,
    platform: 'win32' as const,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('smokePackaged', () => {
  it('captures stdout/stderr and returns the result check', async () => {
    const child = fakeChild()
    const base = options(child)
    const promise = smokePackaged(base)
    expect(base.spawnProcess).toHaveBeenCalledWith(
      app.executable,
      [],
      expect.objectContaining({
        cwd: app.directory,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    )
    child.stdout.write('from stdout\n')
    child.stderr.write('from stderr\n')
    child.emit('exit', 0, null)
    await expect(promise).resolves.toEqual([])
    expect(base.log).toHaveBeenCalledWith('from stdout\nfrom stderr')
    expect(base.checkResult).toHaveBeenCalledWith({
      output: 'from stdout\nfrom stderr\n',
      exitCode: 0,
      signal: null,
      userData: 'C:/temp/cairn',
      platform: 'win32',
    })
    expect(base.cleanup).toHaveBeenCalledOnce()
  })

  it('passes platform-specific flags and the smoke environment', async () => {
    const child = fakeChild()
    const base = options(child, { platform: 'linux' })
    const promise = smokePackaged(base)
    expect(base.spawnProcess).toHaveBeenCalledWith(
      app.executable,
      ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox'],
      expect.objectContaining({
        env: expect.objectContaining({
          CAIRN_SMOKE: '1',
          CAIRN_RUNTIME: 'fake',
          CAIRN_USER_DATA_DIR: 'C:/temp/cairn',
        }),
      }),
    )
    child.emit('exit', 0, null)
    await promise
  })

  it('supports an explicit output directory and the default log sink', async () => {
    const child = fakeChild()
    const locateApp = vi.fn(() => app)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const base = options(child, {
      outputDir: 'C:/dist',
      locateApp,
      log: undefined,
    })
    try {
      const promise = smokePackaged(base)
      expect(locateApp).toHaveBeenCalledWith({ outputDir: 'C:/dist' })
      child.stdout.write('default log\n')
      child.emit('exit', 0, null)
      await promise
      expect(write).toHaveBeenCalledWith('default log\n')
    } finally {
      write.mockRestore()
    }
  })

  it('returns a startup error and still cleans up', async () => {
    const child = fakeChild()
    const base = options(child)
    const promise = smokePackaged(base)
    child.emit('error', new Error('spawn ENOENT'))
    await expect(promise).resolves.toEqual(['cannot start packaged application: spawn ENOENT'])
    expect(base.cleanup).toHaveBeenCalledOnce()
  })

  it('kills the application after the timeout', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const base = options(child, { timeoutMs: 100 })
    const promise = smokePackaged(base)
    await vi.advanceTimersByTimeAsync(100)
    expect(child.kill).toHaveBeenCalledOnce()
    await promise
    expect(base.cleanup).toHaveBeenCalledOnce()
  })
})

describe('runCli', () => {
  it('sets exit code 0 and prints success', async () => {
    const print = vi.fn()
    const setExitCode = vi.fn()
    await expect(runCli({ run: async () => [], print, setExitCode })).resolves.toBe(0)
    expect(print).toHaveBeenCalledWith('smoke:packaged: passed')
    expect(setExitCode).toHaveBeenCalledWith(0)
  })

  it('prints every problem and sets exit code 1', async () => {
    const error = vi.fn()
    const setExitCode = vi.fn()
    await expect(
      runCli({
        run: async () => ['first', 'second'],
        error,
        setExitCode,
      }),
    ).resolves.toBe(1)
    expect(error.mock.calls).toEqual([['smoke:packaged: first'], ['smoke:packaged: second']])
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('uses console and process.exitCode by default', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const print = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previous = process.exitCode
    try {
      await expect(runCli({ run: async () => ['bad'] })).resolves.toBe(1)
      expect(error).toHaveBeenCalledWith('smoke:packaged: bad')
      expect(process.exitCode).toBe(1)
      await expect(runCli({ run: async () => [] })).resolves.toBe(0)
      expect(print).toHaveBeenCalledWith('smoke:packaged: passed')
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previous
      error.mockRestore()
      print.mockRestore()
    }
  })
})
