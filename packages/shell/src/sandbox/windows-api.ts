/**
 * 命令沙箱用到的 Windows API（M5-04，ADR-0034）：经 koffi 调用 kernel32 / advapi32 / userenv。
 *
 * 只做薄封装：句柄是不透明的 64 位值（koffi 以 bigint 表示），失败时抛出带错误码的 `SandboxError`。
 * 单独成层是为了能在测试中替换成假实现，验证启动、超时、取消与清理逻辑。
 */
import { SandboxError, SandboxErrorCode } from './types.js'

type KoffiType = string | object
type Handle = bigint

const TOKEN_ALL_ACCESS = 0xf01ff
const TOKEN_QUERY = 0x0008
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const TOKEN_INTEGRITY_LEVEL = 25
const TOKEN_USER = 1
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x0002_0009
const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000
/** 沙箱进程不能弹控制台窗口。 */
export const CREATE_SUSPENDED = 0x0000_0004
export const CREATE_NO_WINDOW = 0x0800_0000
export const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400
/** 子进程不加入调用方所在的作业对象（宿主的作业不允许时创建失败）。 */
export const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000
const STARTF_USESTDHANDLES = 0x0000_0100
const WAIT_OBJECT_0 = 0
const ERROR_INSUFFICIENT_BUFFER = 122
const ERROR_ACCESS_DENIED = 5
const ERROR_ALREADY_EXISTS_HRESULT = 0x8007_00b7
const GENERIC_READ = 0x8000_0000
const GENERIC_WRITE = 0x4000_0000
const FILE_SHARE_READ_WRITE = 0x0000_0003
const CREATE_ALWAYS = 2
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_NORMAL = 0x0000_0080
const SE_GROUP_ENABLED = 0x0000_0004
const UOI_NAME = 2
const WINSTA_ALL_ACCESS = 0x0000_037f
const GENERIC_ALL = 0x1000_0000
const SE_WINDOW_OBJECT = 7
const LABEL_SECURITY_INFORMATION = 0x0000_0010
const SDDL_REVISION_1 = 1
/** 低完整性标签，只禁止“向上写”（与交互桌面 WinSta0 上的标签一致）。 */
const LOW_LABEL_SDDL = 'S:(ML;;NW;;;LW)'
/** 设为 `inherit` 时不建专用窗口站，子进程沿用宿主的（排查问题用）。 */
export const SANDBOX_DESKTOP_ENV = 'CAIRN_SANDBOX_DESKTOP'
/** `STARTUPINFO` 与 `STARTUPINFOEX` 的大小（x64）。 */
export const STARTUPINFO_SIZE = 104
export const STARTUPINFOEX_SIZE = 112
/** `STARTUPINFO` 中 `dwFlags`、`hStdInput`、`hStdOutput`、`hStdError`、`lpAttributeList` 的偏移。 */
const SI_DESKTOP = 16
const SI_DW_FLAGS = 60
const SI_H_STD_INPUT = 80
const SI_H_STD_OUTPUT = 88
const SI_H_STD_ERROR = 96
const SI_ATTRIBUTE_LIST = 104

/** AppContainer 的网络能力 SID：internetClient / privateNetworkClientServer。 */
export const APP_CONTAINER_CAPABILITY_SIDS = {
  internet: 'S-1-15-3-1',
  private: 'S-1-15-3-3',
} as const

export interface NativeProcessInfo {
  readonly pid: number
  readonly process: Handle
  readonly thread: Handle
}

export interface NativeSpawnOptions {
  readonly token: Handle
  readonly commandLine: string
  readonly cwd: string
  readonly env: Buffer
  readonly stdin: Handle
  readonly stdout: Handle
  readonly stderr: Handle
  /** AppContainer 模式：SID 与能力 SID 字符串。 */
  readonly appContainer?: { readonly sid: Handle; readonly capabilitySids: readonly string[] }
}

export interface SandboxNativeApi {
  /** 当前用户的 SID 字符串（用于稳定的 AppContainer 名称与 ACL 授权）。 */
  currentUserSid(): string
  createRestrictedToken(level: 'low' | 'medium'): Handle
  openInheritableFile(file: string, mode: 'read' | 'write'): Handle
  openNul(): Handle
  closeHandle(handle: Handle): void
  resumeThread(thread: Handle): void
  spawn(options: NativeSpawnOptions): NativeProcessInfo
  /** 进程是否已结束。 */
  hasExited(process: Handle): boolean
  exitCode(process: Handle): number
  terminate(process: Handle): void
  /** 创建或复用 AppContainer 配置，返回 SID 与字符串形式。 */
  appContainer(name: string): { readonly sid: Handle; readonly sidString: string }
  /** 只派生 AppContainer SID，不创建配置（能力探测用）。 */
  deriveAppContainer(name: string): Handle
  deleteAppContainer(name: string): void
  sidFromString(sid: string): Handle
  sidToString(sid: Handle): string
  /** 沙箱进程用哪个桌面，以及没建专用桌面的原因（诊断用）。 */
  describeDesktop?(): string
}

interface KoffiLibrary {
  func<Result>(
    convention: string,
    name: string,
    result: KoffiType,
    args: KoffiType[],
  ): (...args: unknown[]) => Result
}

const fail = (code: string, what: string, win32?: number): never => {
  throw new SandboxError(
    code,
    win32 === undefined ? `${what} failed.` : `${what} failed (Win32 ${win32}).`,
    win32 === undefined ? {} : { win32: String(win32) },
  )
}

/** 加载 koffi 并绑定需要的函数；非 Windows 或加载失败时返回 undefined。 */
export async function loadSandboxNativeApi(
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxNativeApi | undefined> {
  if (platform !== 'win32') return undefined
  try {
    const { default: koffi } = await import('koffi')
    return createNativeApi(koffi)
  } catch {
    return undefined
  }
}

/** 用已加载的 koffi 创建绑定（测试可传入替身）。 */
export function createNativeApi(
  koffi: {
    load(name: string): KoffiLibrary
    pointer(type: unknown): KoffiType
    opaque(): KoffiType
    out(type: unknown): KoffiType
    address(value: unknown): bigint
    decode(value: unknown, type: string, length?: number): string
  },
  options: { readonly env?: NodeJS.ProcessEnv; readonly pid?: number } = {},
): SandboxNativeApi {
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const userenv = koffi.load('userenv.dll')
  const handle = koffi.pointer(koffi.opaque())
  const fn = <Result>(lib: KoffiLibrary, name: string, result: KoffiType, args: KoffiType[]) =>
    lib.func<Result>('__stdcall', name, result, args)
  const outHandle = koffi.out(koffi.pointer(handle)) as KoffiType

  const api = {
    GetCurrentProcess: fn<Handle>(kernel32, 'GetCurrentProcess', handle, []),
    GetLastError: fn<number>(kernel32, 'GetLastError', 'uint32_t', []),
    CloseHandle: fn<number>(kernel32, 'CloseHandle', 'int', [handle]),
    LocalFree: fn<unknown>(kernel32, 'LocalFree', 'void *', ['void *']),
    CreateFileW: fn<Handle>(kernel32, 'CreateFileW', handle, [
      'str16',
      'uint32_t',
      'uint32_t',
      'void *',
      'uint32_t',
      'uint32_t',
      'void *',
    ]),
    CreateProcessW: fn<number>(kernel32, 'CreateProcessW', 'int', [
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
    CreateProcessAsUserW: fn<number>(advapi32, 'CreateProcessAsUserW', 'int', [
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
    ResumeThread: fn<number>(kernel32, 'ResumeThread', 'uint32_t', [handle]),
    WaitForSingleObject: fn<number>(kernel32, 'WaitForSingleObject', 'uint32_t', [
      handle,
      'uint32_t',
    ]),
    GetExitCodeProcess: fn<number>(kernel32, 'GetExitCodeProcess', 'int', [handle, 'void *']),
    TerminateProcess: fn<number>(kernel32, 'TerminateProcess', 'int', [handle, 'uint32_t']),
    InitializeProcThreadAttributeList: fn<number>(
      kernel32,
      'InitializeProcThreadAttributeList',
      'int',
      ['void *', 'uint32_t', 'uint32_t', 'void *'],
    ),
    UpdateProcThreadAttribute: fn<number>(kernel32, 'UpdateProcThreadAttribute', 'int', [
      'void *',
      'uintptr_t',
      'void *',
      'void *',
      'size_t',
      'void *',
      'void *',
    ]),
    DeleteProcThreadAttributeList: fn<unknown>(kernel32, 'DeleteProcThreadAttributeList', 'void', [
      'void *',
    ]),
    OpenProcessToken: fn<number>(advapi32, 'OpenProcessToken', 'int', [
      handle,
      'uint32_t',
      outHandle,
    ]),
    GetTokenInformation: fn<number>(advapi32, 'GetTokenInformation', 'int', [
      handle,
      'int',
      'void *',
      'uint32_t',
      'void *',
    ]),
    CreateRestrictedToken: fn<number>(advapi32, 'CreateRestrictedToken', 'int', [
      handle,
      'uint32_t',
      'uint32_t',
      'void *',
      'uint32_t',
      'void *',
      'uint32_t',
      'void *',
      outHandle,
    ]),
    ConvertStringSidToSidW: fn<number>(advapi32, 'ConvertStringSidToSidW', 'int', [
      'str16',
      outHandle,
    ]),
    ConvertSidToStringSidW: fn<number>(advapi32, 'ConvertSidToStringSidW', 'int', [
      handle,
      outHandle,
    ]),
    SetTokenInformation: fn<number>(advapi32, 'SetTokenInformation', 'int', [
      handle,
      'int',
      'void *',
      'uint32_t',
    ]),
    CreateAppContainerProfile: fn<number>(userenv, 'CreateAppContainerProfile', 'int32_t', [
      'str16',
      'str16',
      'str16',
      'void *',
      'uint32_t',
      outHandle,
    ]),
    DeriveAppContainerSidFromAppContainerName: fn<number>(
      userenv,
      'DeriveAppContainerSidFromAppContainerName',
      'int',
      ['str16', outHandle],
    ),
    DeleteAppContainerProfile: fn<number>(userenv, 'DeleteAppContainerProfile', 'int32_t', [
      'str16',
    ]),
  }

  /** user32 只在需要专用窗口站时加载。 */
  let user32Api:
    | {
        GetProcessWindowStation: () => Handle
        SetProcessWindowStation: (station: Handle) => number
        GetUserObjectInformationW: (...args: unknown[]) => number
        CreateWindowStationW: (...args: unknown[]) => Handle
        CreateDesktopW: (...args: unknown[]) => Handle
        CloseWindowStation: (station: Handle) => number
      }
    | undefined
  const user32 = () => {
    if (user32Api) return user32Api
    const lib = koffi.load('user32.dll')
    user32Api = {
      GetProcessWindowStation: fn<Handle>(lib, 'GetProcessWindowStation', handle, []),
      SetProcessWindowStation: fn<number>(lib, 'SetProcessWindowStation', 'int', [handle]),
      GetUserObjectInformationW: fn<number>(lib, 'GetUserObjectInformationW', 'int', [
        handle,
        'int',
        'void *',
        'uint32_t',
        'void *',
      ]),
      CreateWindowStationW: fn<Handle>(lib, 'CreateWindowStationW', handle, [
        'str16',
        'uint32_t',
        'uint32_t',
        'void *',
      ]),
      CreateDesktopW: fn<Handle>(lib, 'CreateDesktopW', handle, [
        'str16',
        'void *',
        'void *',
        'uint32_t',
        'uint32_t',
        'void *',
      ]),
      CloseWindowStation: fn<number>(lib, 'CloseWindowStation', 'int', [handle]),
    }
    return user32Api
  }
  const security = {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: fn<number>(
      advapi32,
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
      'int',
      ['str16', 'uint32_t', outHandle, 'void *'],
    ),
    GetSecurityDescriptorSacl: fn<number>(advapi32, 'GetSecurityDescriptorSacl', 'int', [
      handle,
      'void *',
      outHandle,
      'void *',
    ]),
    SetSecurityInfo: fn<number>(advapi32, 'SetSecurityInfo', 'uint32_t', [
      handle,
      'int',
      'uint32_t',
      'void *',
      'void *',
      'void *',
      handle,
    ]),
  }

  const lastError = () => Number(api.GetLastError()) as number
  const check = (value: unknown, what: string, code: string = SandboxErrorCode.SetupFailed) => {
    if (!value) fail(code, what, lastError())
  }

  const sidFromString = (sid: string): Handle => {
    const out: unknown[] = [null]
    check(api.ConvertStringSidToSidW(sid, out), `ConvertStringSidToSidW(${sid})`)
    return out[0] as Handle
  }

  const sidToString = (sid: Handle): string => {
    const out: unknown[] = [null]
    check(api.ConvertSidToStringSidW(sid, out), 'ConvertSidToStringSidW')
    try {
      return koffi.decode(out[0], 'char16_t', 184).split('\0')[0]!
    } finally {
      api.LocalFree(out[0])
    }
  }

  const appContainerSid = (name: string): Handle => {
    const out: unknown[] = [null]
    const result = Number(
      api.CreateAppContainerProfile(name, 'Cairn', 'Cairn command sandbox', null, 0, out),
    )
    if (result >>> 0 === ERROR_ALREADY_EXISTS_HRESULT) {
      const derived: unknown[] = [null]
      const derivedResult = Number(api.DeriveAppContainerSidFromAppContainerName(name, derived))
      if (derivedResult >>> 0 !== 0) {
        throw new SandboxError(
          SandboxErrorCode.AppContainerFailed,
          `DeriveAppContainerSidFromAppContainerName failed (HRESULT 0x${(derivedResult >>> 0).toString(16)}).`,
        )
      }
      return derived[0] as Handle
    }
    if (result >>> 0 === 0 && out[0]) return out[0] as Handle
    if (result >>> 0 === 0) fail(SandboxErrorCode.AppContainerFailed, 'CreateAppContainerProfile')
    throw new SandboxError(
      SandboxErrorCode.AppContainerFailed,
      `CreateAppContainerProfile failed (HRESULT 0x${(result >>> 0).toString(16)}).`,
    )
  }

  const currentUserSid = (): string => {
    const token: unknown[] = [null]
    check(api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_QUERY, token), 'OpenProcessToken')
    try {
      const needed = Buffer.alloc(4)
      api.GetTokenInformation(token[0], TOKEN_USER, null, 0, needed)
      const size = needed.readUInt32LE(0)
      if (lastError() !== ERROR_INSUFFICIENT_BUFFER) {
        fail(SandboxErrorCode.SetupFailed, 'GetTokenInformation', lastError())
      }
      const info = Buffer.alloc(size)
      check(
        api.GetTokenInformation(token[0], TOKEN_USER, info, size, needed),
        'GetTokenInformation',
      )
      return sidToString(info.readBigUInt64LE(0))
    } finally {
      api.CloseHandle(token[0])
    }
  }

  const startupInfo = (stdin: Handle, stdout: Handle, stderr: Handle): Buffer => {
    const info = Buffer.alloc(STARTUPINFO_SIZE)
    info.writeUInt32LE(STARTUPINFO_SIZE, 0)
    info.writeUInt32LE(STARTF_USESTDHANDLES, SI_DW_FLAGS)
    info.writeBigUInt64LE(stdin, SI_H_STD_INPUT)
    info.writeBigUInt64LE(stdout, SI_H_STD_OUTPUT)
    info.writeBigUInt64LE(stderr, SI_H_STD_ERROR)
    return info
  }

  const objectName = (object: Handle): string => {
    const buffer = Buffer.alloc(512)
    const needed = Buffer.alloc(4)
    if (!user32().GetUserObjectInformationW(object, UOI_NAME, buffer, buffer.length, needed)) {
      return ''
    }
    return buffer.toString('utf16le').split('\0')[0]!
  }

  /** 给窗口站或桌面加低完整性标签，让低完整性的沙箱进程能连上。失败时返回原因。 */
  const setLowLabel = (object: Handle): string | undefined => {
    const descriptor: unknown[] = [null]
    if (
      !security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        LOW_LABEL_SDDL,
        SDDL_REVISION_1,
        descriptor,
        null,
      )
    ) {
      return `ConvertStringSecurityDescriptorToSecurityDescriptorW (${lastError()})`
    }
    try {
      const present = Buffer.alloc(4)
      const defaulted = Buffer.alloc(4)
      const sacl: unknown[] = [null]
      if (!security.GetSecurityDescriptorSacl(descriptor[0], present, sacl, defaulted)) {
        return `GetSecurityDescriptorSacl (${lastError()})`
      }
      const result = Number(
        security.SetSecurityInfo(
          object,
          SE_WINDOW_OBJECT,
          LABEL_SECURITY_INFORMATION,
          null,
          null,
          null,
          sacl[0],
        ),
      )
      return result === 0 ? undefined : `SetSecurityInfo (${result})`
    } finally {
      api.LocalFree(descriptor[0])
    }
  }

  /**
   * 沙箱进程用的桌面（`STARTUPINFO.lpDesktop`）。
   *
   * 从资源管理器启动时宿主在交互窗口站 `WinSta0` 上，那里的窗口站与桌面本来就带低完整性标签，子进程直接
   * 沿用。从服务、CI 或某些受限终端启动时，宿主所在的窗口站是创建者的完整性（常为中或高），低完整性的
   * 沙箱进程连不上，user32 初始化失败，进程以 `0xC0000142` 退出。这时建一个专用窗口站与桌面、加低完整性
   * 标签，让子进程在那里启动。句柄在宿主存活期间一直保留，桌面在最后一个句柄关闭时由系统销毁。
   * 任何一步失败都退回沿用宿主的桌面（之后若子进程起不来，按 `sandbox.child_start_failed` 处理）。
   */
  let desktop: Buffer | null | undefined
  let desktopNote = 'not used yet'
  const sandboxDesktop = (): Buffer | null => {
    if (desktop !== undefined) return desktop
    desktop = null
    const skip = (note: string) => {
      desktopNote = note
      return null
    }
    if ((options.env ?? process.env)[SANDBOX_DESKTOP_ENV] === 'inherit') return skip('inherit')
    try {
      const u = user32()
      const current = u.GetProcessWindowStation()
      const stationName = current ? objectName(current) : ''
      // 读不到名称时不冒险改动，沿用宿主的桌面
      if (!stationName) return skip(`station name unavailable (${lastError()})`)
      if (stationName.toLowerCase() === 'winsta0') return skip('interactive WinSta0')
      const name = `CairnSandbox-${options.pid ?? process.pid}`
      const station = u.CreateWindowStationW(name, 0, WINSTA_ALL_ACCESS, null)
      if (!station) return skip(`CreateWindowStationW failed (${lastError()}) on ${stationName}`)
      const stationLabel = setLowLabel(station)
      if (stationLabel) {
        u.CloseWindowStation(station)
        return skip(`label station: ${stationLabel}`)
      }
      if (!u.SetProcessWindowStation(station)) {
        const error = lastError()
        u.CloseWindowStation(station)
        return skip(`SetProcessWindowStation failed (${error})`)
      }
      let created: Handle
      try {
        created = u.CreateDesktopW('Default', null, null, 0, GENERIC_ALL, null)
      } finally {
        u.SetProcessWindowStation(current)
      }
      if (!created) {
        const error = lastError()
        u.CloseWindowStation(station)
        return skip(`CreateDesktopW failed (${error})`)
      }
      const desktopLabel = setLowLabel(created)
      if (desktopLabel) {
        u.CloseWindowStation(station)
        return skip(`label desktop: ${desktopLabel}`)
      }
      desktop = Buffer.from(`${name}\\Default\0`, 'utf16le')
      desktopNote = `${name}\\Default (host on ${stationName})`
    } catch (error) {
      desktop = null
      desktopNote = `error: ${error instanceof Error ? error.message : String(error)}`
    }
    return desktop
  }

  const spawnWithToken = (options: NativeSpawnOptions): NativeProcessInfo => {
    const commandLine = Buffer.from(`${options.commandLine}\0`, 'utf16le')
    const info = startupInfo(options.stdin, options.stdout, options.stderr)
    const target = sandboxDesktop()
    if (target) info.writeBigUInt64LE(koffi.address(target), SI_DESKTOP)
    const processInfo = Buffer.alloc(24)
    const flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    const create = (extraFlags: number) =>
      api.CreateProcessAsUserW(
        options.token,
        null,
        commandLine,
        null,
        null,
        1,
        flags | extraFlags,
        options.env,
        options.cwd,
        info,
        processInfo,
      )
    // 宿主可能是 Electron 的实用进程（Chromium 会把它放进作业对象）：子进程默认继承整个作业及其限制，
    // 在部分机器上会让子进程以 DLL 初始化失败（0xC0000142）退出。先尝试脱离宿主作业——之后仍由本模块
    // 自己的作业对象接管，超时与结束语义不变；宿主作业不允许脱离（ERROR_ACCESS_DENIED）时按原样启动。
    let ok = create(CREATE_BREAKAWAY_FROM_JOB)
    let error = ok ? 0 : lastError()
    if (!ok && error === ERROR_ACCESS_DENIED) {
      ok = create(0)
      error = ok ? 0 : lastError()
    }
    if (!ok) fail(SandboxErrorCode.SpawnFailed, 'CreateProcessAsUserW', error)
    return {
      pid: processInfo.readUInt32LE(16),
      process: processInfo.readBigUInt64LE(0),
      thread: processInfo.readBigUInt64LE(8),
    }
  }

  const spawnInAppContainer = (options: NativeSpawnOptions): NativeProcessInfo => {
    const appContainer = options.appContainer!
    const commandLine = Buffer.from(`${options.commandLine}\0`, 'utf16le')
    const info = Buffer.alloc(STARTUPINFOEX_SIZE)
    info.writeUInt32LE(STARTUPINFOEX_SIZE, 0)
    info.writeUInt32LE(STARTF_USESTDHANDLES, SI_DW_FLAGS)
    info.writeBigUInt64LE(options.stdin, SI_H_STD_INPUT)
    info.writeBigUInt64LE(options.stdout, SI_H_STD_OUTPUT)
    info.writeBigUInt64LE(options.stderr, SI_H_STD_ERROR)

    const size = Buffer.alloc(8)
    api.InitializeProcThreadAttributeList(null, 1, 0, size)
    const attributeSize = Number(size.readBigUInt64LE(0))
    if (attributeSize === 0)
      fail(SandboxErrorCode.SpawnFailed, 'InitializeProcThreadAttributeList', lastError())
    const attributes = Buffer.alloc(attributeSize)
    let initialized = false
    const capabilityHandles: Handle[] = []
    try {
      check(
        api.InitializeProcThreadAttributeList(attributes, 1, 0, size),
        'InitializeProcThreadAttributeList',
        SandboxErrorCode.SpawnFailed,
      )
      initialized = true
      const capabilityBuffer = Buffer.alloc(Math.max(1, appContainer.capabilitySids.length) * 16)
      for (let i = 0; i < appContainer.capabilitySids.length; i++) {
        const sid = sidFromString(appContainer.capabilitySids[i]!)
        capabilityHandles.push(sid)
        capabilityBuffer.writeBigUInt64LE(sid, i * 16)
        capabilityBuffer.writeUInt32LE(SE_GROUP_ENABLED, i * 16 + 8)
      }
      const security = Buffer.alloc(24)
      security.writeBigUInt64LE(appContainer.sid, 0)
      security.writeBigUInt64LE(
        appContainer.capabilitySids.length > 0 ? koffi.address(capabilityBuffer) : 0n,
        8,
      )
      security.writeUInt32LE(appContainer.capabilitySids.length, 16)
      security.writeUInt32LE(0, 20)
      check(
        api.UpdateProcThreadAttribute(
          attributes,
          0,
          PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          security,
          security.length,
          null,
          null,
        ),
        'UpdateProcThreadAttribute(SECURITY_CAPABILITIES)',
        SandboxErrorCode.SpawnFailed,
      )
      info.writeBigUInt64LE(koffi.address(attributes), SI_ATTRIBUTE_LIST)
      const processInfo = Buffer.alloc(24)
      const ok = api.CreateProcessW(
        null,
        commandLine,
        null,
        null,
        1,
        EXTENDED_STARTUPINFO_PRESENT |
          CREATE_SUSPENDED |
          CREATE_NO_WINDOW |
          CREATE_UNICODE_ENVIRONMENT,
        options.env,
        options.cwd,
        info,
        processInfo,
      )
      if (!ok) fail(SandboxErrorCode.SpawnFailed, 'CreateProcessW(AppContainer)', lastError())
      return {
        pid: processInfo.readUInt32LE(16),
        process: processInfo.readBigUInt64LE(0),
        thread: processInfo.readBigUInt64LE(8),
      }
    } finally {
      if (initialized) api.DeleteProcThreadAttributeList(attributes)
      for (const sid of capabilityHandles) api.CloseHandle(sid)
    }
  }

  return {
    currentUserSid,
    describeDesktop: () => desktopNote,
    createRestrictedToken(level) {
      const token: unknown[] = [null]
      check(
        api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_ALL_ACCESS, token),
        'OpenProcessToken',
      )
      try {
        const restricted: unknown[] = [null]
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
        const labelSid = sidFromString(level === 'low' ? 'S-1-16-4096' : 'S-1-16-8192')
        try {
          const label = Buffer.alloc(16)
          label.writeBigUInt64LE(labelSid, 0)
          label.writeUInt32LE(0, 8)
          if (!api.SetTokenInformation(restricted[0], TOKEN_INTEGRITY_LEVEL, label, label.length)) {
            api.CloseHandle(restricted[0])
            fail(
              SandboxErrorCode.SetupFailed,
              'SetTokenInformation(TokenIntegrityLevel)',
              lastError(),
            )
          }
          return restricted[0] as Handle
        } finally {
          api.CloseHandle(labelSid)
        }
      } finally {
        api.CloseHandle(token[0])
      }
    },
    openInheritableFile(file, mode) {
      const attributes = Buffer.alloc(24)
      attributes.writeUInt32LE(24, 0)
      attributes.writeUInt32LE(1, 16)
      const access = mode === 'write' ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ
      const created = api.CreateFileW(
        file,
        access,
        FILE_SHARE_READ_WRITE,
        attributes,
        mode === 'write' ? CREATE_ALWAYS : OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        null,
      )
      if (!created) fail(SandboxErrorCode.SetupFailed, `CreateFileW(${file})`, lastError())
      return created as Handle
    },
    openNul() {
      const attributes = Buffer.alloc(24)
      attributes.writeUInt32LE(24, 0)
      attributes.writeUInt32LE(1, 16)
      const created = api.CreateFileW(
        'NUL',
        GENERIC_READ,
        FILE_SHARE_READ_WRITE,
        attributes,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        null,
      )
      if (!created) fail(SandboxErrorCode.SetupFailed, 'CreateFileW(NUL)', lastError())
      return created as Handle
    },
    closeHandle(handle) {
      api.CloseHandle(handle)
    },
    resumeThread(thread) {
      api.ResumeThread(thread)
    },
    spawn(options) {
      return options.appContainer ? spawnInAppContainer(options) : spawnWithToken(options)
    },
    hasExited(process) {
      return Number(api.WaitForSingleObject(process, 0)) === WAIT_OBJECT_0
    },
    exitCode(process) {
      const code = Buffer.alloc(4)
      check(api.GetExitCodeProcess(process, code), 'GetExitCodeProcess')
      return code.readUInt32LE(0)
    },
    terminate(process) {
      api.TerminateProcess(process, 1)
    },
    appContainer(name) {
      const sid = appContainerSid(name)
      return { sid, sidString: sidToString(sid) }
    },
    deriveAppContainer(name) {
      const out: unknown[] = [null]
      const result = Number(api.DeriveAppContainerSidFromAppContainerName(name, out))
      if (result >>> 0 !== 0) {
        throw new SandboxError(
          SandboxErrorCode.AppContainerFailed,
          `DeriveAppContainerSidFromAppContainerName failed (HRESULT 0x${(result >>> 0).toString(16)}).`,
        )
      }
      return out[0] as Handle
    },
    deleteAppContainer(name) {
      api.DeleteAppContainerProfile(name)
    },
    sidFromString,
    sidToString,
  }
}
