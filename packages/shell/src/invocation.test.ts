import { describe, expect, it } from 'vitest'
import {
  buildInvocation,
  CMD_COMMAND_VAR,
  POWERSHELL_EPILOGUE,
  POWERSHELL_PRELUDE,
  wrapPowerShellScript,
  type ShellInfo,
} from './index.js'

const ps: ShellInfo = { kind: 'powershell', exe: 'C:\\ps\\powershell.exe', version: '5.1' }
const tempScriptPath = () => 'C:\\tmp\\cairn-command-1.ps1'

/** 从 -EncodedCommand 取回最终脚本与其中嵌入的用户脚本。 */
function decode(args: readonly string[]) {
  const wrapped = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
  const embedded = /FromBase64String\('([^']*)'\)/.exec(wrapped)![1]!
  return { wrapped, user: Buffer.from(embedded, 'base64').toString('utf8') }
}

describe('PowerShell', () => {
  it('-EncodedCommand：前置脚本、用户脚本（UTF-8 Base64，作为脚本块执行）、结尾', () => {
    const command = 'Write-Output \'中文 "引号" $env:PATH `反引号 😀\''
    const inv = buildInvocation(ps, command, { tempScriptPath })
    expect(inv.file).toBe(ps.exe)
    expect(inv.args.slice(0, -1)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-EncodedCommand',
    ])
    const { wrapped, user } = decode(inv.args)
    expect(user).toBe(command)
    expect(wrapped.startsWith(POWERSHELL_PRELUDE)).toBe(true)
    expect(wrapped.endsWith(POWERSHELL_EPILOGUE)).toBe(true)
    expect(wrapped).toContain('[ScriptBlock]::Create($__cairnScript)')
    expect(inv.tempScript).toBeUndefined()
  })

  it('命令行过长时改用带 BOM 的 UTF-8 临时 .ps1', () => {
    const pwsh: ShellInfo = { kind: 'pwsh', exe: 'pwsh.exe' }
    const short = buildInvocation(pwsh, `Write-Output '${'a'.repeat(5_000)}'`, { tempScriptPath })
    expect(short.tempScript).toBeUndefined()
    const command = `Write-Output '${'中'.repeat(3_000)}'`
    const long = buildInvocation(pwsh, command, { tempScriptPath })
    expect(long.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tempScriptPath(),
    ])
    const content = long.tempScript!.content
    expect([...content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(long.tempScript!.path).toBe(tempScriptPath())
    expect(content.subarray(3).toString('utf8')).toBe(`${wrapPowerShellScript(command)}\n`)
    // 上限可调
    expect(
      buildInvocation(pwsh, 'exit 0', { tempScriptPath, maxCommandLineChars: 100 }).tempScript,
    ).toBeDefined()
  })
})

it('cmd：先切换到 UTF-8 代码页，命令经环境变量交给新的 cmd 原样执行', () => {
  const command = 'echo "a & b" & dir | find "x" ^& !y!'
  const inv = buildInvocation({ kind: 'cmd', exe: 'C:\\cmd.exe' }, command, { tempScriptPath })
  expect(inv).toEqual({
    file: 'C:\\cmd.exe',
    args: [
      '/d',
      '/v:on',
      '/s',
      '/c',
      '"chcp 65001 >nul & "C:\\cmd.exe" /d /v:off /s /c "!CAIRN_SHELL_COMMAND!""',
    ],
    windowsVerbatimArguments: true,
    env: { [CMD_COMMAND_VAR]: command },
  })
})

it('bash、zsh、sh：-c，不读取配置文件', () => {
  expect(buildInvocation({ kind: 'bash', exe: '/bin/bash' }, 'ls', { tempScriptPath })).toEqual({
    file: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'ls'],
  })
  expect(buildInvocation({ kind: 'zsh', exe: '/bin/zsh' }, 'ls', { tempScriptPath }).args).toEqual([
    '-f',
    '-c',
    'ls',
  ])
  expect(buildInvocation({ kind: 'sh', exe: '/bin/sh' }, 'ls', { tempScriptPath }).args).toEqual([
    '-c',
    'ls',
  ])
})
