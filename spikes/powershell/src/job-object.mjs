// @ts-check
/**
 * Windows Job Object（经 koffi 调用 kernel32）：把进程放进作业，结束作业即结束其中所有进程。
 * 作业设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：最后一个句柄关闭时（包括本进程退出或崩溃）也结束所有进程。
 * 进程在加入作业之后启动的子进程自动属于同一作业（除非以 `CREATE_BREAKAWAY_FROM_JOB` 启动且作业允许脱离）。
 */
import koffi from 'koffi'

const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** @type {ReturnType<typeof bind> | undefined} */
let api

function bind() {
  const k32 = koffi.load('kernel32.dll')
  const IO_COUNTERS = koffi.struct('IO_COUNTERS', {
    ReadOperationCount: 'uint64',
    WriteOperationCount: 'uint64',
    OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64',
    WriteTransferCount: 'uint64',
    OtherTransferCount: 'uint64',
  })
  const BASIC = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
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
  const EXTENDED = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: BASIC,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  })
  return {
    sizeofExtended: koffi.sizeof(EXTENDED),
    CreateJobObjectW: k32.func('void* __stdcall CreateJobObjectW(void*, void*)'),
    SetInformationJobObject: k32.func(
      'int __stdcall SetInformationJobObject(void*, int, _In_ JOBOBJECT_EXTENDED_LIMIT_INFORMATION*, uint32)',
    ),
    OpenProcess: k32.func('void* __stdcall OpenProcess(uint32, int, uint32)'),
    AssignProcessToJobObject: k32.func('int __stdcall AssignProcessToJobObject(void*, void*)'),
    TerminateJobObject: k32.func('int __stdcall TerminateJobObject(void*, uint32)'),
    IsProcessInJob: k32.func('int __stdcall IsProcessInJob(void*, void*, _Out_ int*)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(void*)'),
  }
}

export const jobObjectsAvailable = () => process.platform === 'win32'

export class JobObject {
  /** @type {unknown} */
  #handle

  constructor() {
    api ??= bind()
    this.#handle = api.CreateJobObjectW(null, null)
    if (!this.#handle) throw new Error('CreateJobObjectW failed')
    const info = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    }
    const ok = api.SetInformationJobObject(
      this.#handle,
      JobObjectExtendedLimitInformation,
      info,
      api.sizeofExtended,
    )
    if (!ok) throw new Error('SetInformationJobObject failed')
  }

  /** @param {number} pid */
  assign(pid) {
    const a = /** @type {NonNullable<typeof api>} */ (api)
    const proc = a.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
    if (!proc) return false
    try {
      return a.AssignProcessToJobObject(this.#handle, proc) !== 0
    } finally {
      a.CloseHandle(proc)
    }
  }

  /** @param {number} pid @returns {boolean | undefined} 进程不存在时为 undefined */
  contains(pid) {
    const a = /** @type {NonNullable<typeof api>} */ (api)
    const proc = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!proc) return undefined
    try {
      const out = [0]
      if (!a.IsProcessInJob(proc, this.#handle, out)) return undefined
      return out[0] !== 0
    } finally {
      a.CloseHandle(proc)
    }
  }

  /** 结束作业中的所有进程。 */
  terminate(code = 1) {
    return /** @type {NonNullable<typeof api>} */ (api).TerminateJobObject(this.#handle, code) !== 0
  }

  /** 关闭句柄；设置了 KILL_ON_JOB_CLOSE，因此也会结束作业中的所有进程。 */
  close() {
    if (!this.#handle) return
    ;/** @type {NonNullable<typeof api>} */ (api).CloseHandle(this.#handle)
    this.#handle = undefined
  }
}
