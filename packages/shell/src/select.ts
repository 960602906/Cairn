/**
 * Shell 选择（ADR-0012）：
 *
 * - Windows：优先非商店版 PowerShell 7（`pwsh.exe`，实际路径不在 `WindowsApps` 下）；否则 Windows PowerShell 5.1；
 *   都不可用时用 cmd。设置为 cmd 时直接用 cmd。商店版 pwsh 的子进程会脱离作业对象（S7），不选用。
 * - 其他平台：`$SHELL` 是 bash 或 zsh 时用它，否则 `/bin/bash`，再否则 `/bin/sh`（为 M6 预留，M1 只用于 Linux CI）。
 *
 * 可执行文件优先用固定的安装位置（不依赖 PATH），找不到时再按 PATH 查找。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import nodePath from 'node:path'

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'

export interface ShellInfo {
  readonly kind: ShellKind
  /** 可执行文件（尽量是绝对路径）。 */
  readonly exe: string
  /** PowerShell 的版本，如 `7.5.4`、`5.1.26100.1`。 */
  readonly version?: string
}

/** 用户设置：`auto` 按上面的顺序选择；`cmd` 只在 Windows 上有效。 */
export type ShellPreference = 'auto' | 'cmd'

/** 探测结果：PowerShell 给出版本与实际运行的可执行文件路径。 */
export interface ShellProbeResult {
  readonly version?: string
  /** 实际运行的可执行文件（商店版 pwsh 经应用执行别名启动，实际位于 WindowsApps）。 */
  readonly path?: string
}

/** 探测一个候选；不可用时返回 undefined。 */
export type ShellProbe = (exe: string, kind: ShellKind) => Promise<ShellProbeResult | undefined>

export interface SelectShellOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly preference?: ShellPreference
  readonly probe?: ShellProbe
}

/** 商店版（MSIX）安装在 WindowsApps 下。 */
export const isPackagedPath = (path: string): boolean => /[\\/]WindowsApps[\\/]/i.test(path)

const PROBE_TIMEOUT_MS = 10_000
const PS_PROBE = "$PSVersionTable.PSVersion.ToString() + ' ' + (Get-Process -Id $PID).Path"

/** 默认的探测：PowerShell 运行一次取版本与路径；其他 shell 检查文件存在且可执行。 */
export const defaultShellProbe: ShellProbe = async (exe, kind) => {
  if (kind === 'pwsh' || kind === 'powershell') {
    return new Promise((resolve) => {
      execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-Command', PS_PROBE],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error) return resolve(undefined)
          const line = stdout.trim()
          const space = line.indexOf(' ')
          resolve(
            space < 0
              ? { version: line }
              : { version: line.slice(0, space), path: line.slice(space + 1) },
          )
        },
      )
    })
  }
  try {
    await fs.access(exe, fs.constants.X_OK)
    return {}
  } catch {
    return undefined
  }
}

const winJoin = (...parts: string[]) => nodePath.win32.join(...parts)

/** Windows 上各 shell 的候选位置，按优先顺序。 */
export function windowsCandidates(
  env: NodeJS.ProcessEnv,
): Record<'pwsh' | 'powershell' | 'cmd', string[]> {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  const programFiles = [env['ProgramFiles'], env['ProgramW6432']].filter(
    (p, i, all): p is string => !!p && all.indexOf(p) === i,
  )
  return {
    pwsh: [...programFiles.map((p) => winJoin(p, 'PowerShell', '7', 'pwsh.exe')), 'pwsh.exe'],
    powershell: [
      winJoin(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'powershell.exe',
    ],
    cmd: [...(env['ComSpec'] ? [env['ComSpec']] : []), winJoin(systemRoot, 'System32', 'cmd.exe')],
  }
}

export async function selectShell(options: SelectShellOptions = {}): Promise<ShellInfo> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const probe = options.probe ?? defaultShellProbe

  const first = async (kind: ShellKind, candidates: readonly string[]) => {
    for (const exe of candidates) {
      const result = await probe(exe, kind)
      if (!result) continue
      // 商店版 pwsh 不选用
      if (kind === 'pwsh' && (isPackagedPath(exe) || isPackagedPath(result.path ?? ''))) continue
      const info: ShellInfo = {
        kind,
        exe: result.path ?? exe,
        ...(result.version ? { version: result.version } : {}),
      }
      return info
    }
    return undefined
  }

  if (platform === 'win32') {
    const candidates = windowsCandidates(env)
    const cmd: ShellInfo = { kind: 'cmd', exe: candidates.cmd[0]! }
    if (options.preference === 'cmd') return cmd
    return (
      (await first('pwsh', candidates.pwsh)) ??
      (await first('powershell', candidates.powershell)) ??
      cmd
    )
  }

  const login = env['SHELL']
  const name = login ? nodePath.posix.basename(login) : ''
  if (login && (name === 'bash' || name === 'zsh')) {
    const found = await first(name, [login])
    if (found) return found
  }
  return (await first('bash', ['/bin/bash', '/usr/bin/bash'])) ?? { kind: 'sh', exe: '/bin/sh' }
}
