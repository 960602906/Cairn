/**
 * 设置页的“默认 Shell”（M2-09，ADR-0012）：`auto` 在这台电脑上会选中哪个 shell，以及可以设置的选项。
 *
 * 探测结果在第一次询问后缓存（PowerShell 探测要启动一次进程）；探测失败时下次再试。宿主进程启动时
 * 按设置自行选择（`builtin-tools`），这里只用于显示。
 */
import { describeShell, selectShell, type ShellInfo } from '@cairn/shell'
import type { ShellPreference } from '@cairn/protocol'

export interface ShellInfoResult {
  readonly detected: string
  readonly options: ShellPreference[]
}

export interface ShellInfoOptions {
  readonly platform?: NodeJS.Platform
  /** 测试用：替换 shell 选择。 */
  readonly select?: () => Promise<ShellInfo>
}

export function createShellInfo(options: ShellInfoOptions = {}): () => Promise<ShellInfoResult> {
  const platform = options.platform ?? process.platform
  const select = options.select ?? (() => selectShell({ platform }))
  let cached: Promise<ShellInfoResult> | undefined
  return () => {
    cached ??= select().then(
      (shell) => ({
        detected: describeShell(shell),
        options: platform === 'win32' ? ['auto', 'cmd'] : ['auto'],
      }),
      (error: unknown) => {
        cached = undefined
        throw error
      },
    )
    return cached
  }
}
