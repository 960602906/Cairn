/**
 * 执行一条命令（M1-09a）：按所选 shell 构造调用，工作目录为给定目录，标准输入立即关闭（不支持交互），
 * 输出按 UTF-8 流式解码。进程树的结束、超时与环境变量清洗在 M1-09b 加入；这里取消时只结束 shell 进程本身。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { buildInvocation, type InvocationOptions } from './invocation.js'
import type { ShellInfo } from './select.js'

export const ShellErrorCode = {
  /** shell 进程无法启动（可执行文件不存在、工作目录不存在等）。 */
  SpawnFailed: 'shell.spawn_failed',
} as const

export class ShellError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Readonly<Record<string, string>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ShellError'
  }
}

export interface RunCommandOptions {
  /** 工作目录（工作区根目录）。 */
  readonly cwd: string
  /** 子进程的环境变量，默认继承当前进程。 */
  readonly env?: NodeJS.ProcessEnv
  /** 取消：结束进程，结果的 `aborted` 为 true。 */
  readonly signal?: AbortSignal
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
  /** 临时脚本所在目录，默认系统临时目录。 */
  readonly tempDir?: string
  readonly maxCommandLineChars?: InvocationOptions['maxCommandLineChars']
}

export interface RunCommandResult {
  /** 进程的退出码；被信号结束时为 null。 */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly aborted: boolean
  readonly durationMs: number
}

export async function runCommand(
  shell: ShellInfo,
  command: string,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const invocation = buildInvocation(shell, command, {
    tempScriptPath: () =>
      nodePath.join(options.tempDir ?? tmpdir(), `nexus-command-${randomUUID()}.ps1`),
    ...(options.maxCommandLineChars === undefined
      ? {}
      : { maxCommandLineChars: options.maxCommandLineChars }),
  })
  const temp = invocation.tempScript
  if (temp) await fs.writeFile(temp.path, temp.content)
  try {
    const env = options.env ?? process.env
    return await spawnAndCollect(invocation.file, invocation.args, {
      ...options,
      env: invocation.env ? { ...env, ...invocation.env } : env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
    })
  } finally {
    if (temp) await fs.rm(temp.path, { force: true })
  }
}

function spawnAndCollect(
  file: string,
  args: readonly string[],
  options: RunCommandOptions & { windowsVerbatimArguments: boolean },
): Promise<RunCommandResult> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        aborted: true,
        durationMs: 0,
      })
      return
    }
    const fail = (error: unknown) =>
      reject(
        new ShellError(
          ShellErrorCode.SpawnFailed,
          `Cannot start ${file} (${(error as NodeJS.ErrnoException).code ?? String(error)}).`,
          { shell: file },
          { cause: error },
        ),
      )
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      })
    } catch (error) {
      fail(error)
      return
    }
    let aborted = false
    let settled = false
    const out: string[] = []
    const err: string[] = []
    const collect = (
      stream: NodeJS.ReadableStream | null,
      parts: string[],
      listener?: (text: string) => void,
    ) => {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk)
        if (text === '') return
        parts.push(text)
        listener?.(text)
      })
      stream?.on('end', () => {
        const rest = decoder.end()
        if (rest === '') return
        parts.push(rest)
        listener?.(rest)
      })
    }
    collect(child.stdout, out, options.onStdout)
    collect(child.stderr, err, options.onStderr)
    // 不支持交互：标准输入立即关闭
    child.stdin?.on('error', () => {})
    child.stdin?.end()

    const onAbort = () => {
      aborted = true
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      // 没有启动成功（可执行文件或工作目录不存在）；启动后的错误由 close 给出结果
      if (child.pid !== undefined || settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      fail(error)
    })
    child.on('close', (exitCode, signal) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      resolve({
        exitCode,
        signal,
        stdout: out.join(''),
        stderr: err.join(''),
        aborted,
        durationMs: Math.round(performance.now() - started),
      })
    })
  })
}
