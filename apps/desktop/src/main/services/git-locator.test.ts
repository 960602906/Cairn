import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GitDetection } from '@cairn/checkpoint'
import {
  bundledGitEnv,
  bundledGitLayout,
  createGitLocator,
  gitRuntimeInfo,
  type GitLocatorOptions,
} from './git-locator.js'

const bundledDir = 'C:/app/resources/git'
const bundledBinary = path.join(bundledDir, 'ucrt64/bin/git.exe')

const available = (binary: string, version = '2.56.0'): GitDetection => ({
  available: true,
  binary,
  version,
})

const missing = (binary: string): GitDetection => ({
  available: false,
  binary,
  reason: 'not_found',
})

function locate(options: Partial<GitLocatorOptions> = {}) {
  return createGitLocator({
    bundledDir,
    env: {},
    platform: 'win32',
    exists: (file) =>
      file === bundledBinary || file === path.join(bundledDir, 'ucrt64/libexec/git-core'),
    detect: async (binary) => available(binary),
    ...options,
  }).locate()
}

describe('bundledGitLayout', () => {
  it('prefers the ucrt64 layout and falls back to mingw64', () => {
    const ucrt = bundledGitLayout(
      bundledDir,
      (file) => file === bundledBinary || file === path.join(bundledDir, 'ucrt64/libexec/git-core'),
    )
    expect(ucrt).toEqual({
      binary: bundledBinary,
      execPath: path.join(bundledDir, 'ucrt64/libexec/git-core'),
      templateDir: path.join(bundledDir, 'ucrt64/share/git-core/templates'),
      binDir: path.join(bundledDir, 'ucrt64/bin'),
    })

    const mingwDir = 'C:/app/resources/git-mingw'
    const mingwBinary = path.join(mingwDir, 'mingw64/bin/git.exe')
    const mingwExec = path.join(mingwDir, 'mingw64/libexec/git-core')
    expect(
      bundledGitLayout(mingwDir, (file) => file === mingwBinary || file === mingwExec),
    ).toMatchObject({ binary: mingwBinary })
  })

  it('returns undefined when the entry or exec path is missing', () => {
    expect(bundledGitLayout(bundledDir, () => false)).toBeUndefined()
    expect(bundledGitLayout(bundledDir, (file) => file === bundledBinary)).toBeUndefined()
  })
})

describe('bundledGitEnv', () => {
  it('prepends the bin directory and sets exec/template paths', () => {
    const layout = bundledGitLayout(bundledDir, () => true)!
    expect(bundledGitEnv(layout, { PATH: 'C:/Windows' }, 'win32')).toEqual({
      PATH: `${layout.binDir};C:/Windows`,
      GIT_EXEC_PATH: layout.execPath,
      GIT_TEMPLATE_DIR: layout.templateDir,
    })
    expect(bundledGitEnv(layout, {}, 'win32')['PATH']).toBe(layout.binDir)
    expect(bundledGitEnv(layout, { PATH: '/usr/bin' }, 'linux')['PATH']).toBe(
      `${layout.binDir}:/usr/bin`,
    )
  })
})

describe('createGitLocator', () => {
  it('prefers the system Git', async () => {
    const detect = vi.fn(async (binary: string) => available(binary, '2.40.0'))
    const location = await locate({ detect })
    expect(location).toEqual({
      available: true,
      source: 'system',
      binary: 'git',
      version: '2.40.0',
    })
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('falls back to the bundled MinGit with its controlled environment', async () => {
    const location = await locate({
      detect: async (binary) => (binary === 'git' ? missing(binary) : available(binary)),
    })
    expect(location).toMatchObject({
      available: true,
      source: 'bundled',
      binary: bundledBinary,
      version: '2.56.0',
    })
    expect(location.available && location.env).toEqual({
      PATH: path.join(bundledDir, 'ucrt64/bin'),
      GIT_EXEC_PATH: path.join(bundledDir, 'ucrt64/libexec/git-core'),
      GIT_TEMPLATE_DIR: path.join(bundledDir, 'ucrt64/share/git-core/templates'),
    })
  })

  it('honours the binary override', async () => {
    const location = await locate({
      env: { CAIRN_GIT_BINARY: 'D:/tools/git.exe' },
      detect: async (binary) => available(binary, '2.45.1'),
    })
    expect(location).toEqual({
      available: true,
      source: 'system',
      binary: 'D:/tools/git.exe',
      version: '2.45.1',
    })

    const failed = await locate({
      env: { CAIRN_GIT_BINARY: 'D:/tools/git.exe' },
      detect: async (binary) => missing(binary),
    })
    expect(failed).toEqual({
      available: false,
      source: 'unavailable',
      reason: 'not_found',
    })
  })

  it('can disable the bundled fallback', async () => {
    const location = await locate({
      env: { CAIRN_GIT_DISABLE_BUNDLED: '1' },
      detect: async (binary) => missing(binary),
    })
    expect(location).toEqual({
      available: false,
      source: 'unavailable',
      reason: 'not_found',
    })
  })

  it('reports the bundled failure when it exists but is unusable', async () => {
    const location = await locate({
      detect: async (binary) =>
        binary === 'git'
          ? missing(binary)
          : { available: false, binary, reason: 'too_old', version: '2.20.0' },
    })
    expect(location).toEqual({
      available: false,
      source: 'unavailable',
      reason: 'too_old',
      version: '2.20.0',
    })
  })

  it('skips a missing bundled directory', async () => {
    const location = await locate({
      exists: () => false,
      detect: async (binary) => missing(binary),
    })
    expect(location).toMatchObject({ available: false, source: 'unavailable' })
  })

  it('detects once and caches the result', async () => {
    const detect = vi.fn(async (binary: string) => available(binary))
    const locator = createGitLocator({
      bundledDir,
      env: {},
      detect,
      exists: () => true,
    })
    expect(locator.cached()).toBeUndefined()
    const [first, second] = await Promise.all([locator.locate(), locator.locate()])
    expect(first).toBe(second)
    expect(locator.cached()).toBe(first)
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('retries after an unexpected detection failure', async () => {
    let calls = 0
    const locator = createGitLocator({
      bundledDir,
      env: {},
      exists: () => true,
      detect: async (binary) => {
        calls++
        if (calls === 1) throw new Error('transient')
        return available(binary)
      },
    })
    await expect(locator.locate()).rejects.toThrow('transient')
    await expect(locator.locate()).resolves.toMatchObject({ available: true })
  })
})

describe('gitRuntimeInfo', () => {
  it('omits paths and keeps the failure reason', () => {
    expect(
      gitRuntimeInfo({
        available: true,
        source: 'bundled',
        binary: 'C:/app/resources/git/ucrt64/bin/git.exe',
        version: '2.56.0',
      }),
    ).toEqual({ source: 'bundled', version: '2.56.0' })
    expect(
      gitRuntimeInfo({ available: false, source: 'unavailable', reason: 'not_found' }),
    ).toEqual({ source: 'unavailable', reason: 'not_found' })
    expect(
      gitRuntimeInfo({
        available: false,
        source: 'unavailable',
        reason: 'too_old',
        version: '2.20.0',
      }),
    ).toEqual({ source: 'unavailable', reason: 'too_old', version: '2.20.0' })
  })
})
