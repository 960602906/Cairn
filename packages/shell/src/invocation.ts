/**
 * 把一条命令变成具体的进程调用（可执行文件与参数），不同 shell 的语法只出现在这里（ADR-0012）。
 */
import {
  encodePowerShellCommand,
  POWERSHELL_BASE_ARGS,
  wrapPowerShellScript,
} from './powershell.js'
import type { ShellInfo } from './select.js'

/**
 * 命令行长度的上限（字符数）。Windows 命令行上限 32767，留出余量；超过时 PowerShell 改用临时 `.ps1`。
 * 两层 Base64 后每个 ASCII 字符约占 3.6 个字符、每个汉字约 10.7 个（S7）。
 */
export const MAX_COMMAND_LINE_CHARS = 30_000

/** cmd 模式下传递命令的环境变量。 */
export const CMD_COMMAND_VAR = 'NEXUS_SHELL_COMMAND'

export interface ShellInvocation {
  readonly file: string
  readonly args: readonly string[]
  /** 参数原样传给进程，不再由 Node 加引号（cmd 的 `/s /c "..."`）。 */
  readonly windowsVerbatimArguments?: boolean
  /** 需要额外设置的环境变量（cmd 经环境变量传入命令）。 */
  readonly env?: Readonly<Record<string, string>>
  /** 需要先写入的临时脚本（PowerShell 命令过长时）；执行结束后删除。 */
  readonly tempScript?: { readonly path: string; readonly content: Buffer }
}

export interface InvocationOptions {
  /** 临时脚本的路径（只在需要时调用）。 */
  readonly tempScriptPath: () => string
  /** 默认 `MAX_COMMAND_LINE_CHARS`。 */
  readonly maxCommandLineChars?: number
}

const commandLineLength = (file: string, args: readonly string[]) =>
  [file, ...args].reduce((n, a) => n + a.length + 3, 0)

export function buildInvocation(
  shell: ShellInfo,
  command: string,
  options: InvocationOptions,
): ShellInvocation {
  switch (shell.kind) {
    case 'pwsh':
    case 'powershell': {
      const wrapped = wrapPowerShellScript(command)
      const args = [...POWERSHELL_BASE_ARGS, '-EncodedCommand', encodePowerShellCommand(wrapped)]
      const max = options.maxCommandLineChars ?? MAX_COMMAND_LINE_CHARS
      if (commandLineLength(shell.exe, args) <= max) return { file: shell.exe, args }
      // 过长：写成带 BOM 的 UTF-8 `.ps1`（内容相同，同样以前置脚本开头），以 -File 运行
      const path = options.tempScriptPath()
      return {
        file: shell.exe,
        args: [...POWERSHELL_BASE_ARGS, '-ExecutionPolicy', 'Bypass', '-File', path],
        tempScript: { path, content: Buffer.from(`\uFEFF${wrapped}\n`, 'utf8') },
      }
    }
    case 'cmd':
      // cmd 启动时读取控制台代码页，之后的 chcp 对自身的输出不生效：先切到 UTF-8，再启动新的 cmd 执行命令。
      // 命令经环境变量传给外层，用延迟扩展取出：外层不解析其中的 & | 引号等，只有内层按原样解析一次。
      // /d 不运行 AutoRun；/s 去掉最外层的引号；内层关闭延迟扩展，`!` 原样保留。退出码随内层返回。
      return {
        file: shell.exe,
        args: [
          '/d',
          '/v:on',
          '/s',
          '/c',
          `"chcp 65001 >nul & "${shell.exe}" /d /v:off /s /c "!${CMD_COMMAND_VAR}!""`,
        ],
        windowsVerbatimArguments: true,
        env: { [CMD_COMMAND_VAR]: command },
      }
    case 'bash':
      return { file: shell.exe, args: ['--noprofile', '--norc', '-c', command] }
    case 'zsh':
      return { file: shell.exe, args: ['-f', '-c', command] }
    case 'sh':
      return { file: shell.exe, args: ['-c', command] }
  }
}
