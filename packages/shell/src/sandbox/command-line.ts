/**
 * 不经过 Node 的 `spawn` 时，需要自己构造 Windows 命令行与环境块（`CreateProcessAsUserW`）。
 *
 * 参数引用遵循 MSVCRT 规则：反斜杠只在引号前成倍转义；含空白、引号或为空时加引号。`cmd` 的调用已经
 * 带好引号（`windowsVerbatimArguments`），原样拼接。
 */
import type { ShellInvocation } from '../invocation.js'

const needsQuotes = (arg: string) => arg === '' || /[\s"]/.test(arg)

/** 按 MSVCRT 规则引用一个参数。 */
export function quoteWindowsArgument(arg: string): string {
  if (!needsQuotes(arg)) return arg
  let result = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1)
      result += '"'
    } else {
      result += '\\'.repeat(backslashes)
      result += char
    }
    backslashes = 0
  }
  result += '\\'.repeat(backslashes * 2)
  return `${result}"`
}

/** 完整命令行：可执行文件 + 参数。 */
export function buildWindowsCommandLine(invocation: ShellInvocation): string {
  if (invocation.windowsVerbatimArguments) {
    return `"${invocation.file}" ${invocation.args.join(' ')}`
  }
  return [invocation.file, ...invocation.args].map(quoteWindowsArgument).join(' ')
}

/**
 * Windows 环境块：`key=value` 以 NUL 分隔，整块以两个 NUL 结束。变量名不区分大小写，保留调用方给出的
 * 原始大小写；排序只为稳定（便于测试）。
 */
export function buildEnvironmentBlock(env: NodeJS.ProcessEnv): Buffer {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
  const text = entries.map(([name, value]) => `${name}=${value}`).join('\0')
  return Buffer.from(`${text}\0\0`, 'utf16le')
}
