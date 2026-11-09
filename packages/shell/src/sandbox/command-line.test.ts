import { describe, expect, it } from 'vitest'
import {
  buildEnvironmentBlock,
  buildWindowsCommandLine,
  quoteWindowsArgument,
} from './command-line.js'

describe('quoteWindowsArgument', () => {
  it('leaves simple arguments alone', () => {
    expect(quoteWindowsArgument('pwsh.exe')).toBe('pwsh.exe')
    expect(quoteWindowsArgument('-NoProfile')).toBe('-NoProfile')
  })

  it('quotes empty and whitespace arguments', () => {
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('a b')).toBe('"a b"')
    expect(quoteWindowsArgument('a\tb')).toBe('"a\tb"')
  })

  it('escapes quotes and trailing backslashes per MSVCRT rules', () => {
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"')
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"')
    expect(quoteWindowsArgument('dir\\')).toBe('dir\\')
    expect(quoteWindowsArgument('a b\\')).toBe('"a b\\\\"')
    expect(quoteWindowsArgument('a\\\\"b')).toBe('"a\\\\\\\\\\"b"')
  })
})

describe('buildWindowsCommandLine', () => {
  it('quotes the executable and every argument', () => {
    expect(
      buildWindowsCommandLine({
        file: 'C:\\Program Files\\PowerShell\\pwsh.exe',
        args: ['-NoProfile', 'a b'],
      }),
    ).toBe('"C:\\Program Files\\PowerShell\\pwsh.exe" -NoProfile "a b"')
  })

  it('keeps cmd arguments verbatim', () => {
    expect(
      buildWindowsCommandLine({
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"chcp 65001 >nul & echo hi"'],
        windowsVerbatimArguments: true,
      }),
    ).toBe('"C:\\Windows\\System32\\cmd.exe" /d /s /c "chcp 65001 >nul & echo hi"')
  })
})

describe('buildEnvironmentBlock', () => {
  it('writes UTF-16 key=value pairs sorted and double-NUL terminated', () => {
    const block = buildEnvironmentBlock({ B: '2', A: '1', SKIPPED: undefined })
    expect(block.toString('utf16le')).toBe('A=1\0B=2\0\0')
  })

  it('is empty except for the terminator without variables', () => {
    expect(buildEnvironmentBlock({}).toString('utf16le')).toBe('\0\0')
  })
})
