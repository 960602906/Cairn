/**
 * Windows 命令沙箱执行器（M5-04，ADR-0034）。
 *
 * 默认（`restricted-token`）：
 * - `CreateRestrictedToken`（禁用最大权限 + LUA）并设为低完整性；
 * - 工作区按档位设置完整性标签（可写为 Low，只读为 Medium）；
 * - 专用临时目录为 Low，输出先写入其中的文件，再增量读取为文本；
 * - 启动后立即放入 Job Object，超时/取消/结束都结束整个进程树。
 *
 * `appcontainer` 是实验档位：经 SECURITY_CAPABILITIES 启动，工作区由 ACL 授权；网络按策略授予能力。
 * 受限令牌档位不能隔离网络，`networkIsolated` 如实为 false。
 *
 * 任何一步失败都抛出 `SandboxError`，由调用方失败关闭；这里不静默回退到无沙箱执行。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { JobObject } from '../job-object.js'
import { createContainerAcl, networkCapabilities, type ContainerAcl } from './appcontainer.js'
import { buildEnvironmentBlock, buildWindowsCommandLine } from './command-line.js'
import { createIntegrityController, type IntegrityController } from './integrity.js'
import { createSandboxJob, type SandboxJobFactory } from './job.js'
import { probeCapability } from './probe.js'
import {
  SandboxError,
  SandboxErrorCode,
  sandboxExecution,
  type SandboxCapability,
  type SandboxExecution,
  type SandboxMechanism,
  type SandboxPolicy,
  type SandboxRunInput,
  type SandboxRunResult,
  type SandboxRunner,
} from './types.js'
import { loadSandboxNativeApi, type SandboxNativeApi } from './windows-api.js'

export interface SandboxRunnerOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly mechanism?: Exclude<SandboxMechanism, 'none'>
  /** AppContainer 配置名（仅实验档位）；工作区 ACL 由调用方（主进程）授予。 */
  readonly appContainer?: { readonly name: string }
  /** undefined：按平台加载；null：视为不可用（测试用）。 */
  readonly api?: SandboxNativeApi | null
  readonly integrity?: IntegrityController
  readonly acl?: ContainerAcl
  readonly jobFactory?: SandboxJobFactory
  readonly tempRoot?: string
  readonly pollIntervalMs?: number
  /** 结束后等待进程真正退出的上限，默认 5 秒（测试可缩短）。 */
  readonly terminateGraceMs?: number
  /** 命令结束后多久把工作区恢复中完整性，默认 5 秒（`0` 表示立即；测试可缩短）。 */
  readonly restoreIdleMs?: number
  /** 已经探测过的能力（避免重复探测）。 */
  readonly capability?: SandboxCapability
}

const DEFAULT_POLL_MS = 20
const TERMINATE_GRACE_MS = 5_000
const DEFAULT_RESTORE_IDLE_MS = 5_000
/** 恢复间隔的上限：至少要能盖住一次重新打标签前的空闲时间，但不能让标签整天留在用户目录上。 */
const MAX_RESTORE_IDLE_MS = 120_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 工作区完整性标签的租约。
 *
 * `workspace-write` 必须把工作区降到低完整性，低完整性进程才能写进去；但标签会留在用户目录上——
 * 其中的可执行文件也随之变成低完整性，连普通临时目录都写不了（随包 Git 会因此 `git init` 失败）。
 * 因此命令结束后恢复中完整性，并用引用计数加串行队列处理并发命令：最后一个命令结束时才恢复。
 */
interface WorkspaceLabelLease {
  count: number
  chain: Promise<void>
  /** 已知的当前标签；大工作区上 `icacls` 要遍历整棵树（约 20 秒），不能每条命令都做。 */
  level: 'unknown' | 'low' | 'medium'
  /** 最近一次打标签的耗时，用来决定空闲多久再恢复。 */
  costMs: number
  restore?: NodeJS.Timeout | undefined
}

const workspaceLabels = new Map<string, WorkspaceLabelLease>()

function labelLease(directory: string): WorkspaceLabelLease {
  const key = nodePath.resolve(directory)
  let lease = workspaceLabels.get(key)
  if (!lease) {
    lease = { count: 0, chain: Promise.resolve(), level: 'unknown', costMs: 0 }
    workspaceLabels.set(key, lease)
  }
  return lease
}

/**
 * 空闲多久再恢复中完整性。
 *
 * 恢复后下一条命令又要重新打标签，而大工作区上 `icacls` 一次要 20 秒：若 5 秒空闲就恢复，
 * 每条命令都会重付这 20 秒。因此空闲时间至少是上次打标签耗时的 4 倍，把这项开销摊薄。
 */
const restoreDelayMs = (idleMs: number, costMs: number): number =>
  Math.max(idleMs, Math.min(costMs * 4, MAX_RESTORE_IDLE_MS))

/** icacls 调用串行执行，避免并发命令互相覆盖标签。 */
function enqueue(lease: WorkspaceLabelLease, action: () => Promise<void>): Promise<void> {
  const next = lease.chain.catch(() => undefined).then(action)
  lease.chain = next.catch(() => undefined)
  return next
}

async function acquireLowWorkspace(
  integrity: IntegrityController,
  directory: string,
): Promise<void> {
  const lease = labelLease(directory)
  lease.count += 1
  // 还有命令要用低完整性：取消待执行的恢复，标签保持不动
  if (lease.restore) {
    clearTimeout(lease.restore)
    lease.restore = undefined
  }
  try {
    // 始终排进队列：可能有一次恢复正在执行，必须等它结束再看真实标签，否则子进程会在恢复过程中写入
    await enqueue(lease, async () => {
      if (lease.level === 'low') return
      const started = performance.now()
      await integrity.setLevel(directory, 'low')
      lease.costMs = performance.now() - started
      lease.level = 'low'
    })
  } catch (error) {
    lease.count -= 1
    throw error
  }
}

function releaseLowWorkspace(
  integrity: IntegrityController,
  directory: string,
  idleMs: number,
): void {
  const lease = labelLease(directory)
  lease.count = Math.max(0, lease.count - 1)
  if (lease.count > 0 || lease.level !== 'low') return
  if (idleMs <= 0) {
    restoreMedium(integrity, directory, lease)
    return
  }
  lease.restore = setTimeout(() => {
    lease.restore = undefined
    restoreMedium(integrity, directory, lease)
  }, restoreDelayMs(idleMs, lease.costMs))
  lease.restore.unref?.()
}

/** 没有命令再用沙箱时把工作区恢复中完整性，避免标签留在用户目录上。 */
function restoreMedium(
  integrity: IntegrityController,
  directory: string,
  lease: WorkspaceLabelLease,
): void {
  void enqueue(lease, async () => {
    if (lease.count > 0 || lease.level !== 'low') return
    await integrity.setLevel(directory, 'medium')
    lease.level = 'medium'
  }).catch(() => undefined)
}

export async function createSandboxRunner(
  options: SandboxRunnerOptions = {},
): Promise<SandboxRunner> {
  const platform = options.platform ?? process.platform
  const api = options.api === undefined ? await loadSandboxNativeApi(platform) : options.api
  const mechanism = options.mechanism ?? 'restricted-token'
  const capability =
    options.capability ??
    (await probeCapability({
      platform,
      api,
      mechanism,
      ...(options.appContainer ? { appContainerName: options.appContainer.name } : {}),
      ...(options.jobFactory ? { jobFactory: options.jobFactory } : {}),
    }))
  const integrity =
    options.integrity ?? createIntegrityController({ ...(options.env ? { env: options.env } : {}) })
  const acl = options.acl ?? createContainerAcl({ ...(options.env ? { env: options.env } : {}) })
  const executionFor = (policy: SandboxPolicy) => sandboxExecution(policy, capability)

  return {
    capability,
    executionFor,
    async run(policy, input) {
      const execution = executionFor(policy)
      if (policy.profile === 'danger-full-access') {
        throw new SandboxError(
          SandboxErrorCode.Unavailable,
          'The command sandbox is not used for this profile.',
          { reason: 'sandbox.full_access' },
        )
      }
      if (!api) {
        throw new SandboxError(
          SandboxErrorCode.Unavailable,
          'The command sandbox is not available on this platform.',
          { reason: capability.reason ?? 'sandbox.native_unavailable' },
        )
      }
      if (!capability.available || capability.mechanism === 'none') {
        throw new SandboxError(
          SandboxErrorCode.Unavailable,
          `The command sandbox is not available (${capability.reason ?? 'unknown'}).`,
          { reason: capability.reason ?? 'sandbox.unavailable' },
        )
      }
      return runSandboxed({
        api,
        integrity,
        acl,
        jobFactory: options.jobFactory ?? createSandboxJob,
        tempRoot: options.tempRoot ?? tmpdir(),
        pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
        terminateGraceMs: options.terminateGraceMs ?? TERMINATE_GRACE_MS,
        restoreIdleMs: options.restoreIdleMs ?? DEFAULT_RESTORE_IDLE_MS,
        appContainer: options.appContainer,
        execution,
        policy,
        input,
      })
    },
  }
}

interface RunContext {
  readonly api: SandboxNativeApi
  readonly integrity: IntegrityController
  readonly acl: ContainerAcl
  readonly jobFactory: SandboxJobFactory
  readonly tempRoot: string
  readonly pollIntervalMs: number
  readonly terminateGraceMs: number
  readonly restoreIdleMs: number
  readonly appContainer?: { name: string } | undefined
  readonly execution: SandboxExecution
  readonly policy: SandboxPolicy
  readonly input: SandboxRunInput
}

class StreamReader {
  private readonly fd: number
  private position = 0
  private readonly decoder = new StringDecoder('utf8')
  private readonly buffer = Buffer.allocUnsafe(64 * 1024)

  constructor(file: string) {
    this.fd = fs.openSync(file, 'r')
  }

  drain(emit?: (text: string) => void): string {
    let text = ''
    for (;;) {
      const read = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, this.position)
      if (read <= 0) break
      this.position += read
      text += this.decoder.write(this.buffer.subarray(0, read))
    }
    if (text !== '') emit?.(text)
    return text
  }

  finish(emit?: (text: string) => void): string {
    const tail = this.decoder.end()
    if (tail !== '') emit?.(tail)
    return tail
  }

  close(): void {
    fs.closeSync(this.fd)
  }
}

async function runSandboxed(context: RunContext): Promise<SandboxRunResult> {
  const { api, input, policy, execution } = context
  if (input.signal?.aborted) {
    return { exitCode: null, aborted: true, timedOut: false, durationMs: 0, execution }
  }
  const started = performance.now()
  const tempDir = await fsp.mkdtemp(nodePath.join(context.tempRoot, 'cairn-sandbox-'))
  const stdoutPath = nodePath.join(tempDir, 'stdout.log')
  const stderrPath = nodePath.join(tempDir, 'stderr.log')
  fs.writeFileSync(stdoutPath, '')
  fs.writeFileSync(stderrPath, '')

  let token: bigint | undefined
  let appContainerSid: bigint | undefined
  let stdin: bigint | undefined
  let stdout: bigint | undefined
  let stderr: bigint | undefined
  let thread: bigint | undefined
  let processHandle: bigint | undefined
  let job: JobObject | undefined
  let out: StreamReader | undefined
  let err: StreamReader | undefined
  let aborted = false
  let timedOut = false
  let exited = false
  /** 是否把工作区降到了低完整性（只在受限令牌档位、工作区可写时）。 */
  let workspaceLowered = false
  let exitCode: number | null
  let signalListener: (() => void) | undefined

  const stop = () => {
    if (exited) return
    if (job) job.terminate()
    else if (processHandle !== undefined) api.terminate(processHandle)
  }

  try {
    await context.integrity.setLevel(tempDir, 'low')
    if (execution.mechanism === 'appcontainer') {
      if (!context.appContainer) {
        throw new SandboxError(
          SandboxErrorCode.SetupFailed,
          'The AppContainer sandbox requires a container profile.',
        )
      }
      const container = api.appContainer(context.appContainer.name)
      appContainerSid = container.sid
      await context.acl.grant(
        input.cwd,
        container.sidString,
        policy.profile === 'read-only' ? 'read' : 'modify',
      )
      await context.acl.grant(tempDir, container.sidString, 'modify')
      stdout = api.openInheritableFile(stdoutPath, 'write')
      stderr = api.openInheritableFile(stderrPath, 'write')
      stdin = api.openNul()
      const spawned = api.spawn({
        token: 0n,
        commandLine: buildWindowsCommandLine(input.invocation),
        cwd: input.cwd,
        env: buildEnvironmentBlock(input.env),
        stdin,
        stdout,
        stderr,
        appContainer: {
          sid: container.sid,
          capabilitySids: networkCapabilities(policy.network),
        },
      })
      processHandle = spawned.process
      thread = spawned.thread
      api.closeHandle(appContainerSid)
      appContainerSid = undefined
      const jobInstance = await context.jobFactory()
      if (!jobInstance || !jobInstance.assign(spawned.pid)) {
        jobInstance?.close()
        throw new SandboxError(
          SandboxErrorCode.SetupFailed,
          'Cannot place the sandboxed process in a job object.',
        )
      }
      job = jobInstance
    } else {
      if (policy.profile === 'read-only') {
        await context.integrity.setLevel(input.cwd, 'medium')
      } else {
        // 低完整性标签只在命令运行期间保留；结束（含失败、超时）后恢复中完整性
        await acquireLowWorkspace(context.integrity, input.cwd)
        workspaceLowered = true
      }
      token = api.createRestrictedToken('low')
      stdout = api.openInheritableFile(stdoutPath, 'write')
      stderr = api.openInheritableFile(stderrPath, 'write')
      stdin = api.openNul()
      const spawned = api.spawn({
        token,
        commandLine: buildWindowsCommandLine(input.invocation),
        cwd: input.cwd,
        env: buildEnvironmentBlock(input.env),
        stdin,
        stdout,
        stderr,
      })
      processHandle = spawned.process
      thread = spawned.thread
      const jobInstance = await context.jobFactory()
      if (!jobInstance || !jobInstance.assign(spawned.pid)) {
        jobInstance?.close()
        throw new SandboxError(
          SandboxErrorCode.SetupFailed,
          'Cannot place the sandboxed process in a job object.',
        )
      }
      job = jobInstance
    }
    if (input.signal?.aborted) {
      aborted = true
      api.terminate(processHandle)
    } else {
      api.resumeThread(thread)
    }
    thread = undefined
    out = new StreamReader(stdoutPath)
    err = new StreamReader(stderrPath)

    signalListener = () => {
      aborted = true
      stop()
    }
    input.signal?.addEventListener('abort', signalListener, { once: true })

    const timeoutMs = input.timeoutMs
    const deadline = timeoutMs > 0 ? started + timeoutMs : undefined
    let terminateDeadline: number | undefined
    for (;;) {
      out.drain(input.onStdout)
      err.drain(input.onStderr)
      if (api.hasExited(processHandle)) {
        exited = true
        exitCode = api.exitCode(processHandle)
        break
      }
      if (input.signal?.aborted) aborted = true
      if (!aborted && deadline !== undefined && performance.now() >= deadline) {
        timedOut = true
        stop()
        terminateDeadline ??= performance.now() + context.terminateGraceMs
      }
      if (aborted) {
        stop()
        terminateDeadline ??= performance.now() + context.terminateGraceMs
      }
      if (terminateDeadline !== undefined && performance.now() >= terminateDeadline) {
        exitCode = null
        break
      }
      await delay(context.pollIntervalMs)
    }
    // 命令结束即结束残留的后台进程；再读一次，避免丢掉最后一小段输出
    job?.terminate()
    await delay(context.pollIntervalMs)
    out.drain(input.onStdout)
    err.drain(input.onStderr)
    out.finish(input.onStdout)
    err.finish(input.onStderr)
    return {
      exitCode,
      aborted,
      timedOut,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      execution,
    }
  } finally {
    if (signalListener) input.signal?.removeEventListener('abort', signalListener)
    try {
      out?.close()
      err?.close()
    } catch {
      // 临时目录随后删除，读取句柄关闭失败不影响结果
    }
    if (processHandle !== undefined) {
      job?.terminate()
      job?.close()
      if (!exited) api.terminate(processHandle)
      api.closeHandle(processHandle)
    } else {
      job?.close()
    }
    for (const handle of [thread, token, appContainerSid, stdin, stdout, stderr]) {
      if (handle !== undefined) api.closeHandle(handle)
    }
    if (workspaceLowered) {
      releaseLowWorkspace(context.integrity, input.cwd, context.restoreIdleMs)
    }
    await fsp
      .rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
      .catch(() => undefined)
  }
}
