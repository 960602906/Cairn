import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseBuildInfo, readAppInfo, resolveChannel } from './build-info.js'

const runtime = {
  version: '0.1.0',
  electronVersion: '45.2.1',
  nodeVersion: '24.11.0',
  databaseSchemaVersion: 17,
  packaged: false,
} as const

function buildFile(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    version: '0.1.0',
    channel: 'beta',
    commit: 'abcdef1234567890',
    buildTime: '2026-11-10T08:30:00.000Z',
    electronVersion: '45.0.0',
    nodeVersion: '24.10.0',
    ...patch,
  })
}

describe('build channel resolution', () => {
  it('prefers an explicit channel and defaults by major version', () => {
    expect(resolveChannel('stable', '0.1.0')).toBe('stable')
    expect(resolveChannel('beta', '1.0.0')).toBe('beta')
    expect(resolveChannel('nightly', '0.1.0')).toBe('beta')
    expect(resolveChannel(undefined, '1.0.0')).toBe('stable')
    expect(resolveChannel(undefined, '0.9.0')).toBe('beta')
  })
})

describe('build info parsing', () => {
  it('parses a valid build file and overrides the channel from the environment', () => {
    expect(parseBuildInfo(buildFile())).toMatchObject({
      version: '0.1.0',
      channel: 'beta',
      commit: 'abcdef1234567890',
    })
    const info = readAppInfo({
      file: 'build-info.json',
      runtime,
      env: { CAIRN_CHANNEL: 'stable' },
      readFile: () => buildFile(),
    })
    expect(info).toMatchObject({
      version: '0.1.0',
      channel: 'stable',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-10T08:30:00.000Z',
      electronVersion: '45.2.1',
      nodeVersion: '24.11.0',
      databaseSchemaVersion: 17,
      packaged: false,
      appId: 'com.cairn.desktop',
      name: 'Cairn',
    })
  })

  it('uses build tool versions when the runtime cannot provide them', () => {
    const info = readAppInfo({
      file: 'build-info.json',
      runtime: { ...runtime, electronVersion: '', nodeVersion: '' },
      readFile: () => buildFile(),
    })
    expect(info.electronVersion).toBe('45.0.0')
    expect(info.nodeVersion).toBe('24.10.0')
  })

  it('reads the file with the default reader and no error callback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-app-info-'))
    const file = join(dir, 'build-info.json')
    try {
      writeFileSync(file, buildFile())
      const info = readAppInfo({ file, runtime })
      expect(info).toMatchObject({
        version: '0.1.0',
        channel: 'beta',
        commit: 'abcdef1234567890',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('silently falls back when the file has not been built yet', () => {
    const onError = vi.fn()
    const info = readAppInfo({
      file: 'build-info.json',
      runtime,
      readFile: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      onError,
    })
    expect(onError).not.toHaveBeenCalled()
    expect(info).toMatchObject({
      version: '0.1.0',
      channel: 'beta',
      commit: 'unknown',
      buildTime: '',
      databaseSchemaVersion: 17,
    })
  })

  it('falls back without leaking user paths when JSON or fields are invalid', () => {
    for (const text of [
      '{not json',
      buildFile({ commit: 'C:\\\\Users\\\\alice\\\\repo' }),
      buildFile({ buildTime: 'yesterday' }),
      buildFile({ electronVersion: 'C:\\\\Users\\\\alice\\\\electron.exe' }),
      JSON.stringify({ schemaVersion: 2 }),
    ]) {
      const onError = vi.fn()
      const info = readAppInfo({
        file: 'build-info.json',
        runtime,
        readFile: () => text,
        onError,
      })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(info.commit).toBe('unknown')
      expect(info.buildTime).toBe('')
      expect(JSON.stringify(info)).not.toContain('alice')
    }
  })

  it('falls back from malformed JSON without an error callback', () => {
    const info = readAppInfo({
      file: 'build-info.json',
      runtime,
      readFile: () => '{not json',
    })
    expect(info.commit).toBe('unknown')
    expect(info.buildTime).toBe('')
  })

  it('reports non-ENOENT read failures but still returns runtime information', () => {
    const onError = vi.fn()
    const info = readAppInfo({
      file: 'build-info.json',
      runtime,
      readFile: () => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      },
      onError,
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(info.version).toBe('0.1.0')
  })

  it('derives the channel from the runtime version when no file exists', () => {
    const info = readAppInfo({
      file: 'build-info.json',
      runtime: { ...runtime, version: '1.0.0' },
      readFile: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    })
    expect(info.channel).toBe('stable')
  })

  it('keeps the channel baked into the build when the environment does not override it', () => {
    const info = readAppInfo({
      file: 'build-info.json',
      runtime: { ...runtime, version: '1.0.0' },
      readFile: () => buildFile({ version: '1.0.0', channel: 'beta' }),
    })
    expect(info.channel).toBe('beta')
  })

  it('exposes the update configuration baked into the build', () => {
    const info = readAppInfo({
      file: 'build-info.json',
      runtime,
      readFile: () =>
        buildFile({
          update: { source: 'https://updates.example/cairn/', publisher: 'CN=Cairn, O=Cairn' },
        }),
    })
    expect(info.update).toEqual({
      source: 'https://updates.example/cairn/',
      publisher: 'CN=Cairn, O=Cairn',
    })
  })

  it('drops an invalid update configuration without leaking it', () => {
    for (const update of [
      { source: 'http://updates.example/cairn/' },
      { source: 'https://updates.example/cairn/', publisher: '' },
      { source: 'https://user:{{PASSWORD_lq5r7c7o}}@updates.example/cairn/' },
    ]) {
      const onError = vi.fn()
      const info = readAppInfo({
        file: 'build-info.json',
        runtime,
        readFile: () => buildFile({ update }),
        onError,
      })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(info.update).toBeUndefined()
    }
  })
})
