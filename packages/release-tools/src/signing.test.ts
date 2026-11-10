import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findSignTool,
  main,
  parseAuthenticode,
  readSigningConfig,
  redactSecrets,
  signatureSummary,
  signingBuilderArgs,
  signingEnvironment,
  validatePublisher,
  verifyAuthenticode,
  verifyReleaseSignatures,
} from './signing.mjs'

const dirs: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-signing-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PFX_ENV = {
  CAIRN_SIGN_MODE: 'pfx',
  CAIRN_UPDATE_PUBLISHER: 'CN=Cairn, O=Cairn, C=US',
  WINDOWS_CERTIFICATE: 'base64-pfx',
  WINDOWS_CERTIFICATE_PASSWORD: 'certificate-passphrase',
}

const AZURE_ENV = {
  CAIRN_SIGN_MODE: 'azure',
  CAIRN_UPDATE_PUBLISHER: 'CN=Cairn, O=Cairn, C=US',
  AZURE_SIGN_ENDPOINT: 'https://eus.codesigning.azure.net',
  AZURE_SIGN_ACCOUNT: 'cairn-signing',
  AZURE_SIGN_PROFILE: 'cairn-release',
}

function successfulRunner(_command: string, args: readonly string[]) {
  if (args.includes('verify')) {
    return { status: 0, stdout: 'Successfully verified: file\n', stderr: '' }
  }
  return {
    status: 0,
    stdout: JSON.stringify({
      status: 'Valid',
      subject: 'CN=Cairn, O=Cairn, C=US',
      thumbprint: 'ABC',
      timestamped: true,
    }),
    stderr: '',
  }
}

describe('signing configuration', () => {
  it('defaults to no signing', () => {
    expect(readSigningConfig({})).toEqual({ mode: 'none' })
    expect(signingBuilderArgs({ mode: 'none' })).toEqual([])
    expect(signatureSummary({ mode: 'none' })).toEqual({ mode: 'none' })
    expect(signingEnvironment({ mode: 'none' }, { PATH: 'x' })).toMatchObject({
      PATH: 'x',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
  })

  it('reads a PFX certificate and password from environment variables', () => {
    const config = readSigningConfig(PFX_ENV) as Extract<
      ReturnType<typeof readSigningConfig>,
      { mode: 'pfx' }
    >
    expect(config).toMatchObject({
      mode: 'pfx',
      publisher: 'CN=Cairn, O=Cairn, C=US',
      timestampUrl: 'https://timestamp.digicert.com',
      certificate: 'base64-pfx',
    })
    const env = signingEnvironment(config, { PATH: 'x' })
    expect(env['WIN_CSC_LINK']).toBe('base64-pfx')
    expect(env['WIN_CSC_KEY_PASSWORD']).toBe(config.password)
    expect(signingEnvironment(config, { PATH: 'x' })['PATH']).toBe('x')
    expect(signatureSummary(config)).toEqual({
      mode: 'pfx',
      publisher: 'CN=Cairn, O=Cairn, C=US',
      timestampUrl: 'https://timestamp.digicert.com',
    })
  })

  it('reads Azure Trusted Signing settings', () => {
    const config = readSigningConfig(AZURE_ENV) as Extract<
      ReturnType<typeof readSigningConfig>,
      { mode: 'azure' }
    >
    expect(config).toMatchObject({
      mode: 'azure',
      endpoint: 'https://eus.codesigning.azure.net',
      account: 'cairn-signing',
      profile: 'cairn-release',
    })
    expect(signingBuilderArgs(config)).toEqual([
      '--config.win.signExecutable=true',
      '--config.win.azureSignOptions.publisherName=CN=Cairn, O=Cairn, C=US',
      '--config.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net',
      '--config.win.azureSignOptions.codeSigningAccountName=cairn-signing',
      '--config.win.azureSignOptions.certificateProfileName=cairn-release',
      '--config.win.azureSignOptions.timestampRfc3161=https://timestamp.digicert.com',
      '--config.win.azureSignOptions.fileDigest=SHA256',
    ])
  })

  it('builds PFX signing arguments with SHA-256 and RFC 3161', () => {
    const config = readSigningConfig({ ...PFX_ENV, CAIRN_TIMESTAMP_URL: 'https://ts.example///' })
    expect(signingBuilderArgs(config)).toEqual([
      '--config.win.signExecutable=true',
      '--config.win.signtoolOptions.publisherName=CN=Cairn, O=Cairn, C=US',
      '--config.win.signtoolOptions.signingHashAlgorithms=sha256',
      '--config.win.signtoolOptions.rfc3161TimeStampServer=https://ts.example',
    ])
  })

  it('fails closed on missing or unsafe configuration', () => {
    expect(() => readSigningConfig({ CAIRN_SIGN_MODE: 'invalid' })).toThrow(/CAIRN_SIGN_MODE/)
    expect(() => readSigningConfig({ CAIRN_SIGN_MODE: 'pfx' })).toThrow(/publisher/)
    expect(() => readSigningConfig({ ...PFX_ENV, WINDOWS_CERTIFICATE: '' })).toThrow(
      /WINDOWS_CERTIFICATE/,
    )
    expect(() => readSigningConfig({ ...PFX_ENV, WINDOWS_CERTIFICATE_PASSWORD: '' })).toThrow(
      /WINDOWS_CERTIFICATE_PASSWORD/,
    )
    expect(() =>
      readSigningConfig({ ...PFX_ENV, CAIRN_TIMESTAMP_URL: 'http://ts.example' }),
    ).toThrow(/https/)
    expect(() => readSigningConfig({ ...AZURE_ENV, AZURE_SIGN_PROFILE: '' })).toThrow(
      /AZURE_SIGN_PROFILE/,
    )
    expect(() => validatePublisher('Cairn')).toThrow(/full certificate subject DN/)
    expect(() => validatePublisher('x'.repeat(513))).toThrow(/512/)
    expect(() => validatePublisher('CN=Cairn\nCN=Other')).toThrow(/single line/)
  })
})

describe('secret handling', () => {
  it('redacts certificate material from output', () => {
    const config = readSigningConfig(PFX_ENV) as Extract<
      ReturnType<typeof readSigningConfig>,
      { mode: 'pfx' }
    >
    const text = redactSecrets('cert=' + config.certificate + ' pass=' + config.password, config)
    expect(text).toBe('cert=*** pass=***')
    expect(
      redactSecrets('no secrets', readSigningConfig({ ...PFX_ENV, WINDOWS_CERTIFICATE: 'abc' })),
    ).toBe('no secrets')
  })
})

describe('signtool discovery', () => {
  it('prefers an explicit path and otherwise picks the newest SDK', () => {
    expect(
      findSignTool({
        platform: 'win32',
        env: { SIGNTOOL_PATH: 'C:/tools/signtool.exe' },
        exists: () => true,
      }),
    ).toBe('C:/tools/signtool.exe')

    const root = temporaryDirectory()
    const bin = path.join(root, 'Windows Kits/10/bin')
    for (const version of ['10.0.22621.0', '10.0.26100.0']) {
      mkdirSync(path.join(bin, version, 'x64'), { recursive: true })
      writeFileSync(path.join(bin, version, 'x64/signtool.exe'), version)
    }
    mkdirSync(path.join(bin, 'not-a-version/x64'), { recursive: true })
    expect(findSignTool({ platform: 'win32', env: { 'ProgramFiles(x86)': root } })).toBe(
      path.join(bin, '10.0.26100.0/x64/signtool.exe'),
    )
    expect(findSignTool({ platform: 'win32', env: {}, exists: () => false })).toBe('signtool')
    expect(() => findSignTool({ platform: 'linux' })).toThrow(/Windows only/)
  })
})

describe('Authenticode verification', () => {
  it('parses PowerShell JSON output', () => {
    expect(
      parseAuthenticode(
        'warning\n{"status":"Valid","subject":"CN=Cairn","thumbprint":"A","timestamped":true}\n',
      ),
    ).toEqual({ status: 'Valid', subject: 'CN=Cairn', thumbprint: 'A', timestamped: true })
    expect(parseAuthenticode('not json')).toBeUndefined()
    expect(parseAuthenticode('{"status":"Valid"}')).toBeUndefined()
    expect(parseAuthenticode('{broken')).toBeUndefined()
  })

  it('accepts a valid, timestamped signature from the configured publisher', () => {
    const file = path.join(temporaryDirectory(), 'Cairn.exe')
    writeFileSync(file, 'binary')
    expect(
      verifyAuthenticode({
        file,
        config: readSigningConfig(PFX_ENV),
        signTool: 'signtool',
        runner: successfulRunner as never,
        platform: 'win32',
      }),
    ).toEqual([])
  })

  it('reports every integrity problem', () => {
    const file = path.join(temporaryDirectory(), 'Cairn.exe')
    writeFileSync(file, 'binary')
    const runner = ((command: string, args: readonly string[]) =>
      args.includes('verify')
        ? { status: 1, stdout: '', stderr: 'signature invalid' }
        : {
            status: 0,
            stdout: JSON.stringify({
              status: 'HashMismatch',
              subject: 'CN=Other',
              thumbprint: 'B',
              timestamped: false,
            }),
            stderr: '',
          }) as never
    const problems = verifyAuthenticode({
      file,
      config: readSigningConfig(PFX_ENV),
      signTool: 'signtool',
      runner,
      platform: 'win32',
    })
    expect(problems).toEqual([
      expect.stringContaining('signtool verify failed'),
      expect.stringContaining('signature status is HashMismatch'),
      expect.stringContaining('publisher is "CN=Other"'),
      expect.stringContaining('no RFC 3161 timestamp'),
    ])
  })

  it('fails closed when the PowerShell query cannot be parsed', () => {
    const file = path.join(temporaryDirectory(), 'Cairn.exe')
    writeFileSync(file, 'binary')
    const problems = verifyAuthenticode({
      file,
      config: readSigningConfig(PFX_ENV),
      signTool: 'signtool',
      runner: ((_command: string, args: readonly string[]) =>
        args.includes('verify')
          ? { status: 0, stdout: 'Successfully verified', stderr: '' }
          : { status: 0, stdout: 'garbage', stderr: '' }) as never,
      platform: 'win32',
    })
    expect(problems).toEqual([expect.stringContaining('cannot read Authenticode status')])
  })

  it('rejects unsigned mode, missing files and non-Windows platforms', () => {
    expect(
      verifyAuthenticode({
        file: 'missing.exe',
        config: { mode: 'none' },
        signTool: 'signtool',
      }),
    ).toEqual(['code signing is disabled'])
    expect(
      verifyAuthenticode({
        file: 'missing.exe',
        config: readSigningConfig(PFX_ENV),
        signTool: 'signtool',
      }),
    ).toEqual([expect.stringContaining('missing signed artifact')])
    expect(
      verifyAuthenticode({
        file: 'x.exe',
        config: readSigningConfig(PFX_ENV),
        signTool: 'signtool',
        platform: 'linux',
        exists: () => true,
      }),
    ).toEqual(['code signing verification is supported on Windows only'])
  })
})

describe('release signature targets', () => {
  it('verifies installer, app and installed uninstaller', () => {
    const root = temporaryDirectory()
    const dist = path.join(root, 'dist')
    const installed = path.join(root, 'installed')
    for (const file of [
      path.join(dist, 'Cairn-0.1.1-x64-setup.exe'),
      path.join(dist, 'win-unpacked/Cairn.exe'),
      path.join(installed, 'Cairn.exe'),
      path.join(installed, 'Uninstall Cairn.exe'),
    ]) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'binary')
    }
    expect(
      verifyReleaseSignatures({
        distDir: dist,
        version: '0.1.1',
        installedDir: installed,
        config: readSigningConfig(PFX_ENV),
        signTool: 'signtool',
        runner: successfulRunner as never,
        platform: 'win32',
      }),
    ).toEqual([])
    expect(
      verifyReleaseSignatures({
        distDir: dist,
        version: '0.1.1',
        config: { mode: 'none' },
      }),
    ).toEqual(['refusing to verify an unsigned release'])
  })
})

describe('CLI', () => {
  it('prints usage and returns failure for incomplete arguments', () => {
    const error = vi.fn()
    expect(main({ argv: [], error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage:'))
    expect(
      main({
        argv: ['--dist', 'dist', '--version', '0.1.1'],
        env: {},
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith('sign: refusing to verify an unsigned release')
  })

  it('reports successful verification', () => {
    const dist = temporaryDirectory()
    mkdirSync(path.join(dist, 'win-unpacked'), { recursive: true })
    for (const file of [
      path.join(dist, 'Cairn-0.1.1-x64-setup.exe'),
      path.join(dist, 'win-unpacked/Cairn.exe'),
    ]) {
      writeFileSync(file, 'binary')
    }
    const log = vi.fn()
    expect(
      main({
        argv: ['--dist', dist, '--version', '0.1.1'],
        env: { ...PFX_ENV, SIGNTOOL_PATH: 'signtool' },
        platform: 'win32',
        runner: successfulRunner as never,
        log,
      }),
    ).toBe(0)
    expect(log).toHaveBeenCalledWith('sign: 2 artifacts verified')
  })
})
