import type { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  macSignatureSummary,
  macSignatureTargets,
  macSigningBuilderArgs,
  macSigningEnvironment,
  macSigningMain,
  readMacSigningConfig,
  verifyMacSignature,
} from './mac-signing.mjs'

const CERTIFICATE_VALUE = 'fixture-cert-value'
const APPLE_VALUE = 'fixture-apple-value'
const CSC_VALUE = 'fixture-csc-value'

const DEVELOPER_ID_ENV = {
  CAIRN_MAC_SIGN_MODE: 'developer-id',
  CAIRN_MAC_IDENTITY: 'Developer ID Application: Cairn (TEAM123456)',
  MAC_CERTIFICATE: 'fixture-certificate',
  MAC_CERTIFICATE_PASSWORD: CERTIFICATE_VALUE,
  APPLE_ID: 'release@cairn.dev',
  APPLE_APP_SPECIFIC_PASSWORD: APPLE_VALUE,
  APPLE_TEAM_ID: 'TEAM123456',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

function runnerFor(results: Readonly<Record<string, { status: number; output?: string }>>) {
  return vi.fn((command: string) => {
    const result = results[command] ?? { status: 0 }
    return { status: result.status, stdout: result.output ?? '', stderr: '' }
  }) as unknown as typeof spawnSync
}

describe('readMacSigningConfig', () => {
  it('defaults to unsigned local builds', () => {
    expect(readMacSigningConfig({})).toEqual({ mode: 'none' })
    vi.stubEnv('CAIRN_MAC_SIGN_MODE', 'none')
    expect(readMacSigningConfig()).toEqual({ mode: 'none' })
    expect(readMacSigningConfig({ CAIRN_MAC_SIGN_MODE: ' NONE ' })).toEqual({ mode: 'none' })
  })

  it('rejects unknown modes', () => {
    expect(() => readMacSigningConfig({ CAIRN_MAC_SIGN_MODE: 'adhoc' })).toThrow(
      'CAIRN_MAC_SIGN_MODE must be one of none, developer-id',
    )
  })

  it('requires a Developer ID identity and certificate', () => {
    expect(() => readMacSigningConfig({ CAIRN_MAC_SIGN_MODE: 'developer-id' })).toThrow(
      'CAIRN_MAC_IDENTITY is required',
    )
    expect(() =>
      readMacSigningConfig({
        ...DEVELOPER_ID_ENV,
        CAIRN_MAC_IDENTITY: 'Apple Development: Someone',
      }),
    ).toThrow('CAIRN_MAC_IDENTITY must be a Developer ID Application identity')
    expect(() =>
      readMacSigningConfig({
        ...DEVELOPER_ID_ENV,
        MAC_CERTIFICATE: '',
        CSC_LINK: '',
      }),
    ).toThrow('MAC_CERTIFICATE (base64 p12) is required')
  })

  it('accepts the electron-builder variable names', () => {
    const config = readMacSigningConfig({
      ...DEVELOPER_ID_ENV,
      MAC_CERTIFICATE: undefined,
      MAC_CERTIFICATE_PASSWORD: undefined,
      CSC_LINK: 'fixture-csc-certificate',
      CSC_KEY_PASSWORD: CSC_VALUE,
    })
    expect(config).toMatchObject({ mode: 'developer-id', certificate: 'fixture-csc-certificate' })
    expect(config.mode === 'developer-id' && config.password).toBe(CSC_VALUE)
  })

  it('requires notarization credentials for a signed build', () => {
    expect(() =>
      readMacSigningConfig({
        ...DEVELOPER_ID_ENV,
        MAC_CERTIFICATE_PASSWORD: '',
        CSC_KEY_PASSWORD: '',
      }),
    ).toThrow('MAC_CERTIFICATE_PASSWORD is required')
    expect(() => readMacSigningConfig({ ...DEVELOPER_ID_ENV, APPLE_ID: ' ' })).toThrow(
      'APPLE_ID is required',
    )
    expect(() =>
      readMacSigningConfig({ ...DEVELOPER_ID_ENV, APPLE_APP_SPECIFIC_PASSWORD: '' }),
    ).toThrow('APPLE_APP_SPECIFIC_PASSWORD is required')
    expect(() => readMacSigningConfig({ ...DEVELOPER_ID_ENV, APPLE_TEAM_ID: '' })).toThrow(
      'APPLE_TEAM_ID is required',
    )
  })

  it('parses a complete Developer ID configuration', () => {
    expect(readMacSigningConfig(DEVELOPER_ID_ENV)).toEqual({
      mode: 'developer-id',
      identity: 'Developer ID Application: Cairn (TEAM123456)',
      certificate: 'fixture-certificate',
      password: CERTIFICATE_VALUE,
      notarize: {
        appleId: 'release@cairn.dev',
        appleIdPassword: APPLE_VALUE,
        teamId: 'TEAM123456',
      },
    })
  })
})

describe('macSigningEnvironment', () => {
  it('always disables identity auto-discovery', () => {
    const env = macSigningEnvironment({ mode: 'none' }, { PATH: '/usr/bin' })
    expect(env).toEqual({ PATH: '/usr/bin', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  })

  it('extends process.env by default', () => {
    vi.stubEnv('CAIRN_TEST_MARKER', '1')
    expect(macSigningEnvironment({ mode: 'none' })).toMatchObject({
      CAIRN_TEST_MARKER: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
  })

  it('passes certificate and notarization secrets only through the environment', () => {
    const env = macSigningEnvironment(readMacSigningConfig(DEVELOPER_ID_ENV), {})
    expect(env).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: 'fixture-certificate',
      CSC_KEY_PASSWORD: CERTIFICATE_VALUE,
      APPLE_ID: 'release@cairn.dev',
      APPLE_APP_SPECIFIC_PASSWORD: APPLE_VALUE,
      APPLE_TEAM_ID: 'TEAM123456',
    })
  })
})

describe('macSigningBuilderArgs', () => {
  it('keeps unsigned builds on electron-builder defaults', () => {
    expect(macSigningBuilderArgs({ mode: 'none' })).toEqual([])
  })

  it('selects the explicit identity and enables notarization', () => {
    expect(macSigningBuilderArgs(readMacSigningConfig(DEVELOPER_ID_ENV))).toEqual([
      '--config.mac.identity=Developer ID Application: Cairn (TEAM123456)',
      '--config.mac.notarize=true',
    ])
  })
})

describe('macSignatureSummary', () => {
  it('never includes secrets', () => {
    expect(macSignatureSummary({ mode: 'none' })).toEqual({ mode: 'none' })
    expect(macSignatureSummary(readMacSigningConfig(DEVELOPER_ID_ENV))).toEqual({
      mode: 'developer-id',
      identity: 'Developer ID Application: Cairn (TEAM123456)',
      notarized: true,
    })
  })
})

describe('macSignatureTargets', () => {
  it('lists both apps and both installer/update formats', () => {
    const targets = macSignatureTargets({ distDir: '/dist', version: '0.1.0' })
    expect(targets.map((target) => target.label)).toEqual([
      'arm64 application',
      'arm64 DMG',
      'arm64 ZIP',
      'x64 application',
      'x64 DMG',
      'x64 ZIP',
    ])
    expect(targets.map((target) => target.required)).toEqual([
      path.join('/dist/mac-arm64/Cairn.app'),
      path.join('/dist/Cairn-0.1.0-arm64.dmg'),
      path.join('/dist/Cairn-0.1.0-arm64.zip'),
      path.join('/dist/mac/Cairn.app'),
      path.join('/dist/Cairn-0.1.0-x64.dmg'),
      path.join('/dist/Cairn-0.1.0-x64.zip'),
    ])
  })
})

describe('verifyMacSignature', () => {
  const app = {
    label: 'arm64 application',
    required: '/dist/mac-arm64/Cairn.app',
    app: '/dist/mac-arm64/Cairn.app',
  }
  const dmg = { label: 'arm64 DMG', required: '/dist/Cairn-0.1.0-arm64.dmg' }

  it('only runs on macOS', () => {
    expect(
      verifyMacSignature({ target: app, notarized: true, platform: 'win32', exists: () => true }),
    ).toEqual(['macOS signature verification is supported on macOS only'])
  })

  it('reports missing artifacts before invoking system tools', () => {
    const runner = vi.fn() as unknown as typeof spawnSync
    expect(
      verifyMacSignature({
        target: dmg,
        notarized: true,
        runner,
        platform: 'darwin',
        exists: () => false,
      }),
    ).toEqual(['missing signed artifact: /dist/Cairn-0.1.0-arm64.dmg'])
    expect(runner).not.toHaveBeenCalled()
  })

  it('checks codesign and Gatekeeper for applications', () => {
    const runner = runnerFor({ codesign: { status: 0 }, spctl: { status: 0 } })
    expect(
      verifyMacSignature({
        target: app,
        notarized: true,
        runner,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual([])
    expect(runner).toHaveBeenCalledWith(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', app.app],
      expect.objectContaining({ timeout: 120_000 }),
    )
    expect(runner).toHaveBeenCalledWith(
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=4', app.app],
      expect.objectContaining({ timeout: 120_000 }),
    )

    expect(
      verifyMacSignature({
        target: app,
        notarized: true,
        runner: runnerFor({ codesign: { status: 1, output: 'code object is not signed' } }),
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual(['codesign verify failed for arm64 application: code object is not signed'])
    expect(
      verifyMacSignature({
        target: app,
        notarized: true,
        runner: runnerFor({ spctl: { status: 3, output: 'rejected' } }),
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual(['Gatekeeper assessment failed for arm64 application: rejected'])

    // 系统工具只给出退出码、没有输出时，错误信息仍然可读。
    const bare = vi.fn(() => ({ status: 1 })) as unknown as typeof spawnSync
    expect(
      verifyMacSignature({
        target: app,
        notarized: true,
        runner: bare,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual([
      'codesign verify failed for arm64 application: ',
      'Gatekeeper assessment failed for arm64 application: ',
    ])
    expect(
      verifyMacSignature({
        target: dmg,
        notarized: true,
        runner: bare,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual(['notarization ticket is missing from arm64 DMG: '])
  })

  it('only validates notarization tickets for installers', () => {
    const runner = runnerFor({})
    expect(
      verifyMacSignature({
        target: dmg,
        notarized: false,
        runner,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual([])
    expect(runner).not.toHaveBeenCalled()

    expect(
      verifyMacSignature({
        target: dmg,
        notarized: true,
        runner,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual([])
    expect(runner).toHaveBeenCalledWith(
      'xcrun',
      ['stapler', 'validate', dmg.required],
      expect.objectContaining({ timeout: 120_000 }),
    )

    expect(
      verifyMacSignature({
        target: dmg,
        notarized: true,
        runner: runnerFor({ xcrun: { status: 65, output: 'no ticket' } }),
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual(['notarization ticket is missing from arm64 DMG: no ticket'])

    // ZIP 无法 stapling：票据在包内的应用上，不能要求 zip 自己带票据。
    const zipRunner = runnerFor({ xcrun: { status: 65, output: 'no ticket' } })
    expect(
      verifyMacSignature({
        target: { label: 'arm64 ZIP', required: '/dist/Cairn-0.1.0-arm64.zip' },
        notarized: true,
        runner: zipRunner,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual([])
    expect(zipRunner).not.toHaveBeenCalled()
  })
})

describe('macSigningMain', () => {
  const exists = () => true
  const runner = runnerFor({})

  it('requires a dist directory and version', () => {
    const error = vi.fn()
    expect(macSigningMain({ argv: [], error })).toBe(1)
    expect(macSigningMain({ argv: ['--dist', '/dist'], error })).toBe(1)
    expect(macSigningMain({ argv: ['--version', '0.1.0'], error })).toBe(1)
    expect(error).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledWith('usage: mac-signing.mjs --dist <dir> --version <version>')
  })

  it('uses console output and the process environment by default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(macSigningMain({ argv: [] })).toBe(1)
      expect(error).toHaveBeenCalledWith('usage: mac-signing.mjs --dist <dir> --version <version>')
    } finally {
      error.mockRestore()
    }
  })

  it('refuses to verify an unsigned build', () => {
    const error = vi.fn()
    expect(
      macSigningMain({
        argv: ['--dist', '/dist', '--version', '0.1.0'],
        env: {},
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith('mac-signing: refusing to verify an unsigned build')
  })

  it('reports every signature problem', () => {
    const error = vi.fn()
    expect(
      macSigningMain({
        argv: ['--dist', '/dist', '--version', '0.1.0'],
        env: DEVELOPER_ID_ENV,
        platform: 'win32',
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledTimes(6)
    expect(error).toHaveBeenCalledWith(
      'sign: macOS signature verification is supported on macOS only',
    )
  })

  it('verifies all six artifacts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(
        macSigningMain({
          argv: ['--dist', '/dist', '--version', '0.1.0'],
          env: DEVELOPER_ID_ENV,
          platform: 'darwin',
          runner,
          exists,
        }),
      ).toBe(0)
      expect(log).toHaveBeenCalledWith('sign: 6 macOS artifacts verified')
    } finally {
      log.mockRestore()
    }
  })
})
