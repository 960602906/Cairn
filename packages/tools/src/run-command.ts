/**
 * `run_command`（M1-09c；ADR-0012；架构 §9.2、§9.3）：在工作区根目录用所选 shell 执行一条命令。
 *
 * - 执行交给 `@cairn/shell`：编码、错误流与退出码、超时与进程树、环境变量清洗都在那里处理；
 * - 输出经 `ctx.progress` 流式推送（`tool.output.delta`）；
 * - 交回模型的输出保留开头和结尾、中间截断并注明省略了多少；内存中也只保留开头与结尾；
 * - 超时前长时间没有输出时，说明命令可能在等待输入（不支持交互）。
 * - 交回模型的输出去掉 ANSI 控制符（M2-06）；原始输出的开头与结尾连同退出码、shell、工作目录放进
 *   `display`，供界面的终端卡片着色显示。
 *
 * 危险命令识别与审批在 M1-10、M1-11。
 */
import type { SandboxExecution, ToolDisplay, ToolOutputChunk } from '@cairn/protocol'
import {
  AnsiStripper,
  estimateTokens,
  MAX_LIVE_TOOL_OUTPUT_CHARS,
  ToolError,
  type ToolDefinition,
} from '@cairn/core'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  describeShell,
  runCommand,
  SandboxError,
  ShellError,
  ShellErrorCode,
  type RunCommandOptions,
  type RunCommandResult,
  type SandboxPolicy,
  type SandboxRunner,
  type ShellInfo,
} from '@cairn/shell'
import { resolveOrThrow } from './paths.js'
import { READ_FILE_MAX_OUTPUT_CHARS } from './read-file.js'

export interface RunCommandInput {
  readonly command: string
  /** 超时（秒），默认 120。 */
  readonly timeoutSeconds?: number
}

/** 沙箱来源：对象固定使用；函数在每次执行时解析（沙箱起不来后宿主可降级为不使用沙箱）。 */
export type RunCommandSandboxSource =
  | { readonly policy: SandboxPolicy; readonly runner: SandboxRunner }
  | (() => { readonly policy: SandboxPolicy; readonly runner: SandboxRunner } | undefined)

/** 没有执行器时的沙箱描述；同样支持函数，随降级状态变化。 */
export type RunCommandExecutionSource = SandboxExecution | (() => SandboxExecution | undefined)

export interface RunCommandToolOptions {
  /** 使用的 shell（宿主按设置用 `selectShell` 选出）。 */
  readonly shell: ShellInfo
  /** 交回模型的输出上限（字符），默认 `RUN_COMMAND_MAX_OUTPUT_CHARS`。 */
  readonly maxOutputChars?: number
  /** 超时前持续多久没有输出时提示可能在等待输入（毫秒），默认 `RUN_COMMAND_IDLE_HINT_MS`。 */
  readonly idleHintMs?: number
  /** 临时脚本所在目录（PowerShell 长命令），默认系统临时目录。 */
  readonly tempDir?: string
  /** 子进程环境变量的来源（会被清洗），默认当前进程的。 */
  readonly env?: NodeJS.ProcessEnv
  /** 测试用：替换执行函数。 */
  readonly run?: typeof runCommand
  /**
   * 命令沙箱（M5-04）：`run_command` 把解析后的策略交给执行器；实际机制与网络状态写入终端卡片。
   * 省略时按现有语义直接执行（非 Windows 或未启用沙箱）。
   */
  readonly sandbox?: RunCommandSandboxSource
  /**
   * 没有执行器时的沙箱描述（M5-04）：沙箱不可用、经审批在沙箱外运行时，`tool.started` 与终端卡片仍需
   * 如实显示“未沙箱化”及原因。有执行器时以执行器按策略解析的结果为准。
   */
  readonly execution?: RunCommandExecutionSource
  /**
   * 沙箱里的子进程在加载阶段就退出（`sandbox.child_start_failed`）时调用一次（M5-04）：
   * 宿主据此把沙箱标记为不可用，后续命令按设置失败关闭或经审批在沙箱外运行。
   */
  readonly onSandboxStartFailure?: () => void
}

export const RUN_COMMAND_MAX_OUTPUT_CHARS = READ_FILE_MAX_OUTPUT_CHARS
/** 给界面的原始输出上限（字符），与执行中的实时输出一致。 */
export const RUN_COMMAND_DISPLAY_MAX_CHARS = MAX_LIVE_TOOL_OUTPUT_CHARS
export const RUN_COMMAND_MAX_TIMEOUT_SECONDS = 600
export const RUN_COMMAND_IDLE_HINT_MS = 30_000
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_COMMAND_TIMEOUT_MS / 1000
/** stderr 至少能占用的输出比例（两者都很长时）。 */
const STDERR_MIN_SHARE = 0.25

/** 不在 UTF-16 代理对中间切开。 */
const safeEnd = (text: string, end: number) =>
  end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) ? end - 1 : end
const safeStart = (text: string, start: number) =>
  start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!) ? start + 1 : start

/** 只保留开头与结尾各 `limit / 2` 个字符的输出缓冲。 */
export class HeadTailBuffer {
  private head = ''
  private tail = ''
  private total = 0
  /** 开头已满（此后的输出都进入结尾）。 */
  private headDone = false

  constructor(private readonly limit: number) {}

  get length(): number {
    return this.total
  }

  push(text: string): void {
    this.total += text.length
    const headMax = Math.ceil(this.limit / 2)
    let rest = text
    if (!this.headDone) {
      const take = safeEnd(rest, headMax - this.head.length)
      this.head += rest.slice(0, take)
      rest = rest.slice(take)
      if (rest === '') return
      this.headDone = true
    }
    this.tail += rest
    // 摊销：超过保留长度的两倍时才裁剪
    if (this.tail.length > this.limit) this.tail = this.trimmedTail(Math.floor(this.limit / 2))
  }

  private trimmedTail(max: number): string {
    return this.tail.slice(safeStart(this.tail, Math.max(0, this.tail.length - max)))
  }

  /** 不超过 `limit`（不大于构造时的上限）个字符；截断时中间注明省略的字符数。 */
  render(limit: number = this.limit): string {
    if (this.total <= limit) return this.head + this.tail
    const head = this.head.slice(0, safeEnd(this.head, Math.ceil(limit / 2)))
    const tail = this.trimmedTail(Math.floor(limit / 2))
    const omitted = this.total - head.length - tail.length
    return `${head}\n[... ${omitted} characters omitted ...]\n${tail}`
  }
}

/** 结尾裁剪后，在这么多字符之内有换行时从换行之后开始（不留半行和半个控制序列）。 */
const TAIL_ALIGN_CHARS = 512

/**
 * 按到达顺序保留 stdout / stderr 原始片段的开头与结尾（各 `limit / 2` 个字符），给界面的终端卡片用。
 * 相邻的同一输出流合并为一段。
 */
export class OutputChunkBuffer {
  private readonly head: ToolOutputChunk[] = []
  private tail: ToolOutputChunk[] = []
  private headChars = 0
  private tailChars = 0
  private total = 0
  private headDone = false

  constructor(private readonly limit: number) {}

  push(stream: ToolOutputChunk['stream'], text: string): void {
    this.total += text.length
    let rest = text
    if (!this.headDone) {
      const take = safeEnd(rest, Math.ceil(this.limit / 2) - this.headChars)
      append(this.head, stream, rest.slice(0, take))
      this.headChars += take
      rest = rest.slice(take)
      if (rest === '') return
      this.headDone = true
    }
    append(this.tail, stream, rest)
    this.tailChars += rest.length
    // 摊销：超过上限时才裁剪到一半
    if (this.tailChars > this.limit) this.trimTail(Math.floor(this.limit / 2))
  }

  private trimTail(max: number): void {
    let excess = this.tailChars - max
    while (excess > 0) {
      const first = this.tail[0]!
      if (first.text.length <= excess) {
        this.tail.shift()
        excess -= first.text.length
        this.tailChars -= first.text.length
      } else {
        const start = safeStart(first.text, excess)
        this.tail[0] = { stream: first.stream, text: first.text.slice(start) }
        this.tailChars -= start
        excess = 0
      }
    }
  }

  /** 结尾从开头附近的第一个换行之后开始。 */
  private alignTail(): void {
    let offset = 0
    for (let i = 0; i < this.tail.length && offset < TAIL_ALIGN_CHARS; i++) {
      const chunk = this.tail[i]!
      const newline = chunk.text.indexOf('\n')
      if (newline >= 0 && offset + newline < TAIL_ALIGN_CHARS) {
        const rest = chunk.text.slice(newline + 1)
        this.tailChars -= offset + newline + 1
        this.tail = [
          ...(rest === '' ? [] : [{ stream: chunk.stream, text: rest }]),
          ...this.tail.slice(i + 1),
        ]
        return
      }
      offset += chunk.text.length
    }
  }

  display(): Pick<ToolDisplay, 'chunks' | 'omittedChars' | 'omittedAt'> {
    if (this.total <= this.limit) {
      const chunks: ToolOutputChunk[] = []
      for (const c of [...this.head, ...this.tail]) append(chunks, c.stream, c.text)
      return { chunks, omittedChars: 0 }
    }
    this.trimTail(Math.floor(this.limit / 2))
    this.alignTail()
    return {
      chunks: [...this.head, ...this.tail],
      omittedChars: this.total - this.headChars - this.tailChars,
      omittedAt: this.head.length,
    }
  }
}

function append(chunks: ToolOutputChunk[], stream: ToolOutputChunk['stream'], text: string) {
  if (text === '') return
  const last = chunks.at(-1)
  if (last?.stream === stream) chunks[chunks.length - 1] = { stream, text: last.text + text }
  else chunks.push({ stream, text })
}

/** 两段输出共享上限：都超出时 stderr 至少占 `STDERR_MIN_SHARE`，一方用不完的份额给另一方。 */
export function splitOutputBudget(
  stdout: number,
  stderr: number,
  budget: number,
): { stdout: number; stderr: number } {
  if (stdout + stderr <= budget) return { stdout, stderr }
  const err = Math.min(stderr, Math.max(Math.floor(budget * STDERR_MIN_SHARE), budget - stdout))
  return { stdout: budget - err, stderr: err }
}

interface Collected {
  readonly result: RunCommandResult
  readonly stdout: HeadTailBuffer
  readonly stderr: HeadTailBuffer
  /** 最后一次输出到结束经过的毫秒数。 */
  readonly idleMs: number
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`

function formatResult(
  collected: Collected,
  timeoutSeconds: number,
  budget: number,
  idleHintMs: number,
) {
  const { result, stdout, stderr, idleMs } = collected
  const lines: string[] = []
  if (result.timedOut) {
    lines.push(
      `Timed out after ${timeoutSeconds} s; the command and its child processes were terminated.`,
    )
    if (idleMs >= idleHintMs) {
      lines.push(
        `There was no output for the last ${seconds(idleMs)}: the command may have been waiting for input. ` +
          'Interactive input is not supported; use non-interactive options (e.g. -y, --yes, --no-input) or pass input in the command.',
      )
    }
  } else if (result.aborted) {
    lines.push('Cancelled; the command and its child processes were terminated.')
  } else if (result.exitCode !== null) {
    lines.push(`Exit code: ${result.exitCode}`)
  } else {
    lines.push(`Terminated by signal ${result.signal ?? 'unknown'}.`)
  }
  lines.push(`Duration: ${seconds(result.durationMs)}`)
  const share = splitOutputBudget(stdout.length, stderr.length, budget)
  if (stdout.length === 0 && stderr.length === 0) {
    lines.push('', '(no output)')
  } else {
    if (stdout.length > 0) lines.push('', 'stdout:', stdout.render(share.stdout).replace(/\n$/, ''))
    if (stderr.length > 0) lines.push('', 'stderr:', stderr.render(share.stderr).replace(/\n$/, ''))
  }
  return lines.join('\n')
}

/** 创建 `run_command` 工具。shell 由宿主选定（说明中写明 shell 类型，模型据此写命令）。 */
export function createRunCommandTool(
  options: RunCommandToolOptions,
): ToolDefinition<RunCommandInput> {
  const shellName = describeShell(options.shell)
  const budget = options.maxOutputChars ?? RUN_COMMAND_MAX_OUTPUT_CHARS
  const idleHintMs = options.idleHintMs ?? RUN_COMMAND_IDLE_HINT_MS
  const run = options.run ?? runCommand
  const resolveSandbox = () =>
    typeof options.sandbox === 'function' ? options.sandbox() : options.sandbox
  const resolveExecution = () =>
    typeof options.execution === 'function' ? options.execution() : options.execution
  const declaredSandbox = (): SandboxExecution | undefined => {
    const sandbox = resolveSandbox()
    return sandbox ? sandbox.runner.executionFor(sandbox.policy) : resolveExecution()
  }
  const definition: ToolDefinition<RunCommandInput> = {
    name: 'run_command',
    description:
      `Run a shell command in the workspace root and return its exit code and output. The shell is ${shellName}; ` +
      'write commands in its syntax. Commands cannot read input (stdin is closed), so use non-interactive options. ' +
      `The command is stopped after timeoutSeconds (default ${DEFAULT_TIMEOUT_SECONDS}); background processes it ` +
      'starts are terminated when it ends. Long output is truncated in the middle. Prefer read_file, list_dir, ' +
      'search, write_file and edit_file for reading and changing files.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          pattern: '\\S',
          description: `The command to run (${shellName} syntax). May span multiple lines.`,
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: RUN_COMMAND_MAX_TIMEOUT_SECONDS,
          description: `Timeout in seconds. Default ${DEFAULT_TIMEOUT_SECONDS}.`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    category: 'execute',
    source: { kind: 'builtin' },
    trust: 'builtin',
    normalize: async (input) => ({ input, targets: { command: input.command } }),

    async describeForApproval(input) {
      return { summary: `Run a ${shellName} command in the workspace`, command: input.command }
    },

    async execute(input, ctx) {
      const root = await resolveOrThrow(ctx, '.')
      const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
      const stdout = new HeadTailBuffer(budget)
      const stderr = new HeadTailBuffer(budget)
      const strippers = { stdout: new AnsiStripper(), stderr: new AnsiStripper() }
      const raw = new OutputChunkBuffer(RUN_COMMAND_DISPLAY_MAX_CHARS)
      let lastOutput = performance.now()
      const onOutput = (buffer: HeadTailBuffer, stream: 'stdout' | 'stderr') => (text: string) => {
        lastOutput = performance.now()
        buffer.push(strippers[stream].push(text))
        raw.push(stream, text)
        ctx.progress(text, stream)
      }
      const sandbox = resolveSandbox()
      const runOptions: RunCommandOptions = {
        cwd: root.absolute,
        signal: ctx.signal,
        timeoutMs: timeoutSeconds * 1000,
        collectOutput: false,
        onStdout: onOutput(stdout, 'stdout'),
        onStderr: onOutput(stderr, 'stderr'),
        ...(options.env ? { env: options.env } : {}),
        ...(options.tempDir ? { tempDir: options.tempDir } : {}),
        ...(sandbox ? { sandbox } : {}),
      }
      let result: RunCommandResult
      try {
        result = await run(options.shell, input.command, runOptions)
      } catch (error) {
        if (error instanceof ShellError) {
          // 沙箱起不来：通知宿主降级，下一次调用按“沙箱不可用”的设置处理
          if (error.code === ShellErrorCode.ChildInitFailed) options.onSandboxStartFailure?.()
          throw new ToolError(error.code, error.message, { ...error.params })
        }
        if (error instanceof SandboxError)
          throw new ToolError(error.code, error.message, { ...error.params })
        throw error
      }
      stdout.push(strippers.stdout.end())
      stderr.push(strippers.stderr.end())
      const collected = { result, stdout, stderr, idleMs: performance.now() - lastOutput }
      let chars = budget
      let text = formatResult(collected, timeoutSeconds, chars, idleHintMs)
      // 字符上限按英文估算；输出中中文等较多、超过 token 上限时按比例缩小后重排
      for (let i = 0; i < 4; i++) {
        const tokens = estimateTokens(text)
        if (tokens <= ctx.maxOutputTokens) break
        chars = Math.floor((chars * ctx.maxOutputTokens * 0.9) / tokens)
        text = formatResult(collected, timeoutSeconds, chars, idleHintMs)
      }
      const display: ToolDisplay = {
        kind: 'terminal',
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: Math.max(0, Math.round(result.durationMs)),
        shell: shellName,
        cwd: root.absolute,
        ...(result.sandbox ? { sandbox: result.sandbox } : {}),
        ...raw.display(),
      }
      return { content: [{ type: 'text', text }], display }
    },
  }
  // `sandbox` 是派生属性：沙箱起不来之后宿主会把来源切换成“无执行器”，
  // `tool.started` 读到的必须是那时真实生效的描述。
  if (options.sandbox || options.execution) {
    Object.defineProperty(definition, 'sandbox', {
      enumerable: true,
      get: declaredSandbox,
    })
  }
  return definition
}
