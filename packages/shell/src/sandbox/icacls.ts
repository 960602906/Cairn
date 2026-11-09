/** `icacls` 调用的共享部分：完整性标签与 AppContainer 工作区 ACL 都经它执行。 */
import { spawn } from 'node:child_process'
import nodePath from 'node:path'

export interface IcaclsOptions {
  readonly env?: NodeJS.ProcessEnv
  /** 测试用：替换执行（返回退出码）。 */
  readonly run?: (args: readonly string[]) => Promise<number>
  /** 测试用：替换可执行文件路径。 */
  readonly exe?: string
}

/** `icacls` 位于 System32；用绝对路径，避免 PATH 被命令环境篡改。 */
export function icaclsPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return nodePath.win32.join(systemRoot, 'System32', 'icacls.exe')
}

function spawnIcacls(exe: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export function createIcaclsRunner(
  options: IcaclsOptions = {},
): (args: readonly string[]) => Promise<number> {
  if (options.run) return options.run
  const exe = options.exe ?? icaclsPath(options.env)
  return (args) => spawnIcacls(exe, args)
}
