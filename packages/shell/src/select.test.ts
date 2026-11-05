import { describe, expect, it } from 'vitest'
import {
  defaultShellProbe,
  isPackagedPath,
  selectShell,
  windowsCandidates,
  type ShellKind,
  type ShellProbe,
  type ShellProbeResult,
} from './index.js'

const winEnv = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
}
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const STORE =
  'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.4.0_x64__8wekyb3d8bbwe\\pwsh.exe'

/** 按可执行文件给出探测结果的假探测。 */
function fakeProbe(results: Record<string, ShellProbeResult>) {
  const calls: [string, ShellKind][] = []
  const probe: ShellProbe = async (exe, kind) => {
    calls.push([exe, kind])
    return results[exe]
  }
  return { probe, calls }
}

describe('selectShell：Windows', () => {
  it('优先安装在固定位置的 PowerShell 7', async () => {
    const { probe } = fakeProbe({
      [PWSH]: { version: '7.5.4', path: PWSH },
      [PS51]: { version: '5.1', path: PS51 },
    })
    expect(await selectShell({ platform: 'win32', env: winEnv, probe })).toEqual({
      kind: 'pwsh',
      exe: PWSH,
      version: '7.5.4',
    })
  })

  it('PATH 中的 pwsh 是商店版（经执行别名启动）时不选用，改用 5.1', async () => {
    const { probe, calls } = fakeProbe({
      'pwsh.exe': { version: '7.5.4', path: STORE },
      [PS51]: { version: '5.1.26100', path: PS51 },
    })
    expect(await selectShell({ platform: 'win32', env: winEnv, probe })).toEqual({
      kind: 'powershell',
      exe: PS51,
      version: '5.1.26100',
    })
    // 相同的 ProgramFiles 只探测一次
    expect(calls.map(([exe]) => exe)).toEqual([PWSH, 'pwsh.exe', PS51])
  })

  it('PATH 中的非商店版 pwsh 使用其实际路径；候选本身在 WindowsApps 下时跳过', async () => {
    const { probe } = fakeProbe({
      [PWSH]: { version: '7.5.4', path: STORE },
      'pwsh.exe': { version: '7.4.0', path: 'D:\\tools\\pwsh\\pwsh.exe' },
    })
    expect(await selectShell({ platform: 'win32', env: winEnv, probe })).toMatchObject({
      kind: 'pwsh',
      exe: 'D:\\tools\\pwsh\\pwsh.exe',
    })
    expect(isPackagedPath(STORE)).toBe(true)
    expect(isPackagedPath('C:/x/windowsapps/pwsh.exe')).toBe(true)
    expect(isPackagedPath(PWSH)).toBe(false)
  })

  it('没有 PowerShell 或设置为 cmd 时用 cmd', async () => {
    const { probe, calls } = fakeProbe({ [PWSH]: { version: '7.5.4', path: PWSH } })
    expect(await selectShell({ platform: 'win32', env: winEnv, probe, preference: 'cmd' })).toEqual(
      { kind: 'cmd', exe: winEnv.ComSpec },
    )
    expect(calls).toEqual([])
    expect(await selectShell({ platform: 'win32', env: {}, probe: fakeProbe({}).probe })).toEqual({
      kind: 'cmd',
      exe: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  it('候选位置', () => {
    expect(windowsCandidates({ SYSTEMROOT: 'D:\\Win', ProgramFiles: 'E:\\PF' })).toEqual({
      pwsh: ['E:\\PF\\PowerShell\\7\\pwsh.exe', 'pwsh.exe'],
      powershell: ['D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell.exe'],
      cmd: ['D:\\Win\\System32\\cmd.exe'],
    })
  })
})

describe('selectShell：其他平台', () => {
  it('$SHELL 是 bash 或 zsh 时用它，否则 /bin/bash，再否则 /bin/sh', async () => {
    const { probe } = fakeProbe({ '/usr/bin/zsh': {}, '/bin/bash': {} })
    expect(
      await selectShell({ platform: 'darwin', env: { SHELL: '/usr/bin/zsh' }, probe }),
    ).toEqual({ kind: 'zsh', exe: '/usr/bin/zsh' })
    expect(
      await selectShell({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, probe }),
    ).toEqual({ kind: 'bash', exe: '/bin/bash' })
    expect(await selectShell({ platform: 'linux', env: { SHELL: '/opt/bash' }, probe })).toEqual({
      kind: 'bash',
      exe: '/bin/bash',
    })
    expect(
      await selectShell({
        platform: 'linux',
        env: {},
        probe: fakeProbe({ '/usr/bin/bash': {} }).probe,
      }),
    ).toEqual({ kind: 'bash', exe: '/usr/bin/bash' })
    expect(await selectShell({ platform: 'linux', env: {}, probe: fakeProbe({}).probe })).toEqual({
      kind: 'sh',
      exe: '/bin/sh',
    })
    // 设置为 cmd 只在 Windows 上有效
    expect(
      await selectShell({ platform: 'linux', env: {}, preference: 'cmd', probe }),
    ).toMatchObject({ kind: 'bash' })
  })
})

describe('defaultShellProbe', () => {
  it('不存在的可执行文件返回 undefined', async () => {
    expect(await defaultShellProbe('/nonexistent/pwsh', 'pwsh')).toBeUndefined()
    expect(await defaultShellProbe('/nonexistent/bash', 'bash')).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')('可执行文件存在时可用', async () => {
    expect(await defaultShellProbe('/bin/sh', 'sh')).toEqual({})
  })

  it.runIf(process.platform === 'win32')(
    '当前系统选中 PowerShell，给出版本与实际路径',
    async () => {
      const shell = await selectShell()
      expect(['pwsh', 'powershell']).toContain(shell.kind)
      expect(shell.version).toMatch(/^\d+\.\d+/)
      expect(shell.exe).toMatch(/\.exe$/i)
    },
  )

  it.runIf(process.platform !== 'win32')('当前系统选中 bash', async () => {
    expect(await selectShell({ env: {} })).toMatchObject({ kind: 'bash' })
  })
})
