/** 沙箱进程使用的 Job Object：`KILL_ON_JOB_CLOSE`，关闭句柄时结束整个进程树。 */
import { createJobObject, loadKernel32, type JobObject } from '../job-object.js'

export type SandboxJobFactory = () => Promise<JobObject | undefined>

export const createSandboxJob: SandboxJobFactory = async () => {
  try {
    const loaded = await loadKernel32()
    return createJobObject(loaded.kernel32, loaded.layout)
  } catch {
    return undefined
  }
}
