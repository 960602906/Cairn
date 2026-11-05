/**
 * Windows Job Object（ADR-0012，S7）：经 koffi 调用 kernel32。作业设 `KILL_ON_JOB_CLOSE`，关闭句柄（包括应用
 * 退出、崩溃）时作业内的进程全部结束；`TerminateJobObject` 立即结束整个进程树，包括父进程已退出的子孙进程。
 */
import type { TypeObject } from 'koffi'

type KoffiType = string | TypeObject

/** 用到的 kernel32 函数；句柄是不透明值，失败时为 null。BOOL 返回 0 表示失败。 */
export interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): unknown
  SetInformationJobObject(job: unknown, infoClass: number, info: Buffer, length: number): number
  OpenProcess(access: number, inheritHandle: number, pid: number): unknown
  AssignProcessToJobObject(job: unknown, process: unknown): number
  TerminateJobObject(job: unknown, exitCode: number): number
  CloseHandle(handle: unknown): number
}

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
/** 作业内进程被结束时的退出码。 */
export const JOB_TERMINATED_EXIT_CODE = 1

/** `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 的大小与其中 `LimitFlags` 的偏移。 */
export interface JobLimitLayout {
  readonly size: number
  readonly limitFlagsOffset: number
}

/** 加载 kernel32（只在 Windows 上可用）。 */
export async function loadKernel32(): Promise<{ kernel32: Kernel32; layout: JobLimitLayout }> {
  const { default: koffi } = await import('koffi')
  const lib = koffi.load('kernel32.dll')
  const basic = koffi.struct({
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  })
  const io = koffi.struct({
    ReadOperationCount: 'uint64',
    WriteOperationCount: 'uint64',
    OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64',
    WriteTransferCount: 'uint64',
    OtherTransferCount: 'uint64',
  })
  const extended = koffi.struct({
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  })
  // 句柄用匿名类型：命名类型在同一进程内重复加载时会冲突
  const handle = koffi.pointer(koffi.opaque())
  const fn = (name: string, result: KoffiType, args: KoffiType[]) =>
    lib.func('__stdcall', name, result, args)
  const kernel32 = {
    CreateJobObjectW: fn('CreateJobObjectW', handle, ['void *', 'void *']),
    SetInformationJobObject: fn('SetInformationJobObject', 'int', [
      handle,
      'int',
      'void *',
      'uint32_t',
    ]),
    OpenProcess: fn('OpenProcess', handle, ['uint32_t', 'int', 'uint32_t']),
    AssignProcessToJobObject: fn('AssignProcessToJobObject', 'int', [handle, handle]),
    TerminateJobObject: fn('TerminateJobObject', 'int', [handle, 'uint32_t']),
    CloseHandle: fn('CloseHandle', 'int', [handle]),
  } as Kernel32
  return {
    kernel32,
    layout: {
      size: koffi.sizeof(extended),
      limitFlagsOffset: koffi.offsetof(basic, 'LimitFlags'),
    },
  }
}

/** 一个作业对象。 */
export interface JobObject {
  /** 把进程放进作业；失败（进程已退出、无权限等）返回 false。 */
  assign(pid: number): boolean
  /** 结束作业内的全部进程。 */
  terminate(): boolean
  /** 关闭句柄：作业内仍在运行的进程随之结束。 */
  close(): void
}

/** 创建设了 `KILL_ON_JOB_CLOSE` 的作业；失败时返回 undefined。 */
export function createJobObject(kernel32: Kernel32, layout: JobLimitLayout): JobObject | undefined {
  const job = kernel32.CreateJobObjectW(null, null)
  if (!job) return undefined
  const info = Buffer.alloc(layout.size)
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, layout.limitFlagsOffset)
  const ok = kernel32.SetInformationJobObject(
    job,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
    info,
    layout.size,
  )
  if (!ok) {
    kernel32.CloseHandle(job)
    return undefined
  }
  let closed = false
  return {
    assign(pid) {
      if (closed) return false
      const process = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
      if (!process) return false
      try {
        return kernel32.AssignProcessToJobObject(job, process) !== 0
      } finally {
        kernel32.CloseHandle(process)
      }
    },
    terminate() {
      return !closed && kernel32.TerminateJobObject(job, JOB_TERMINATED_EXIT_CODE) !== 0
    },
    close() {
      if (closed) return
      closed = true
      kernel32.CloseHandle(job)
    },
  }
}
