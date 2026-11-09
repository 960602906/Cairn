/**
 * `run_command`（M1-09c）：输出格式、截断、超时与等待输入的提示、流式推送、启动失败；真实执行在当前平台的 shell 上验证。
 */
import { createToolRegistry, estimateTokens, ToolError, type ToolContext } from '@cairn/core'
import type { runCommand } from '@cairn/shell'
import {
  selectShell,
  SandboxError,
  ShellError,
  type RunCommandOptions,
  type RunCommandResult,
  type SandboxExecution,
  type SandboxPolicy,
  type SandboxRunner,
  type ShellInfo,
} from '@cairn/shell'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRunCommandTool,
  HeadTailBuffer,
  OutputChunkBuffer,
  registerExecuteTools,
  RUN_COMMAND_MAX_OUTPUT_CHARS,
  splitOutputBudget,
  type RunCommandToolOptions,
} from './index.js'
import { createFixture, runTool, toolContext, type Fixture } from './testing/fixture.js'

let fx: Fixture
beforeEach(async () => {
  fx = await createFixture()
})
afterEach(() => fx.dispose())

const bash: ShellInfo = { kind: 'bash', exe: '/bin/bash' }

const result = (overrides: Partial<RunCommandResult> = {}): RunCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  aborted: false,
  timedOut: false,
  durationMs: 1234,
  ...overrides,
})

/** 假的执行：按给出的输出调用回调，返回给定结果。 */
function fakeRun(
  output: { stdout?: string[]; stderr?: string[] },
  outcome: Partial<RunCommandResult> = {},
  seen: { options?: RunCommandOptions; command?: string } = {},
): typeof runCommand {
  return async (_shell, command, options) => {
    seen.options = options
    seen.command = command
    for (const chunk of output.stdout ?? []) options.onStdout?.(chunk)
    for (const chunk of output.stderr ?? []) options.onStderr?.(chunk)
    return result(outcome)
  }
}

const tool = (options: Partial<RunCommandToolOptions> = {}) =>
  createRunCommandTool({ shell: bash, ...options })

const exec = (
  options: Partial<RunCommandToolOptions>,
  input: { command: string; timeoutSeconds?: number },
  ctx: ToolContext = toolContext(fx.root),
) => runTool(tool(options), input, ctx)

describe('HeadTailBuffer', () => {
  it('未超出时原样输出；超出时保留开头与结尾并注明省略的字符数', () => {
    const small = new HeadTailBuffer(10)
    small.push('abc')
    small.push('def')
    expect(small.render()).toBe('abcdef')
    expect(small.length).toBe(6)

    const big = new HeadTailBuffer(10)
    for (const c of 'abcdefghijklmnopqrstuvwxyz') big.push(c)
    expect(big.render()).toBe('abcde\n[... 16 characters omitted ...]\nvwxyz')
    expect(big.render(4)).toBe('ab\n[... 22 characters omitted ...]\nyz')

    const once = new HeadTailBuffer(10)
    once.push('abcdefghijklmnopqrstuvwxyz')
    expect(once.render()).toBe('abcde\n[... 16 characters omitted ...]\nvwxyz')
  })

  it('不在代理对中间切开；开头满了以后的输出不再进入开头', () => {
    const buffer = new HeadTailBuffer(6)
    buffer.push('ab😀😀😀😀')
    expect(buffer.render()).toBe('ab\n[... 6 characters omitted ...]\n😀')
    expect(buffer.render()).not.toContain('�')
    const later = new HeadTailBuffer(6)
    later.push('ab😀')
    later.push('c')
    expect(later.render()).toBe('ab😀c')
  })
})

describe('OutputChunkBuffer', () => {
  it('未超出时按顺序合并相邻的同一输出流', () => {
    const buffer = new OutputChunkBuffer(100)
    buffer.push('stdout', 'a')
    buffer.push('stdout', 'b')
    buffer.push('stderr', 'c')
    buffer.push('stdout', '')
    buffer.push('stdout', 'd')
    expect(buffer.display()).toEqual({
      chunks: [
        { stream: 'stdout', text: 'ab' },
        { stream: 'stderr', text: 'c' },
        { stream: 'stdout', text: 'd' },
      ],
      omittedChars: 0,
    })
  })

  it('超出时保留开头与结尾，结尾从换行之后开始', () => {
    const buffer = new OutputChunkBuffer(20)
    buffer.push('stdout', 'head-line\n')
    buffer.push('stderr', 'x'.repeat(50))
    buffer.push('stdout', 'abc\nlast-one\n')
    const display = buffer.display()
    expect(display.chunks).toEqual([
      { stream: 'stdout', text: 'head-line\n' },
      { stream: 'stdout', text: 'last-one\n' },
    ])
    expect(display.omittedAt).toBe(1)
    expect(display.omittedChars).toBe(10 + 50 + 13 - 10 - 9)
  })

  it('结尾裁剪跨多段；结尾整段是半行时去掉', () => {
    const buffer = new OutputChunkBuffer(10)
    buffer.push('stdout', '12345')
    for (let i = 0; i < 10; i++) buffer.push(i % 2 ? 'stderr' : 'stdout', 'abcd')
    buffer.push('stdout', 'xy\n')
    const display = buffer.display()
    expect(display.chunks[0]).toEqual({ stream: 'stdout', text: '12345' })
    expect(display.chunks).toHaveLength(1)
    expect(display.omittedAt).toBe(1)
  })
})

describe('splitOutputBudget', () => {
  it('未超出时各自全部；都超出时 stderr 至少占四分之一；一方不足时余量给另一方', () => {
    expect(splitOutputBudget(10, 10, 100)).toEqual({ stdout: 10, stderr: 10 })
    expect(splitOutputBudget(1000, 1000, 100)).toEqual({ stdout: 75, stderr: 25 })
    expect(splitOutputBudget(1000, 10, 100)).toEqual({ stdout: 90, stderr: 10 })
    expect(splitOutputBudget(10, 1000, 100)).toEqual({ stdout: 10, stderr: 90 })
  })
})

describe('run_command', () => {
  it('定义：说明中写明 shell；参数校验；注册', () => {
    const registry = createToolRegistry()
    registerExecuteTools(registry, {
      shell: { kind: 'powershell', exe: 'powershell.exe', version: '5.1.26100.1' },
    })
    const definition = registry.get('run_command')!
    expect(definition).toMatchObject({ category: 'execute', trust: 'builtin' })
    expect(definition.description).toContain('Windows PowerShell 5.1.26100.1')
    expect(registry.validate('run_command', { command: 'ls' }).ok).toBe(true)
    expect(registry.validate('run_command', { command: '  ' }).ok).toBe(false)
    expect(registry.validate('run_command', { command: 'ls', timeoutSeconds: 0 }).ok).toBe(false)
    expect(registry.validate('run_command', { command: 'ls', timeoutSeconds: 601 }).ok).toBe(false)
    expect(registry.validate('run_command', { command: 'ls', cwd: '/' }).ok).toBe(false)
  })

  it('规范化给出命令；审批预览', async () => {
    const definition = tool()
    const ctx = toolContext(fx.root)
    expect(await definition.normalize!({ command: 'npm test' }, ctx)).toEqual({
      input: { command: 'npm test' },
      targets: { command: 'npm test' },
    })
    expect(await definition.describeForApproval!({ command: 'npm test' }, ctx)).toEqual({
      summary: 'Run a bash command in the workspace',
      command: 'npm test',
    })
  })

  it('执行选项：工作区根目录、超时、取消信号、不在结果中汇总输出', async () => {
    const seen: { options?: RunCommandOptions; command?: string } = {}
    const signal = new AbortController().signal
    await exec(
      { run: fakeRun({}, {}, seen), env: { A: '1' }, tempDir: '/tmp/x' },
      { command: 'echo hi', timeoutSeconds: 5 },
      toolContext(fx.root, signal),
    )
    expect(seen.command).toBe('echo hi')
    expect(seen.options).toMatchObject({
      cwd: fx.root,
      timeoutMs: 5000,
      signal,
      collectOutput: false,
      env: { A: '1' },
      tempDir: '/tmp/x',
    })
    await exec({ run: fakeRun({}, {}, seen) }, { command: 'echo hi' })
    expect(seen.options?.timeoutMs).toBe(120_000)
    expect(seen.options).not.toHaveProperty('env')
    expect(seen.options).not.toHaveProperty('tempDir')
  })

  it('输出：退出码、耗时、stdout 与 stderr 分开；流式推送', async () => {
    const progress: [string, string | undefined][] = []
    const ctx = {
      ...toolContext(fx.root),
      progress: (t: string, s?: 'stdout' | 'stderr') => progress.push([t, s]),
    }
    const text = await exec(
      { run: fakeRun({ stdout: ['a\n', 'b\n'], stderr: ['warn\n'] }, { exitCode: 2 }) },
      { command: 'x' },
      ctx,
    )
    expect(text).toBe('Exit code: 2\nDuration: 1.2 s\n\nstdout:\na\nb\n\nstderr:\nwarn')
    expect(progress).toEqual([
      ['a\n', 'stdout'],
      ['b\n', 'stdout'],
      ['warn\n', 'stderr'],
    ])
    expect(await exec({ run: fakeRun({}) }, { command: 'x' })).toBe(
      'Exit code: 0\nDuration: 1.2 s\n\n(no output)',
    )
    expect(await exec({ run: fakeRun({ stderr: ['e'] }) }, { command: 'x' })).toBe(
      'Exit code: 0\nDuration: 1.2 s\n\nstderr:\ne',
    )
  })

  it('取消、信号结束', async () => {
    expect(
      await exec({ run: fakeRun({}, { aborted: true, exitCode: null }) }, { command: 'x' }),
    ).toContain('Cancelled; the command and its child processes were terminated.')
    expect(
      await exec({ run: fakeRun({}, { exitCode: null, signal: 'SIGSEGV' }) }, { command: 'x' }),
    ).toContain('Terminated by signal SIGSEGV.')
    expect(await exec({ run: fakeRun({}, { exitCode: null }) }, { command: 'x' })).toContain(
      'Terminated by signal unknown.',
    )
  })

  it('超时：长时间没有输出时提示可能在等待输入', async () => {
    const quiet = await exec(
      { run: fakeRun({}, { timedOut: true, exitCode: null }), idleHintMs: 0 },
      { command: 'x', timeoutSeconds: 3 },
    )
    expect(quiet).toContain(
      'Timed out after 3 s; the command and its child processes were terminated.',
    )
    expect(quiet).toContain('may have been waiting for input')
    const busy = await exec(
      { run: fakeRun({ stdout: ['x'] }, { timedOut: true, exitCode: null }) },
      { command: 'x' },
    )
    expect(busy).toContain('Timed out after 120 s')
    expect(busy).not.toContain('waiting for input')
  })

  it('长输出：按预算截断，两段共享上限', async () => {
    const long = 'x'.repeat(RUN_COMMAND_MAX_OUTPUT_CHARS * 3)
    const text = await exec({ run: fakeRun({ stdout: [long] }) }, { command: 'x' })
    expect(text).toContain(`[... ${RUN_COMMAND_MAX_OUTPUT_CHARS * 2} characters omitted ...]`)
    expect(text.length).toBeLessThan(RUN_COMMAND_MAX_OUTPUT_CHARS + 200)

    const both = await exec(
      {
        run: fakeRun({ stdout: ['o'.repeat(1000)], stderr: ['e'.repeat(1000)] }),
        maxOutputChars: 100,
      },
      { command: 'x' },
    )
    expect(both).toContain('[... 925 characters omitted ...]')
    expect(both).toContain('[... 975 characters omitted ...]')
  })

  it('超过上下文给出的 token 上限时按比例缩小（中文输出，M1-13a）', async () => {
    const text = await exec(
      { run: fakeRun({ stdout: ['中文输出'.repeat(5000)] }) },
      { command: 'x' },
      { ...toolContext(fx.root), maxOutputTokens: 400 },
    )
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
    expect(estimateTokens(text)).toBeGreaterThan(200)
    expect(text).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/)
    expect(text).toContain('Exit code: 0')
  })

  it('交给模型的输出去掉 ANSI；display 保留原始输出与执行信息（M2-06）', async () => {
    const progress: string[] = []
    const ctx = { ...toolContext(fx.root), progress: (t: string) => progress.push(t) }
    const definition = tool({
      run: fakeRun(
        { stdout: ['\x1b[32m✓\x1b[0m ok\n', '50%\r100%\n\x1b[3'], stderr: ['1mwarn\x1b[0m'] },
        { exitCode: 1, durationMs: 1234.6 },
      ),
    })
    const output = await definition.execute({ command: 'x' }, ctx)
    const text = output.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    expect(text).not.toContain('\x1b')
    expect(text).toContain('stdout:\n✓ ok\n100%')
    expect(text).toContain('stderr:\n1mwarn')
    expect(progress[0]).toBe('\x1b[32m✓\x1b[0m ok\n')
    expect(output.display).toEqual({
      kind: 'terminal',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      durationMs: 1235,
      shell: 'bash',
      cwd: fx.root,
      chunks: [
        { stream: 'stdout', text: '\x1b[32m✓\x1b[0m ok\n50%\r100%\n\x1b[3' },
        { stream: 'stderr', text: '1mwarn\x1b[0m' },
      ],
      omittedChars: 0,
    })
    const signalled = await tool({
      run: fakeRun({}, { exitCode: null, signal: 'SIGKILL', timedOut: true }),
    }).execute({ command: 'x' }, toolContext(fx.root))
    expect(signalled.display).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true })
  })

  it('启动失败转为工具错误；其他错误原样抛出', async () => {
    const spawnFailed: typeof runCommand = () =>
      Promise.reject(
        new ShellError('shell.spawn_failed', 'Cannot start x (ENOENT).', { shell: 'x' }),
      )
    const error = await exec({ run: spawnFailed }, { command: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ToolError)
    expect(error).toMatchObject({ code: 'shell.spawn_failed', params: { shell: 'x' } })
    const boom = new Error('boom')
    await expect(exec({ run: () => Promise.reject(boom) }, { command: 'x' })).rejects.toBe(boom)
  })
})

describe('命令沙箱（M5-04）', () => {
  const policy: SandboxPolicy = { profile: 'workspace-write', network: 'none' }
  const execution: SandboxExecution = {
    profile: 'workspace-write',
    network: 'none',
    mechanism: 'restricted-token',
    enforced: true,
    networkIsolated: false,
  }
  const runner: SandboxRunner = {
    capability: {
      available: true,
      supported: true,
      mechanism: 'restricted-token',
      networkIsolated: false,
      checks: {
        restrictedToken: true,
        lowIntegrity: true,
        jobObject: true,
        appContainer: false,
      },
    },
    executionFor: () => execution,
    run: async () => {
      throw new Error('not used')
    },
  }

  it('passes the sandbox to the runner and records the actual execution', async () => {
    const seen: { options?: RunCommandOptions } = {}
    const definition = tool({
      sandbox: { policy, runner },
      run: fakeRun({ stdout: ['ok\n'] }, { sandbox: execution }, seen),
    })
    expect(definition.sandbox).toEqual(execution)
    const output = await definition.execute({ command: 'x' }, toolContext(fx.root))
    expect(seen.options?.sandbox).toEqual({ policy, runner })
    expect(output.display).toMatchObject({ kind: 'terminal', sandbox: execution })
  })

  it('declares an unsandboxed execution when no runner is available', async () => {
    const execution = {
      profile: 'workspace-write',
      network: 'none',
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: 'sandbox.unavailable',
    } satisfies SandboxExecution
    const definition = tool({ run: fakeRun({}), execution })
    expect(definition.sandbox).toEqual(execution)
    const output = await definition.execute({ command: 'x' }, toolContext(fx.root))
    expect(output.display).not.toHaveProperty('sandbox')
  })

  it('maps sandbox setup failures to tool errors', async () => {
    const failing: typeof runCommand = () =>
      Promise.reject(new SandboxError('sandbox.setup_failed', 'no token', { win32: '5' }))
    const error = await exec({ run: failing }, { command: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ToolError)
    expect(error).toMatchObject({ code: 'sandbox.setup_failed', params: { win32: '5' } })
  })
})

describe('真实执行（当前平台选出的 shell）', async () => {
  const shell = await selectShell()
  const real = (command: string, options: Partial<RunCommandToolOptions> = {}) =>
    runTool(createRunCommandTool({ shell, ...options }), { command }, toolContext(fx.root))

  it('在工作区根目录执行，输出与退出码交回模型', async () => {
    const text = await real(
      shell.kind === 'cmd'
        ? 'cd'
        : shell.kind.includes('powershell') || shell.kind === 'pwsh'
          ? '(Get-Location).Path'
          : 'pwd',
    )
    expect(text).toMatch(/^Exit code: 0\n/)
    expect(text.toLowerCase()).toContain(fx.root.toLowerCase())
    expect(await real('exit 3')).toMatch(/^Exit code: 3\n/)
  })

  it('取消信号结束命令', async () => {
    const controller = new AbortController()
    const progress = vi.fn(() => controller.abort())
    const ctx = { ...toolContext(fx.root, controller.signal), progress }
    const sleep =
      shell.kind === 'cmd'
        ? 'echo start & ping -n 30 127.0.0.1 >nul'
        : shell.kind === 'pwsh' || shell.kind === 'powershell'
          ? 'Write-Output start; Start-Sleep -Seconds 30'
          : 'echo start; sleep 30'
    const text = await runTool(createRunCommandTool({ shell }), { command: sleep }, ctx)
    expect(text).toContain('Cancelled')
    expect(progress).toHaveBeenCalled()
  }, 30_000)
})
