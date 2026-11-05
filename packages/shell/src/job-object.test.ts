import { describe, expect, it, vi } from 'vitest'
import {
  createJobObject,
  JOB_TERMINATED_EXIT_CODE,
  type Kernel32,
  loadKernel32,
} from './job-object.js'

const layout = { size: 144, limitFlagsOffset: 16 }

function fakeKernel32(overrides: Partial<Kernel32> = {}) {
  const job = { job: true }
  const process = { process: true }
  const kernel32 = {
    CreateJobObjectW: vi.fn(() => job),
    SetInformationJobObject: vi.fn(() => 1),
    OpenProcess: vi.fn(() => process),
    AssignProcessToJobObject: vi.fn(() => 1),
    TerminateJobObject: vi.fn(() => 1),
    CloseHandle: vi.fn(() => 1),
    ...overrides,
  }
  return { kernel32, job, process }
}

describe('createJobObject', () => {
  it('设 KILL_ON_JOB_CLOSE；放入、结束与关闭', () => {
    const { kernel32, job, process } = fakeKernel32()
    const jobObject = createJobObject(kernel32, layout)!
    const [handle, infoClass, info, length] = vi.mocked(kernel32.SetInformationJobObject).mock
      .calls[0]! as [unknown, number, Buffer, number]
    expect(handle).toBe(job)
    expect(infoClass).toBe(9)
    expect(length).toBe(144)
    expect(info.length).toBe(144)
    expect(info.readUInt32LE(16)).toBe(0x2000)

    expect(jobObject.assign(42)).toBe(true)
    expect(kernel32.OpenProcess).toHaveBeenCalledWith(0x0101, 0, 42)
    expect(kernel32.AssignProcessToJobObject).toHaveBeenCalledWith(job, process)
    expect(kernel32.CloseHandle).toHaveBeenCalledWith(process)

    expect(jobObject.terminate()).toBe(true)
    expect(kernel32.TerminateJobObject).toHaveBeenCalledWith(job, JOB_TERMINATED_EXIT_CODE)

    jobObject.close()
    jobObject.close()
    expect(vi.mocked(kernel32.CloseHandle).mock.calls.filter(([h]) => h === job)).toHaveLength(1)
    // 关闭后不再使用句柄
    expect(jobObject.assign(42)).toBe(false)
    expect(jobObject.terminate()).toBe(false)
    expect(kernel32.TerminateJobObject).toHaveBeenCalledTimes(1)
  })

  it('创建或设置失败时返回 undefined（设置失败时关闭句柄）', () => {
    expect(createJobObject(fakeKernel32({ CreateJobObjectW: () => null }).kernel32, layout)).toBe(
      undefined,
    )
    const { kernel32, job } = fakeKernel32({ SetInformationJobObject: () => 0 })
    expect(createJobObject(kernel32, layout)).toBe(undefined)
    expect(kernel32.CloseHandle).toHaveBeenCalledWith(job)
  })

  it('打不开进程或放入失败时 assign 返回 false', () => {
    const noProcess = fakeKernel32({ OpenProcess: () => null })
    expect(createJobObject(noProcess.kernel32, layout)!.assign(1)).toBe(false)
    const denied = fakeKernel32({ AssignProcessToJobObject: () => 0 })
    expect(createJobObject(denied.kernel32, layout)!.assign(1)).toBe(false)
    expect(denied.kernel32.CloseHandle).toHaveBeenCalledWith(denied.process)
    const failed = fakeKernel32({ TerminateJobObject: () => 0 })
    expect(createJobObject(failed.kernel32, layout)!.terminate()).toBe(false)
  })
})

describe('loadKernel32', () => {
  it.runIf(process.platform === 'win32')('Windows：结构体布局与 Windows SDK 一致', async () => {
    const { layout: real } = await loadKernel32()
    const is64 = process.arch === 'x64' || process.arch === 'arm64'
    expect(real).toEqual(
      is64 ? { size: 144, limitFlagsOffset: 16 } : { size: 112, limitFlagsOffset: 16 },
    )
  })

  it.runIf(process.platform !== 'win32')('其他平台加载失败', async () => {
    await expect(loadKernel32()).rejects.toThrow()
  })
})
