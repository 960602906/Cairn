/**
 * 真实执行（M1-09a、M1-09b）。Windows 上把 S7 的检查项移植为测试，对 Windows PowerShell 5.1 与 PowerShell 7（如已安装、
 * 非商店版）分别运行，包括 Job Object 结束进程树；cmd 另有基本检查；其他平台覆盖 bash 与进程组。
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createProcessTree,
  DEFAULT_COMMAND_TIMEOUT_MS,
  defaultShellProbe,
  isPackagedPath,
  runCommand,
  SandboxError,
  ShellError,
  windowsCandidates,
  type RunCommandOptions,
  type SandboxExecution,
  type SandboxPolicy,
  type SandboxRunner,
  type ShellInfo,
} from './index.js'

const isWindows = process.platform === 'win32'
const clean = (s: string) => s.replace(/\r\n/g, '\n').trim()

let work: string
beforeAll(() => {
  // native：展开 Windows 的 8.3 短路径（如 RUNNER~1），与 shell 报告的路径一致
  work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'cairn-shell-')))
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** 每次运行用独立的子目录。 */
const freshDir = () => realpathSync.native(mkdtempSync(path.join(work, 'case-')))
const readdir = () => readdirSync(work)

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 等待进程结束（最多约 3 秒），返回是否已结束。 */
async function exited(pid: number) {
  for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  return !isAlive(pid)
}

const pids = (out: string) => out.split('\n').map((line) => Number(line.trim()))

async function run(shell: ShellInfo, command: string, options: Partial<RunCommandOptions> = {}) {
  const cwd = options.cwd ?? freshDir()
  const result = await runCommand(shell, command, { cwd, tempDir: work, ...options })
  return { ...result, out: clean(result.stdout), err: clean(result.stderr), cwd }
}

/** Windows 上可用的 PowerShell（非商店版）。 */
async function findPowerShell(kind: 'pwsh' | 'powershell'): Promise<ShellInfo | undefined> {
  if (!isWindows) return undefined
  for (const exe of windowsCandidates(process.env)[kind]) {
    const probed = await defaultShellProbe(exe, kind)
    if (probed && !isPackagedPath(probed.path ?? exe)) {
      return {
        kind,
        exe: probed.path ?? exe,
        ...(probed.version ? { version: probed.version } : {}),
      }
    }
  }
  return undefined
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
const node = (code: string) => `& ${psQuote(process.execPath)} -e ${psQuote(code)}`
const SPECIAL = '单引号 \' 双引号 " $env:PATH `反引号 & | ; % ^ < > \t制表 😀 ✓'

const found = await Promise.all([findPowerShell('powershell'), findPowerShell('pwsh')])
const powershells = found.flatMap((s) => (s ? [s] : []))

for (const shell of powershells) {
  describe(`${shell.kind} ${shell.version}（S7 检查项）`, () => {
    it('中文输出：字面量、Write-Host、原生程序、cmd', async () => {
      expect((await run(shell, "Write-Output '中文输出：你好，世界 ✓ 😀'")).out).toBe(
        '中文输出：你好，世界 ✓ 😀',
      )
      expect((await run(shell, "Write-Host '主机输出：中文'")).out).toBe('主机输出：中文')
      expect((await run(shell, node("process.stdout.write('原生程序：中文\\n')"))).out).toBe(
        '原生程序：中文',
      )
      expect((await run(shell, "& cmd.exe /d /c 'echo cmd 输出：中文'")).out).toBe('cmd 输出：中文')
    })

    it('错误流：Write-Error 与原生 stderr 走 stderr，无 CLIXML 与颜色控制符；顺序不影响 stdout', async () => {
      const written = await run(shell, "Write-Error '错误：中文'")
      expect(written.err).toContain('错误：中文')
      expect(written.err).not.toContain('CLIXML')
      expect(written.err).not.toContain('\x1b')
      const native = await run(shell, node("process.stderr.write('原生错误：中文\\n')"))
      expect(native.err).toBe('原生错误：中文')
      expect(native.out).toBe('')
      const order = await run(shell, "Write-Output '一'\nWrite-Error '二'\nWrite-Output '三'")
      expect(order.out).toBe('一\n三')
      expect(order.err).toContain('二')
      const progress = await run(
        shell,
        "1..3 | ForEach-Object { Write-Progress -Activity '进度' -PercentComplete ($_ * 30); Start-Sleep -Milliseconds 20 }\nWrite-Output 'done'",
      )
      expect(progress.out).toBe('done')
      expect(progress.err).not.toContain('CLIXML')
    })

    it('throw 与语法错误：写入 stderr，退出码非 0', async () => {
      const thrown = await run(
        shell,
        "Write-Output '之前'\nthrow '抛出：中文'\nWrite-Output '之后'",
      )
      expect(thrown).toMatchObject({ exitCode: 1, out: '之前' })
      expect(thrown.err).toContain('抛出：中文')
      expect(thrown.err).not.toContain('CLIXML')
      const syntax = await run(shell, "Write-Output '开始'\nif ( { '语法错误：中文'")
      expect(syntax.err).toContain('语法错误：中文')
      expect(syntax.exitCode).not.toBe(0)
    })

    it('文件：读取无 BOM 的 UTF-8；> 写出的不是 UTF-16；中文目录名', async () => {
      const cwd = freshDir()
      writeFileSync(path.join(cwd, 'utf8.txt'), '文件内容：中文\n')
      expect((await run(shell, 'Get-Content utf8.txt', { cwd })).out).toBe('文件内容：中文')
      await run(shell, "'写入：中文' > out.txt", { cwd })
      const bytes = readFileSync(path.join(cwd, 'out.txt'))
      expect(bytes[0] === 0xff && bytes[1] === 0xfe).toBe(false)
      expect(
        bytes
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trim(),
      ).toBe('写入：中文')
      expect(
        (
          await run(
            shell,
            "New-Item -ItemType Directory '中文目录' | Out-Null\n(Get-ChildItem -Directory).Name",
            { cwd },
          )
        ).out,
      ).toBe('中文目录')
    })

    it('参数与特殊字符原样传入', async () => {
      expect(
        (await run(shell, `${node('console.log(process.argv[1])')} '参数：中文 空格'`)).out,
      ).toBe('参数：中文 空格')
      expect((await run(shell, `Write-Output @'\n${SPECIAL}\n'@`)).out).toBe(SPECIAL)
    })

    it('退出码：exit 7、最后一条原生命令失败、失败后又成功', async () => {
      expect((await run(shell, 'exit 7')).exitCode).toBe(7)
      expect((await run(shell, node('process.exit(3)'))).exitCode).toBe(3)
      expect(
        (await run(shell, `${node('process.exit(3)')}\n${node('process.exit(0)')}`)).exitCode,
      ).toBe(0)
      expect((await run(shell, "Write-Output 'ok'")).exitCode).toBe(0)
    })

    it('Read-Host 不挂起（不支持交互）', async () => {
      const result = await run(shell, "Read-Host '请输入'\nWrite-Output '之后'")
      expect(result.durationMs).toBeLessThan(15_000)
    }, 20_000)

    it('长命令改用临时 .ps1：内容、错误流与退出码不变，结束后删除', async () => {
      const text = '中'.repeat(4_000)
      const result = await run(shell, `Write-Output '${text}'\nWrite-Error '长脚本错误'\nexit 5`)
      expect(result).toMatchObject({ out: text, exitCode: 5 })
      expect(result.err).toContain('长脚本错误')
      expect(readdir().filter((f) => f.endsWith('.ps1'))).toEqual([])
    })

    it('工作目录', async () => {
      const result = await run(shell, '(Get-Location).Path')
      expect(result.out.toLowerCase()).toBe(result.cwd.toLowerCase())
    })

    it('环境变量清洗：密钥与内部变量不传入，PYTHONUTF8=1', async () => {
      const result = await run(
        shell,
        'Write-Output "[$env:PYTHONUTF8][$env:MY_API_KEY][$env:CAIRN_RUNTIME][$env:KEEP_ME]"',
        { env: { ...process.env, MY_API_KEY: 'k', CAIRN_RUNTIME: 'pi', KEEP_ME: '值' } },
      )
      expect(result.out).toBe('[1][][][值]')
    })

    const startHidden = (file: string, args: string) =>
      `(Start-Process -FilePath ${file} -ArgumentList ${args} -PassThru -WindowStyle Hidden).Id`
    const backgroundPing = startHidden('ping.exe', "'-n','60','127.0.0.1'")
    const backgroundCmd = startHidden('cmd.exe', "'/c','ping -n 60 127.0.0.1 >nul'")

    it('超时：Job Object 结束整个进程树（含 Start-Process 启动的进程）', async () => {
      const result = await run(
        shell,
        `${backgroundPing}\n${backgroundCmd}\nStart-Sleep -Seconds 60`,
        {
          timeoutMs: 8_000,
        },
      )
      expect(result).toMatchObject({
        timedOut: true,
        aborted: false,
        exitCode: 1,
        processTree: 'job-object',
      })
      expect(result.durationMs).toBeLessThan(20_000)
      for (const pid of pids(result.out)) expect(await exited(pid)).toBe(true)
    }, 30_000)

    it('命令结束时残留的后台进程随之结束；取消', async () => {
      const result = await run(shell, backgroundPing)
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, processTree: 'job-object' })
      expect(await exited(pids(result.out)[0]!)).toBe(true)

      const controller = new AbortController()
      const pending = run(shell, `${backgroundPing}\nStart-Sleep -Seconds 60`, {
        signal: controller.signal,
        onStdout: () => controller.abort(),
      })
      const aborted = await pending
      expect(aborted).toMatchObject({ aborted: true, timedOut: false, exitCode: 1 })
      expect(await exited(pids(aborted.out)[0]!)).toBe(true)
    }, 30_000)

    it('作业对象不可用时回退到 taskkill /T /F', async () => {
      const result = await run(shell, `${backgroundPing}\nStart-Sleep -Seconds 60`, {
        timeoutMs: 8_000,
        processTree: () => createProcessTree({ kernel32: undefined }),
      })
      expect(result).toMatchObject({ timedOut: true, processTree: 'taskkill' })
      expect(await exited(pids(result.out)[0]!)).toBe(true)
    }, 30_000)
  })
}

describe.runIf(isWindows)('cmd', () => {
  const cmd: ShellInfo = { kind: 'cmd', exe: windowsCandidates(process.env).cmd[0]! }
  it('中文输出、引号、退出码', async () => {
    expect((await run(cmd, 'echo cmd 输出：中文')).out).toBe('cmd 输出：中文')
    expect((await run(cmd, 'echo "a b" & echo c')).out).toBe('"a b" \nc')
    expect(
      (
        await run(cmd, 'echo "x & y" ^& !z! %CMD_TEST%', {
          env: { ...process.env, CMD_TEST: '值' },
        })
      ).out,
    ).toBe('"x & y" & !z! 值')
    expect((await run(cmd, 'echo 中文目录> 中.txt & type 中.txt')).out).toBe('中文目录')
    expect((await run(cmd, 'exit /b 3')).exitCode).toBe(3)
  })
})

describe.runIf(!isWindows)('bash', () => {
  const bash: ShellInfo = { kind: 'bash', exe: '/bin/bash' }

  it('UTF-8 输出、stderr 分开、退出码、工作目录', async () => {
    const result = await run(bash, "printf '中文输出 😀\\n'; echo '错误：中文' >&2; pwd; exit 7")
    expect(result).toMatchObject({ exitCode: 7, signal: null, aborted: false, err: '错误：中文' })
    expect(result.out).toBe(`中文输出 😀\n${result.cwd}`)
  })

  it('特殊字符原样传入；标准输入已关闭（read 不挂起）；环境变量', async () => {
    const special = '单引号 \' 双引号 " $HOME `反引号` & | ; % ^ < > \t 😀'
    expect((await run(bash, `cat <<'EOF'\n${special}\nEOF`)).out).toBe(special)
    expect((await run(bash, 'read x; echo "got:$x"')).out).toBe('got:')
    expect((await run(bash, 'echo "$SHELL_TEST_VAR"', { env: { SHELL_TEST_VAR: '值' } })).out).toBe(
      '值',
    )
  })

  it('环境变量清洗：密钥与内部变量不传入，PYTHONUTF8=1', async () => {
    const env = { ...process.env, MY_API_KEY: 'k', CAIRN_RUNTIME: 'pi', KEEP_ME: '值' }
    const result = await run(bash, 'echo "[$PYTHONUTF8][$MY_API_KEY][$CAIRN_RUNTIME][$KEEP_ME]"', {
      env,
    })
    expect(result.out).toBe('[1][][][值]')
  })

  it('流式输出：多字节字符跨块时不被拆开', async () => {
    const chunks: string[] = []
    const errors: string[] = []
    const result = await run(
      bash,
      "printf '\\xe4'; sleep 0.1; printf '\\xb8\\xad\\n'; printf '\\xe6\\x96' >&2; sleep 0.1; printf '\\x87' >&2",
      { onStdout: (t) => chunks.push(t), onStderr: (t) => errors.push(t) },
    )
    expect(result.out).toBe('中')
    expect(result.err).toBe('文')
    expect(chunks.join('')).toBe('中\n')
    expect(errors.join('')).toBe('文')
    expect([...chunks, ...errors].join('')).not.toContain('�')
    // 结尾是不完整的字节时，结束时给出替换字符
    const tail: string[] = []
    expect((await run(bash, "printf 'a\\xe4'", { onStdout: (t) => tail.push(t) })).out).toBe('a�')
    expect(tail.join('')).toBe('a�')
  })

  it('取消时结束进程；已取消时不启动', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await run(bash, 'sleep 10', { signal: controller.signal })
    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
      signal: 'SIGKILL',
      processTree: 'process-group',
    })
    expect(result.durationMs).toBeLessThan(5_000)
    expect(await run(bash, 'echo no', { signal: AbortSignal.abort() })).toMatchObject({
      aborted: true,
      out: '',
      durationMs: 0,
    })
  })

  it('超时：结束整个进程组（含后台进程与子孙进程）', async () => {
    const result = await run(
      bash,
      'sleep 30 & echo $!; (sleep 30; echo late) & echo $!; sleep 30',
      { timeoutMs: 300 },
    )
    expect(result).toMatchObject({
      timedOut: true,
      aborted: false,
      exitCode: null,
      signal: 'SIGKILL',
    })
    expect(result.durationMs).toBeLessThan(5_000)
    for (const pid of pids(result.out)) expect(await exited(pid)).toBe(true)
  })

  it('命令结束时残留的后台进程随之结束，不等待它们持有的输出管道', async () => {
    const result = await run(bash, 'sleep 30 & echo $!')
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
    expect(result.durationMs).toBeLessThan(5_000)
    expect(await exited(pids(result.out)[0]!)).toBe(true)
  })

  it('collectOutput 为 false 时结果中不汇总输出，回调照常', async () => {
    const chunks: string[] = []
    const result = await run(bash, 'echo out; echo err >&2', {
      collectOutput: false,
      onStdout: (t) => chunks.push(t),
      onStderr: (t) => chunks.push(t),
    })
    expect(result).toMatchObject({ out: '', err: '', exitCode: 0 })
    expect(chunks.sort()).toEqual(['err\n', 'out\n'])
  })

  it('timeoutMs 为 0 时不限时', async () => {
    expect(await run(bash, 'sleep 0.2; echo done', { timeoutMs: 0 })).toMatchObject({
      out: 'done',
      timedOut: false,
    })
  })

  it('长命令直接传入（只有 PowerShell 需要临时脚本）', async () => {
    const text = 'a'.repeat(50_000)
    expect((await run(bash, `echo ${text}`, { maxCommandLineChars: 10 })).out).toBe(text)
  })
})

describe('启动失败', () => {
  it('可执行文件或工作目录不存在时报 shell.spawn_failed', async () => {
    const missing: ShellInfo = { kind: 'sh', exe: path.join(work, 'no-such-shell') }
    const error = await runCommand(missing, 'echo', { cwd: work }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ShellError)
    expect(error).toMatchObject({ code: 'shell.spawn_failed', params: { shell: missing.exe } })
    expect((error as Error).message).toContain('ENOENT')
    const shell: ShellInfo = isWindows
      ? { kind: 'cmd', exe: windowsCandidates(process.env).cmd[0]! }
      : { kind: 'sh', exe: '/bin/sh' }
    await expect(
      runCommand(shell, 'echo', { cwd: path.join(work, 'no-such-dir') }),
    ).rejects.toMatchObject({ code: 'shell.spawn_failed' })
  })
})

describe('命令沙箱接入（M5-04）', () => {
  const policy: SandboxPolicy = { profile: 'workspace-write', network: 'none' }
  const execution: SandboxExecution = {
    profile: 'workspace-write',
    network: 'none',
    mechanism: 'restricted-token',
    enforced: true,
    networkIsolated: false,
  }
  const sandbox = (overrides: Partial<Awaited<ReturnType<SandboxRunner['run']>>> = {}) => {
    const run = vi.fn<SandboxRunner['run']>(async (_policy, input) => {
      input.onStdout?.('out')
      input.onStderr?.('err')
      return {
        exitCode: 3,
        aborted: false,
        timedOut: false,
        durationMs: 5,
        execution,
        ...overrides,
      }
    })
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
      run,
    }
    return { runner, run }
  }
  const shell: ShellInfo = isWindows
    ? { kind: 'cmd', exe: windowsCandidates(process.env).cmd[0]! }
    : { kind: 'bash', exe: '/bin/bash' }

  it('runs through the sandbox runner and keeps the output contract', async () => {
    const fake = sandbox()
    const progress: string[] = []
    const result = await runCommand(shell, 'echo hi', {
      cwd: work,
      sandbox: { runner: fake.runner, policy },
      onStdout: (text) => progress.push(text),
    })
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      aborted: false,
      timedOut: false,
      sandbox: execution,
    })
    expect(progress).toEqual(['out'])
    expect(fake.run).toHaveBeenCalledWith(
      policy,
      expect.objectContaining({
        cwd: work,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        env: expect.any(Object),
      }),
    )
  })

  it('streams without collecting output when asked', async () => {
    const fake = sandbox()
    const progress: string[] = []
    const result = await runCommand(shell, 'echo hi', {
      cwd: work,
      collectOutput: false,
      timeoutMs: 0,
      sandbox: { runner: fake.runner, policy },
      onStdout: (text) => progress.push(text),
    })
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(progress).toEqual(['out'])
    expect(fake.run).toHaveBeenCalledWith(policy, expect.objectContaining({ timeoutMs: 0 }))
  })

  it('forwards a live abort signal to the runner', async () => {
    const fake = sandbox()
    const controller = new AbortController()
    await runCommand(shell, 'echo hi', {
      cwd: work,
      signal: controller.signal,
      sandbox: { runner: fake.runner, policy },
    })
    expect(fake.run).toHaveBeenCalledWith(
      policy,
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('writes an over-long PowerShell command to the system temp directory', async () => {
    const fake = sandbox()
    const result = await runCommand(
      { kind: 'powershell', exe: 'powershell.exe' },
      `Write-Output '${'x'.repeat(20_000)}'`,
      { cwd: work, sandbox: { runner: fake.runner, policy } },
    )
    expect(result.exitCode).toBe(3)
    const input = fake.run.mock.calls[0]![1]
    expect(input.invocation.tempScript?.path.startsWith(tmpdir())).toBe(true)
  })

  it('returns cancellation without starting the runner', async () => {
    const fake = sandbox()
    const result = await runCommand(shell, 'echo hi', {
      cwd: work,
      signal: AbortSignal.abort(),
      sandbox: { runner: fake.runner, policy },
    })
    expect(result).toMatchObject({
      aborted: true,
      exitCode: null,
      durationMs: 0,
      sandbox: { mechanism: 'none', enforced: false, reason: 'sandbox.cancelled' },
    })
    expect(fake.run).not.toHaveBeenCalled()
  })

  it('propagates sandbox failures', async () => {
    const fake = sandbox()
    fake.run.mockRejectedValueOnce(new SandboxError('sandbox.setup_failed', 'no token'))
    await expect(
      runCommand(shell, 'echo hi', { cwd: work, sandbox: { runner: fake.runner, policy } }),
    ).rejects.toMatchObject({ code: 'sandbox.setup_failed' })
  })

  it('leaves danger-full-access outside the sandbox and records it', async () => {
    const fake = sandbox()
    const result = await runCommand(shell, 'echo hi', {
      cwd: work,
      timeoutMs: 0,
      sandbox: { runner: fake.runner, policy: { profile: 'danger-full-access', network: 'none' } },
    })
    expect(fake.run).not.toHaveBeenCalled()
    expect(result.stdout.toLowerCase()).toContain('hi')
    expect(result.sandbox).toEqual({
      profile: 'danger-full-access',
      network: 'none',
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: 'sandbox.full_access',
    })
  })
})
