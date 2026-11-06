/**
 * 执行一条命令（M1-09a、M1-09b）：按所选 shell 构造调用，工作目录为给定目录，标准输入立即关闭（不支持交互），
 * 输出按 UTF-8 流式解码，环境变量经过清洗。超时或取消时结束整个进程树；命令结束时残留的后台进程也一并结束
 * （见 process-tree.ts）。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { sanitizeEnv } from './env.js'
import { buildInvocation, type InvocationOptions, type ShellInvocation } from './invocation.js'
import {
  createProcessTree,
  type ProcessTree,
  type ProcessTreeFactory,
  type ProcessTreeMechanism,
} from './process-tree.js'
import type { ShellInfo } from './select.js'

export const ShellErrorCode = {
  /** shell 进程无法启动（可执行文件不存在、工作目录不存在等）。 */
  SpawnFailed: 'shell.spawn_failed',
} as const

/** 默认超时（毫秒）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

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

/** 取消信号（结构与 `AbortSignal` 相同的部分，便于传入 core 的 `AbortSignalLike`）。 */
export interface ShellAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface RunCommandOptions {
  /** 工作目录（工作区根目录）。 */
  readonly cwd: string
  /** 子进程的环境变量，默认当前进程的；都会经过 `sanitizeEnv` 清洗。 */
  readonly env?: NodeJS.ProcessEnv
  /** 取消：结束进程树，结果的 `aborted` 为 true。 */
  readonly signal?: ShellAbortSignal
  /** 超时（毫秒），默认 `DEFAULT_COMMAND_TIMEOUT_MS`；0 表示不限时。超时时结束进程树，结果的 `timedOut` 为 true。 */
  readonly timeoutMs?: number
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
  /** 为 false 时不在结果中汇总输出（`stdout` / `stderr` 为空），由调用方经 `onStdout` / `onStderr` 自行保存。默认 true。 */
  readonly collectOutput?: boolean
  /** 临时脚本所在目录，默认系统临时目录。 */
  readonly tempDir?: string
  readonly maxCommandLineChars?: InvocationOptions['maxCommandLineChars']
  /** 进程树的结束方式，默认 `createProcessTree()`。 */
  readonly processTree?: ProcessTreeFactory
}

export interface RunCommandResult {
  /** 进程的退出码；被信号结束时为 null。 */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly aborted: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  /** 结束进程树的方式；没有启动时为 undefined。 */
  readonly processTree?: ProcessTreeMechanism
}

export async function runCommand(
  shell: ShellInfo,
  command: string,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  if (options.signal?.aborted) return notStarted()
  const invocation = buildInvocation(shell, command, {
    tempScriptPath: () =>
      nodePath.join(options.tempDir ?? tmpdir(), `cairn-command-${randomUUID()}.ps1`),
    ...(options.maxCommandLineChars === undefined
      ? {}
      : { maxCommandLineChars: options.maxCommandLineChars }),
  })
  const tree = await (options.processTree ?? createProcessTree)()
  const temp = invocation.tempScript
  if (temp) await fs.writeFile(temp.path, temp.content)
  try {
    // 先清洗，再加上调用本身需要的变量（cmd 的 CAIRN_SHELL_COMMAND）
    const env = { ...sanitizeEnv(options.env ?? process.env), ...invocation.env }
    return await spawnAndCollect(invocation, env, tree, options)
  } finally {
    if (temp) await fs.rm(temp.path, { force: true })
  }
}

const notStarted = (): RunCommandResult => ({
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  aborted: true,
  timedOut: false,
  durationMs: 0,
})

function spawnAndCollect(
  invocation: ShellInvocation,
  env: NodeJS.ProcessEnv,
  tree: ProcessTree,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const started = performance.now()
  const { file } = invocation
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      tree.dispose()
      resolve(notStarted())
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
      child = spawn(file, invocation.args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
        detached: tree.detached,
      })
    } catch (error) {
      tree.dispose()
      fail(error)
      return
    }
    // 启动后立即放进作业（或记下进程组）
    if (child.pid !== undefined) tree.attach(child.pid)

    let aborted = false
    let timedOut = false
    let exited = false
    let settled = false
    const out: string[] = []
    const err: string[] = []
    const keep = options.collectOutput ?? true
    const collect = (
      stream: NodeJS.ReadableStream | null,
      parts: string[],
      listener?: (text: string) => void,
    ) => {
      const decoder = new StringDecoder('utf8')
      const push = (text: string) => {
        if (text === '') return
        if (keep) parts.push(text)
        listener?.(text)
      }
      stream?.on('data', (chunk: Buffer) => push(decoder.write(chunk)))
      stream?.on('end', () => push(decoder.end()))
    }
    collect(child.stdout, out, options.onStdout)
    collect(child.stderr, err, options.onStderr)
    // 不支持交互：标准输入立即关闭
    child.stdin?.on('error', () => {})
    child.stdin?.end()

    const stop = () => {
      if (exited) return
      tree.terminate().catch(() => child.kill('SIGKILL'))
    }
    const onAbort = () => {
      aborted = true
      stop()
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            stop()
          }, timeoutMs)
        : undefined
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      // 没有启动成功（可执行文件或工作目录不存在）；启动后的错误由 close 给出结果
      if (child.pid !== undefined || settled) return
      settled = true
      cleanup()
      tree.dispose()
      fail(error)
    })
    // shell 退出后立即结束残留的后台进程：它们可能持有输出管道，使 close 一直不来
    child.on('exit', () => {
      exited = true
      cleanup()
      tree.dispose()
    })
    child.on('close', (exitCode, signal) => {
      cleanup()
      if (settled) return
      settled = true
      resolve({
        exitCode,
        signal,
        stdout: out.join(''),
        stderr: err.join(''),
        aborted,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        processTree: tree.mechanism,
      })
    })
  })
}
