/**
 * 结束命令的整个进程树（ADR-0012）：
 *
 * - Windows：shell 启动后立即放进 Job Object（`KILL_ON_JOB_CLOSE`），超时或取消时 `TerminateJobObject`；命令结束后
 *   关闭作业句柄，仍在运行的后台进程随之结束。koffi 或作业对象不可用（加载失败、放入作业失败）时回退到
 *   `taskkill /T /F`，它不能结束父进程已退出的子孙进程。
 * - 其他平台：shell 作为新进程组的组长启动（`detached`），结束时向整个进程组发 `SIGKILL`；命令结束后同样结束
 *   进程组内残留的后台进程。
 *
 * 后台进程持有输出管道时，不结束它们命令就不会“结束”（`close` 一直等待），因此命令结束即结束整个进程树；
 * 需要长时间运行的后台任务不在 M1 的范围内。
 */
import { spawn } from 'node:child_process'
import nodePath from 'node:path'
import { createJobObject, type JobObject, loadKernel32 } from './job-object.js'

export type ProcessTreeMechanism = 'job-object' | 'taskkill' | 'process-group'

export interface ProcessTree {
  /** 当前使用的方式（放入作业失败时由 `job-object` 变为 `taskkill`）。 */
  readonly mechanism: ProcessTreeMechanism
  /** 是否以新进程组启动（spawn 的 `detached`）。 */
  readonly detached: boolean
  /** shell 启动后立即调用。 */
  attach(pid: number): void
  /** shell 仍在运行时结束整个进程树（超时、取消）。 */
  terminate(): Promise<void>
  /** shell 已退出：结束残留的后台进程并释放资源。 */
  dispose(): void
}

export type ProcessTreeFactory = () => Promise<ProcessTree>

/** 以 `taskkill /T /F` 结束进程树。 */
export type TaskKill = (pid: number) => Promise<void>

export interface ProcessTreeOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  /** 加载 kernel32；undefined 表示不用作业对象。默认经 koffi 加载（只加载一次）。 */
  readonly kernel32?: (() => Promise<Awaited<ReturnType<typeof loadKernel32>>>) | undefined
  readonly taskkill?: TaskKill
  /** 结束进程组（默认 `process.kill(-pid, 'SIGKILL')`）。 */
  readonly killGroup?: (pid: number) => void
}

let kernel32Loading: Promise<Awaited<ReturnType<typeof loadKernel32>> | undefined> | undefined

/** koffi 只加载一次；失败（不是 Windows、没有预编译二进制等）时不再重试。 */
const loadKernel32Once = (load: () => ReturnType<typeof loadKernel32>) =>
  (kernel32Loading ??= load().catch(() => undefined))

/** 默认的 `taskkill`：位于 System32，结束后返回（结果不影响调用方）。 */
export function defaultTaskKill(env: NodeJS.ProcessEnv = process.env): TaskKill {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  const exe = nodePath.win32.join(systemRoot, 'System32', 'taskkill.exe')
  return (pid) =>
    new Promise((resolve) => {
      const child = spawn(exe, ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
}

const defaultKillGroup = (pid: number) => process.kill(-pid, 'SIGKILL')

export async function createProcessTree(options: ProcessTreeOptions = {}): Promise<ProcessTree> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return processGroupTree(options.killGroup ?? defaultKillGroup)
  const load = 'kernel32' in options ? options.kernel32 : loadKernel32
  const loaded = load ? await loadKernel32Once(load) : undefined
  const job = loaded ? createJobObject(loaded.kernel32, loaded.layout) : undefined
  return windowsTree(job, options.taskkill ?? defaultTaskKill(options.env))
}

/** 测试用：清除 kernel32 的加载结果。 */
export function resetProcessTreeCache(): void {
  kernel32Loading = undefined
}

function windowsTree(initialJob: JobObject | undefined, taskkill: TaskKill): ProcessTree {
  let job = initialJob
  let pid: number | undefined
  return {
    get mechanism() {
      return job ? 'job-object' : 'taskkill'
    },
    detached: false,
    attach(p) {
      pid = p
      if (job && !job.assign(p)) {
        job.close()
        job = undefined
      }
    },
    async terminate() {
      if (job?.terminate()) return
      if (pid !== undefined) await taskkill(pid)
    },
    dispose() {
      job?.close()
    },
  }
}

function processGroupTree(killGroup: (pid: number) => void): ProcessTree {
  let pid: number | undefined
  const kill = () => {
    if (pid === undefined) return
    try {
      killGroup(pid)
    } catch {
      // 进程组已经没有进程（ESRCH）
    }
  }
  return {
    mechanism: 'process-group',
    detached: true,
    attach(p) {
      pid = p
    },
    terminate() {
      kill()
      return Promise.resolve()
    },
    dispose() {
      kill()
      pid = undefined
    },
  }
}
