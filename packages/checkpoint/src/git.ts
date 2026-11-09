/**
 * 调用 Git 命令行（ADR-0008，S5/S6）：本机 Git，与用户的 Git 环境隔离。
 *
 * - 去掉继承的 `GIT_*` 环境变量（`GIT_DIR`、`GIT_INDEX_FILE` 等会让命令作用到别的仓库）。
 * - 屏蔽系统级与用户级配置（`GIT_CONFIG_NOSYSTEM`，`GIT_CONFIG_GLOBAL` 指向空文件）：用户的
 *   `autocrlf`、钩子、签名、LFS 过滤器都不影响检查点。
 * - `GIT_LITERAL_PATHSPECS=1`：路径中的 `*`、`[` 不被当作通配符。
 * - 要求 Git ≥ 2.32（`GIT_CONFIG_GLOBAL`）；`core.fsync` 需要 2.36，更早的版本忽略它，只是更慢。
 */
import { spawn } from 'node:child_process'

/** 支持的最低 Git 版本。 */
export const MIN_GIT_VERSION = [2, 32, 0] as const

export const CheckpointErrorCode = {
  /** 没有可用的 Git（未安装、无法启动或版本过低）。 */
  GitUnavailable: 'checkpoint.git_unavailable',
  /** 检查点不存在（id 无效或对象已丢失）。 */
  NotFound: 'checkpoint.not_found',
  /** Git 命令失败。 */
  Failed: 'checkpoint.failed',
} as const

export class CheckpointError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Readonly<Record<string, string>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CheckpointError'
  }
}

export interface GitResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

export interface GitRunOptions {
  readonly cwd?: string
  readonly stdin?: string
  /** 非零退出码时不抛出。 */
  readonly allowFail?: boolean
}

export interface GitRunner {
  readonly binary: string
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>
}

/**
 * 与用户 Git 环境隔离的环境变量。
 *
 * `extra` 用于随包 MinGit：它需要显式的 `GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR` 与包含同目录 DLL 的
 * `PATH`。这些值由主进程的 Git 定位器给出，不接受用户环境中的同名变量。
 */
export function isolatedGitEnv(
  base: Readonly<Record<string, string | undefined>>,
  emptyConfigFile: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value
  }
  return {
    ...env,
    ...extra,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfigFile,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
}

export interface GitRunnerOptions {
  /** Git 可执行文件，默认 PATH 中的 `git`。 */
  readonly binary?: string
  readonly env: Readonly<Record<string, string>>
}

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const binary = options.binary ?? 'git'
  return {
    binary,
    run: (args, { cwd, stdin, allowFail = false } = {}) =>
      new Promise((resolve, reject) => {
        // 检查点所在的影子仓库由应用自己创建；不做所有权检查（Windows 上项目目录可能属于 Administrators）
        const fullArgs = ['-c', 'safe.directory=*', ...args]
        const child = spawn(binary, fullArgs, {
          ...(cwd !== undefined ? { cwd } : {}),
          env: options.env,
          windowsHide: true,
          stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
        child.stderr!.on('data', (chunk: Buffer) => err.push(chunk))
        child.on('error', (error) =>
          reject(
            new CheckpointError(
              CheckpointErrorCode.GitUnavailable,
              error.message,
              {},
              { cause: error },
            ),
          ),
        )
        child.on('close', (code) => {
          const result = {
            code: code ?? -1,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err).toString('utf8').trim(),
          }
          if (result.code !== 0 && !allowFail) {
            reject(
              new CheckpointError(
                CheckpointErrorCode.Failed,
                `git ${args.join(' ')} exited with ${result.code}: ${result.stderr}`,
                { exitCode: String(result.code) },
              ),
            )
          } else resolve(result)
        })
        if (child.stdin) {
          child.stdin.on('error', () => {})
          child.stdin.end(stdin)
        }
      }),
  }
}

/** 解析 `git version 2.56.0.windows.4` 之类的输出。 */
export function parseGitVersion(output: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

export function isSupportedGitVersion(version: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version
  const [minMajor, minMinor, minPatch] = MIN_GIT_VERSION
  if (major !== minMajor) return major > minMajor
  if (minor !== minMinor) return minor > minMinor
  return patch >= minPatch
}

export type GitDetection =
  | { readonly available: true; readonly binary: string; readonly version: string }
  | {
      readonly available: false
      readonly binary: string
      readonly reason: 'not_found' | 'too_old' | 'unrecognized'
      readonly version?: string
    }

/** 检测 Git 是否可用：能启动且版本 ≥ 2.32。 */
export async function detectGit(git: GitRunner): Promise<GitDetection> {
  let output: string
  try {
    const result = await git.run(['--version'])
    output = result.stdout.toString('utf8').trim()
  } catch {
    return { available: false, binary: git.binary, reason: 'not_found' }
  }
  const version = parseGitVersion(output)
  if (!version) return { available: false, binary: git.binary, reason: 'unrecognized' }
  const text = version.join('.')
  return isSupportedGitVersion(version)
    ? { available: true, binary: git.binary, version: text }
    : { available: false, binary: git.binary, reason: 'too_old', version: text }
}
