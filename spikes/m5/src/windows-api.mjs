// @ts-check
/**
 * M5-00 S1 的最小 Windows 沙箱原型：只用于预研，不进入产品代码。
 *
 * - 受限令牌：`CreateRestrictedToken`（DISABLE_MAX_PRIVILEGE | LUA_TOKEN）+ 低完整性级别，经
 *   `CreateProcessAsUserW` 启动。普通用户不需要管理员权限。
 * - AppContainer：`CreateAppContainerProfile` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，经
 *   `CreateProcessW` 启动。默认不授予网络能力；传入 capability SID 时可测试网络。
 * - 两种模式都把子进程放入 Job Object（`KILL_ON_JOB_CLOSE`），超时或结束实验时清理整个进程树。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import koffi from 'koffi'

const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const userenv = koffi.load('userenv.dll')
const handle = koffi.pointer(koffi.opaque())

const fn = (/** @type {any} */ lib, /** @type {string} */ name, result, args) =>
  lib.func('__stdcall', name, result, args)

const api = {
  GetCurrentProcess: fn(kernel32, 'GetCurrentProcess', handle, []),
  GetLastError: fn(kernel32, 'GetLastError', 'uint32_t', []),
  CloseHandle: fn(kernel32, 'CloseHandle', 'int', [handle]),
  WaitForSingleObject: fn(kernel32, 'WaitForSingleObject', 'uint32_t', [handle, 'uint32_t']),
  ResumeThread: fn(kernel32, 'ResumeThread', 'uint32_t', [handle]),
  GetExitCodeProcess: fn(kernel32, 'GetExitCodeProcess', 'int', [handle, 'void *']),
  TerminateProcess: fn(kernel32, 'TerminateProcess', 'int', [handle, 'uint32_t']),
  OpenProcess: fn(kernel32, 'OpenProcess', handle, ['uint32_t', 'int', 'uint32_t']),
  CreateJobObjectW: fn(kernel32, 'CreateJobObjectW', handle, ['void *', 'void *']),
  SetInformationJobObject: fn(kernel32, 'SetInformationJobObject', 'int', [
    handle,
    'int',
    'void *',
    'uint32_t',
  ]),
  AssignProcessToJobObject: fn(kernel32, 'AssignProcessToJobObject', 'int', [handle, handle]),
  TerminateJobObject: fn(kernel32, 'TerminateJobObject', 'int', [handle, 'uint32_t']),
  InitializeProcThreadAttributeList: fn(kernel32, 'InitializeProcThreadAttributeList', 'int', [
    'void *',
    'uint32_t',
    'uint32_t',
    'void *',
  ]),
  UpdateProcThreadAttribute: fn(kernel32, 'UpdateProcThreadAttribute', 'int', [
    'void *',
    'uintptr_t',
    'void *',
    'void *',
    'size_t',
    'void *',
    'void *',
  ]),
  CreateProcessW: fn(kernel32, 'CreateProcessW', 'int', [
    'str16',
    'void *',
    'void *',
    'void *',
    'int',
    'uint32_t',
    'void *',
    'str16',
    'void *',
    'void *',
  ]),
  OpenProcessToken: fn(advapi32, 'OpenProcessToken', 'int', [
    handle,
    'uint32_t',
    koffi.out(koffi.pointer(handle)),
  ]),
  CreateRestrictedToken: fn(advapi32, 'CreateRestrictedToken', 'int', [
    handle,
    'uint32_t',
    'uint32_t',
    'void *',
    'uint32_t',
    'void *',
    'uint32_t',
    'void *',
    koffi.out(koffi.pointer(handle)),
  ]),
  ConvertStringSidToSidW: fn(advapi32, 'ConvertStringSidToSidW', 'int', [
    'str16',
    koffi.out(koffi.pointer(handle)),
  ]),
  ConvertSidToStringSidW: fn(advapi32, 'ConvertSidToStringSidW', 'int', [
    handle,
    koffi.out(koffi.pointer(handle)),
  ]),
  SetTokenInformation: fn(advapi32, 'SetTokenInformation', 'int', [
    handle,
    'int',
    'void *',
    'uint32_t',
  ]),
  CreateProcessAsUserW: fn(advapi32, 'CreateProcessAsUserW', 'int', [
    handle,
    'str16',
    'void *',
    'void *',
    'void *',
    'int',
    'uint32_t',
    'void *',
    'str16',
    'void *',
    'void *',
  ]),
  CreateAppContainerProfile: fn(userenv, 'CreateAppContainerProfile', 'int', [
    'str16',
    'str16',
    'str16',
    'void *',
    'uint32_t',
    koffi.out(koffi.pointer(handle)),
  ]),
  DeriveAppContainerSidFromAppContainerName: fn(
    userenv,
    'DeriveAppContainerSidFromAppContainerName',
    'int',
    ['str16', koffi.out(koffi.pointer(handle))],
  ),
  DeleteAppContainerProfile: fn(userenv, 'DeleteAppContainerProfile', 'int', ['str16']),
}

const TOKEN_ALL_ACCESS = 0xf01ff
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const TOKEN_INTEGRITY_LEVEL = 25
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x0002_0009
const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000
const CREATE_SUSPENDED = 0x0000_0004
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

/** @returns {never} */
function fail(/** @type {string} */ what) {
  const code = api.GetLastError()
  throw new Error(`${what} failed (Win32 ${code}: ${code === 0 ? 'success' : 'error'})`)
}

function check(/** @type {number} */ value, /** @type {string} */ what) {
  if (!value) fail(what)
}

/** @param {string} sidString */
function sidFromString(sidString) {
  const sid = [null]
  check(api.ConvertStringSidToSidW(sidString, sid), `ConvertStringSidToSidW(${sidString})`)
  return sid[0]
}

/** @param {unknown} sid */
function sidToString(sid) {
  const out = [null]
  check(api.ConvertSidToStringSidW(sid, out), 'ConvertSidToStringSidW')
  return koffi.decode(out[0], 'char16_t', 184).split('\0')[0]
}

/** 创建带 KILL_ON_JOB_CLOSE 的作业对象。 */
function createJob() {
  const job = api.CreateJobObjectW(null, null)
  check(job, 'CreateJobObjectW')
  const info = Buffer.alloc(144)
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags 的偏移为 16。
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
  check(
    api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length),
    'SetInformationJobObject',
  )
  return job
}

/** @param {unknown} job @param {number} pid */
function assignJob(job, pid) {
  const proc = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
  check(proc, `OpenProcess(${pid})`)
  try {
    check(api.AssignProcessToJobObject(job, proc), 'AssignProcessToJobObject')
  } finally {
    api.CloseHandle(proc)
  }
}

/** 受限令牌 + 低完整性级别；不修改当前进程。 */
export function createRestrictedToken() {
  const token = [null]
  check(api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_ALL_ACCESS, token), 'OpenProcessToken')
  const restricted = [null]
  check(
    api.CreateRestrictedToken(
      token[0],
      DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
      0,
      null,
      0,
      null,
      0,
      null,
      restricted,
    ),
    'CreateRestrictedToken',
  )
  const lowSid = sidFromString('S-1-16-4096')
  const label = Buffer.alloc(16)
  label.writeBigUInt64LE(BigInt(lowSid), 0)
  label.writeUInt32LE(0, 8)
  check(
    api.SetTokenInformation(restricted[0], TOKEN_INTEGRITY_LEVEL, label, label.length),
    'SetTokenInformation(TokenIntegrityLevel)',
  )
  api.CloseHandle(token[0])
  return restricted[0]
}

/**
 * 创建 AppContainer profile 并返回 SID。
 * @param {string} name
 * @returns {{ sid: unknown, sidString: string }}
 */
export function createAppContainer(name) {
  const sid = [null]
  const result = api.CreateAppContainerProfile(
    name,
    'Cairn spike',
    'Cairn M5-00 sandbox spike',
    null,
    0,
    sid,
  )
  if (result !== 0) {
    // HRESULT 0x800700b7 (ERROR_ALREADY_EXISTS)：profile 已存在时直接派生 SID。
    if (result >>> 0 !== 0x8007_00b7) {
      throw new Error(`CreateAppContainerProfile failed (HRESULT 0x${(result >>> 0).toString(16)})`)
    }
    const derived = [null]
    check(
      api.DeriveAppContainerSidFromAppContainerName(name, derived),
      `DeriveAppContainerSidFromAppContainerName(${name})`,
    )
    return { name, sid: derived[0], sidString: sidToString(derived[0]) }
  }
  return { name, sid: sid[0], sidString: sidToString(sid[0]) }
}

/** @param {string} name */
export function deleteAppContainer(name) {
  api.DeleteAppContainerProfile(name)
}

/** @param {string[]} capabilitySids */
function capabilityBuffer(capabilitySids) {
  if (capabilitySids.length === 0) return { buffer: null, count: 0 }
  const buffer = Buffer.alloc(capabilitySids.length * 16)
  for (let i = 0; i < capabilitySids.length; i += 1) {
    const sid = sidFromString(capabilitySids[i])
    buffer.writeBigUInt64LE(BigInt(sid), i * 16)
    // SE_GROUP_ENABLED：能力必须启用，否则 AppContainer 仍按无网络运行。
    buffer.writeUInt32LE(0x4, i * 16 + 8)
  }
  return { buffer, count: capabilitySids.length }
}

/** @param {unknown} appContainerSid @param {string[]} capabilitySids */
function securityCapabilities(appContainerSid, capabilitySids) {
  const capabilities = capabilityBuffer(capabilitySids)
  const value = Buffer.alloc(24)
  value.writeBigUInt64LE(BigInt(appContainerSid), 0)
  value.writeBigUInt64LE(capabilities.buffer ? koffi.address(capabilities.buffer) : 0n, 8)
  value.writeUInt32LE(capabilities.count, 16)
  value.writeUInt32LE(0, 20)
  return value
}

/**
 * @typedef {object} SpawnOptions
 * @property {'none' | 'restricted' | 'appcontainer'} mode
 * @property {string} workDir
 * @property {string} command
 * @property {{ name: string, sid: unknown }} [appContainer]
 * @property {string[]} [capabilitySids]
 * @property {number} [timeoutMs]
 */

/** @param {SpawnOptions} options */
export function runSandboxed(options) {
  const stdoutFile = path.join(options.workDir, '__stdout.txt')
  const stderrFile = path.join(options.workDir, '__stderr.txt')
  const scriptFile = path.join(options.workDir, '__run.cmd')
  writeFileSync(stdoutFile, '')
  writeFileSync(stderrFile, '')
  writeFileSync(
    scriptFile,
    `@echo off\r\nchcp 65001>nul\r\n${options.command}\r\nexit /b %ERRORLEVEL%\r\n`,
    'utf8',
  )
  const commandLine = `cmd.exe /d /s /c "__run.cmd 1>__stdout.txt 2>__stderr.txt"`
  const commandLineBuffer = Buffer.from(`${commandLine}\0`, 'utf16le')
  const startup = Buffer.alloc(112)
  startup.writeUInt32LE(112, 0)
  const processInfo = Buffer.alloc(24)
  const job = options.mode === 'none' ? undefined : createJob()
  const started = performance.now()
  let created

  try {
    if (options.mode === 'restricted') {
      const token = createRestrictedToken()
      try {
        created = Boolean(
          api.CreateProcessAsUserW(
            token,
            null,
            commandLineBuffer,
            null,
            null,
            0,
            CREATE_SUSPENDED,
            null,
            options.workDir,
            startup,
            processInfo,
          ),
        )
      } finally {
        api.CloseHandle(token)
      }
      check(created, 'CreateProcessAsUserW(restricted)')
    } else if (options.mode === 'appcontainer') {
      if (!options.appContainer) throw new Error('appContainer is required for appcontainer mode')
      const appContainer = options.appContainer
      const size = Buffer.alloc(8)
      api.InitializeProcThreadAttributeList(null, 1, 0, size)
      const attributeList = Buffer.alloc(Number(size.readBigUInt64LE(0)))
      check(
        api.InitializeProcThreadAttributeList(attributeList, 1, 0, size),
        'InitializeProcThreadAttributeList',
      )
      const security = securityCapabilities(appContainer.sid, options.capabilitySids ?? [])
      check(
        api.UpdateProcThreadAttribute(
          attributeList,
          0,
          PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          security,
          security.length,
          null,
          null,
        ),
        'UpdateProcThreadAttribute(SECURITY_CAPABILITIES)',
      )
      startup.writeBigUInt64LE(koffi.address(attributeList), 104)
      created = Boolean(
        api.CreateProcessW(
          null,
          commandLineBuffer,
          null,
          null,
          0,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
          null,
          options.workDir,
          startup,
          processInfo,
        ),
      )
      check(created, 'CreateProcessW(AppContainer)')
    } else {
      check(
        Boolean(
          api.CreateProcessW(
            null,
            commandLineBuffer,
            null,
            null,
            0,
            CREATE_SUSPENDED,
            null,
            options.workDir,
            startup,
            processInfo,
          ),
        ),
        'CreateProcessW',
      )
    }

    const processHandle = processInfo.readBigUInt64LE(0)
    const threadHandle = processInfo.readBigUInt64LE(8)
    const pid = processInfo.readUInt32LE(16)
    if (job) assignJob(job, pid)
    api.ResumeThread(threadHandle)
    const wait = api.WaitForSingleObject(processHandle, options.timeoutMs ?? 120_000)
    let timedOut = false
    if (wait === WAIT_TIMEOUT) {
      timedOut = true
      if (job) api.TerminateJobObject(job, 1)
      api.TerminateProcess(processHandle, 1)
      api.WaitForSingleObject(processHandle, 10_000)
    }
    const code = Buffer.alloc(4)
    check(api.GetExitCodeProcess(processHandle, code), 'GetExitCodeProcess')
    api.CloseHandle(threadHandle)
    api.CloseHandle(processHandle)
    const elapsedMs = Math.round(performance.now() - started)
    return {
      mode: options.mode,
      pid,
      exitCode: code.readUInt32LE(0),
      timedOut,
      elapsedMs,
      stdout: readText(stdoutFile),
      stderr: readText(stderrFile),
    }
  } finally {
    if (job) {
      api.TerminateJobObject(job, 1)
      api.CloseHandle(job)
    }
  }
}

/** @param {string} file */
function readText(file) {
  try {
    if (statSync(file).size === 0) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export { WAIT_OBJECT_0 }
