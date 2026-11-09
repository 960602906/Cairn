import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applicationEnvironment,
  checkPackagedResult,
  DEFAULT_OUTPUT_DIR,
  packagedApp,
  packagedArguments,
  parseSmokeResult,
  SMOKE_RESULT_PREFIX,
  smokeEnvironment,
  temporaryUserData,
} from './packaged-app.mjs'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-packaged-app-test-'))
  directories.push(directory)
  return directory
}

function result(overrides: Record<string, unknown> = {}): string {
  return `${SMOKE_RESULT_PREFIX}${JSON.stringify({
    ok: true,
    turnCompleted: true,
    search: 'ripgrep 15.0.0',
    skills: ['example'],
    native: 'job-object',
    ...overrides,
  })}\n`
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('packagedArguments', () => {
  it('adds headless Chromium flags only on Linux', () => {
    expect(packagedArguments('linux')).toEqual([
      '--ozone-platform=headless',
      '--disable-gpu',
      '--no-sandbox',
    ])
    expect(packagedArguments('win32')).toEqual([])
    expect(packagedArguments('darwin')).toEqual([])
  })
})

describe('applicationEnvironment', () => {
  it('isolates user data and removes Node/debug overrides', () => {
    const environment = applicationEnvironment({
      userData: 'C:/temp/cairn',
      base: {
        PATH: '/bin',
        CAIRN_SMOKE: '1',
        ELECTRON_RUN_AS_NODE: '1',
        CAIRN_USER_DATA_DIR: 'C:/real',
      },
      extra: { CAIRN_RUNTIME: 'fake', CAIRN_USER_DATA_DIR: 'C:/override' },
    })
    expect(environment).toEqual({
      PATH: '/bin',
      CAIRN_RUNTIME: 'fake',
      CAIRN_USER_DATA_DIR: 'C:/temp/cairn',
    })
  })

  it('does not mutate the base environment', () => {
    const base = { CAIRN_SMOKE: '1', PATH: '/bin' }
    applicationEnvironment({ userData: '/tmp/data', base, extra: { EXTRA: 'yes' } })
    expect(base).toEqual({ CAIRN_SMOKE: '1', PATH: '/bin' })
  })
})

describe('smokeEnvironment', () => {
  it('enables smoke mode with the fake runtime', () => {
    expect(
      smokeEnvironment({
        userData: '/tmp/data',
        base: { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' },
      }),
    ).toEqual({
      PATH: '/bin',
      CAIRN_USER_DATA_DIR: '/tmp/data',
      CAIRN_SMOKE: '1',
      CAIRN_RUNTIME: 'fake',
    })
  })
})

describe('parseSmokeResult', () => {
  it('parses the first valid result line', () => {
    expect(parseSmokeResult(`noise\n${result()}\nmore`)).toEqual({
      ok: true,
      turnCompleted: true,
      search: 'ripgrep 15.0.0',
      skills: ['example'],
      native: 'job-object',
    })
  })

  it('rejects missing, malformed and non-object results', () => {
    expect(parseSmokeResult('no result')).toBeUndefined()
    expect(parseSmokeResult(`${SMOKE_RESULT_PREFIX}{`)).toBeUndefined()
    expect(parseSmokeResult(`${SMOKE_RESULT_PREFIX}[]`)).toBeUndefined()
    expect(parseSmokeResult(`${SMOKE_RESULT_PREFIX}null`)).toBeUndefined()
    expect(parseSmokeResult(`${SMOKE_RESULT_PREFIX}"value"`)).toBeUndefined()
  })
})

describe('checkPackagedResult', () => {
  const userData = 'C:/temp/cairn'
  const exists = () => true

  it('accepts a complete Windows smoke result', () => {
    expect(
      checkPackagedResult({
        output: result(),
        exitCode: 0,
        signal: null,
        userData,
        exists,
        platform: 'win32',
      }),
    ).toEqual([])
  })

  it('does not require the Windows Job Object on other platforms', () => {
    expect(
      checkPackagedResult({
        output: result({ native: 'unsupported' }),
        exitCode: 0,
        signal: null,
        userData,
        exists,
        platform: 'linux',
      }),
    ).toEqual([])
  })

  it('reports every missing smoke assertion and data directory', () => {
    const problems = checkPackagedResult({
      output: result({
        ok: false,
        error: 'renderer failed',
        turnCompleted: false,
        search: null,
        skills: 'example',
        native: null,
      }),
      exitCode: 1,
      signal: 'SIGTERM',
      userData,
      exists: () => false,
      platform: 'win32',
    })
    expect(problems).toEqual([
      'smoke checks failed: renderer failed',
      'agent host did not complete a turn',
      'bundled ripgrep was not exercised',
      'built-in skill example was not loaded',
      'koffi Job Object was not loaded: null',
      'application exited with 1 (SIGTERM)',
      'missing data/cairn.db',
      'missing data/blobs',
      'missing checkpoints',
      'missing logs',
    ])
  })

  it('reports an absent or malformed result line', () => {
    expect(
      checkPackagedResult({
        output: 'nothing',
        exitCode: 0,
        signal: null,
        userData,
        exists,
        platform: 'linux',
      }),
    ).toContain('no valid smoke result was printed')
  })

  it('rejects a skills value that is not a list containing example', () => {
    expect(
      checkPackagedResult({
        output: result({ skills: ['other'] }),
        exitCode: 0,
        signal: null,
        userData,
        exists,
        platform: 'linux',
      }),
    ).toEqual(['built-in skill example was not loaded'])
  })
})

describe('temporaryUserData', () => {
  it('creates and removes an isolated data directory', () => {
    const userData = temporaryUserData()
    const directory = userData.path
    expect(existsSync(directory)).toBe(true)
    userData.cleanup()
    expect(existsSync(directory)).toBe(false)
  })
})

describe('packagedApp', () => {
  it('finds the unpacked executable below the requested output directory', () => {
    const output = temporaryDirectory()
    const executable = path.join(output, 'win-unpacked/Cairn.exe')
    mkdirSync(path.dirname(executable), { recursive: true })
    writeFileSync(executable, '')
    expect(packagedApp({ outputDir: output, platform: 'win32' })).toEqual({
      directory: path.join(output, 'win-unpacked'),
      executable,
    })
  })

  it('uses the default output directory and an injectable lookup', () => {
    const lookup = vi.fn(() => ({ directory: 'dist/win-unpacked', executable: 'Cairn.exe' }))
    expect(packagedApp({ lookup })).toEqual({
      directory: 'dist/win-unpacked',
      executable: 'Cairn.exe',
    })
    expect(lookup).toHaveBeenCalledWith({ outputDir: DEFAULT_OUTPUT_DIR })
  })
})
