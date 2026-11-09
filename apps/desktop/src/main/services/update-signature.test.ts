import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createAuthenticodeVerifier,
  isFullDistinguishedName,
  parseAuthenticodeOutput,
  parseDistinguishedName,
  type CommandRunner,
} from './update-signature.js'

const FILE = 'C:\\Users\\someone\\AppData\\Local\\Cairn\\Cairn-0.1.1.exe'

function runner(result: { error?: Error | null; stdout?: string; stderr?: string }): CommandRunner {
  return (_command, _args, _options, callback) => callback(result)
}

function validOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'Valid',
    subject: 'CN=Cairn contributors, O=Cairn, C=CN',
    thumbprint: 'abc',
    timestamped: true,
    path: FILE,
    ...overrides,
  })
}

describe('parseDistinguishedName', () => {
  it('parses keys case-insensitively and handles quotes and escapes', () => {
    const parsed = parseDistinguishedName('CN=Cairn, O="Cairn, Inc.", OU=Release\\, Team')
    expect(parsed.get('CN')).toBe('Cairn')
    expect(parsed.get('O')).toBe('Cairn, Inc.')
    expect(parsed.get('OU')).toBe('Release, Team')
  })

  it('ignores malformed segments', () => {
    expect(parseDistinguishedName('CN=Cairn,broken,=x').size).toBe(1)
    expect(parseDistinguishedName('CN=Cairn').get('CN')).toBe('Cairn')
  })

  it('requires a full DN', () => {
    expect(isFullDistinguishedName('CN=Cairn, O=Cairn')).toBe(true)
    expect(isFullDistinguishedName('Cairn')).toBe(false)
    expect(isFullDistinguishedName('=x')).toBe(false)
  })
})

describe('parseAuthenticodeOutput', () => {
  it('strips a BOM and parses JSON; invalid output returns undefined', () => {
    expect(parseAuthenticodeOutput(`\uFEFF${validOutput()}`)).toMatchObject({ status: 'Valid' })
    expect(parseAuthenticodeOutput('')).toBeUndefined()
    expect(parseAuthenticodeOutput('not json')).toBeUndefined()
    expect(parseAuthenticodeOutput('null')).toBeUndefined()
  })
})

describe('createAuthenticodeVerifier', () => {
  it('accepts a valid signature whose DN contains every expected attribute', async () => {
    const verifier = createAuthenticodeVerifier({ run: runner({ stdout: validOutput() }) })
    await expect(verifier(['CN=Cairn contributors, O=Cairn'], FILE)).resolves.toBeNull()
    await expect(verifier(['CN=Cairn contributors'], FILE)).resolves.toBeNull()
  })

  it('accepts the numeric Valid status and rejects non-Valid statuses', async () => {
    const numeric = createAuthenticodeVerifier({
      run: runner({ stdout: validOutput({ status: 0 }) }),
    })
    await expect(numeric(['CN=Cairn contributors'], FILE)).resolves.toBeNull()
    const invalid = createAuthenticodeVerifier({
      run: runner({ stdout: validOutput({ status: 'HashMismatch' }) }),
    })
    await expect(invalid(['CN=Cairn contributors'], FILE)).resolves.toContain('HashMismatch')
    const missing = createAuthenticodeVerifier({
      run: runner({ stdout: validOutput({ status: undefined }) }),
    })
    await expect(missing(['CN=Cairn contributors'], FILE)).resolves.toContain('missing')
  })

  it('fails closed on execution errors, stderr, unparseable output and missing timestamp', async () => {
    await expect(
      createAuthenticodeVerifier({
        run: runner({ error: new Error('powershell missing') }),
      })(['CN=Cairn'], FILE),
    ).resolves.toContain('powershell missing')
    await expect(
      createAuthenticodeVerifier({ run: runner({ stdout: validOutput(), stderr: 'warning' }) })(
        ['CN=Cairn'],
        FILE,
      ),
    ).resolves.toContain('stderr')
    await expect(
      createAuthenticodeVerifier({ run: runner({ stdout: 'garbage' }) })(['CN=Cairn'], FILE),
    ).resolves.toContain('unparseable')
    await expect(
      createAuthenticodeVerifier({ run: runner({}) })(['CN=Cairn'], FILE),
    ).resolves.toContain('unparseable')
    await expect(
      createAuthenticodeVerifier({
        run: runner({ stdout: validOutput({ timestamped: false }) }),
      })(['CN=Cairn'], FILE),
    ).resolves.toContain('timestamp')
  })

  it('rejects missing signer subjects, mismatched DNs and different files', async () => {
    await expect(
      createAuthenticodeVerifier({ run: runner({ stdout: validOutput({ subject: null }) }) })(
        ['CN=Cairn'],
        FILE,
      ),
    ).resolves.toContain('subject')
    await expect(
      createAuthenticodeVerifier({ run: runner({ stdout: validOutput() }) })(
        ['CN=Someone Else'],
        FILE,
      ),
    ).resolves.toContain('publisher')
    await expect(
      createAuthenticodeVerifier({
        run: runner({ stdout: validOutput({ path: 'C:\\other.exe' }) }),
      })(['CN=Cairn'], FILE),
    ).resolves.toContain('different file')
    await expect(
      createAuthenticodeVerifier({
        run: runner({ stdout: validOutput({ subject: 'not a distinguished name' }) }),
      })(['CN=Cairn'], FILE),
    ).resolves.toContain('publisher')
  })

  it('rejects missing, empty and CN-only publisher names before running PowerShell', async () => {
    const run = vi.fn<CommandRunner>()
    const verifier = createAuthenticodeVerifier({ run })
    await expect(verifier([], FILE)).resolves.toContain('not configured')
    await expect(verifier(['Cairn'], FILE)).resolves.toContain('full distinguished name')
    await expect(verifier([''], FILE)).resolves.toContain('full distinguished name')
    await expect(verifier(['CN=Cairn'], '   ')).resolves.toContain('empty')
    expect(run).not.toHaveBeenCalled()
  })

  it('handles a runner that throws synchronously', async () => {
    const run: CommandRunner = () => {
      throw new Error('spawn failed')
    }
    await expect(createAuthenticodeVerifier({ run })(['CN=Cairn'], FILE)).resolves.toContain(
      'could not run',
    )
  })

  it('passes the file path through the environment, not the command text', async () => {
    const seen: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv } = {}
    const run: CommandRunner = (command, args, options, callback) => {
      seen.command = command
      seen.args = args
      seen.env = options.env
      callback({ stdout: validOutput() })
    }
    await createAuthenticodeVerifier({ run })(['CN=Cairn'], FILE)
    expect(seen.command).toBe('powershell.exe')
    expect(seen.args?.join(' ')).not.toContain(FILE)
    expect(seen.env?.['CAIRN_UPDATE_FILE']).toBe(FILE)
  })

  it('uses the real PowerShell runner and fails closed for an unsigned file', async () => {
    const file = join(tmpdir(), `cairn-unsigned-${process.pid}-${Date.now()}.bin`)
    writeFileSync(file, 'not a signed executable')
    try {
      const error = await createAuthenticodeVerifier()(['CN=Cairn'], file)
      expect(error).not.toBeNull()
      expect(error).toContain('signature')
    } finally {
      rmSync(file, { force: true })
    }
  })
})
