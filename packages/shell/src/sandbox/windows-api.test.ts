/**
 * `createNativeApi` 的绑定测试（M5-04）：用假的 koffi 校验参数、缓冲区布局与失败路径。
 * 真实 Win32 调用由 `restricted.test.ts` 的假 API 与手工命令矩阵覆盖；这里不启动进程，也不改 ACL。
 */
import { describe, expect, it } from 'vitest'
import { SandboxError } from './types.js'
import {
  CREATE_BREAKAWAY_FROM_JOB,
  CREATE_NO_WINDOW,
  CREATE_SUSPENDED,
  STARTUPINFO_SIZE,
  STARTUPINFOEX_SIZE,
  createNativeApi,
  loadSandboxNativeApi,
} from './windows-api.js'

type Handler = (...args: never[]) => unknown

/** 读用户 SID 时先报缓冲区不足（122），之后报给定的错误码。 */
const lastErrors = (error: number): Handler => {
  let calls = 0
  return (() => (calls++ === 0 ? 122 : error)) as Handler
}

interface FakeOptions {
  handlers?: Record<string, Handler>
}

function fakeKoffi(options: FakeOptions = {}) {
  const calls: { name: string; args: unknown[] }[] = []
  const libs: string[] = []
  const state = { lastError: 0 }
  const writeProcess = (info: Buffer, pid = 4321, process = 0xa1n, thread = 0xb2n) => {
    info.writeBigUInt64LE(process, 0)
    info.writeBigUInt64LE(thread, 8)
    info.writeUInt32LE(pid, 16)
  }
  const defaults: Record<string, Handler> = {
    GetCurrentProcess: (() => 1n) as Handler,
    GetLastError: (() => state.lastError) as Handler,
    CloseHandle: (() => 1) as Handler,
    LocalFree: (() => 0) as Handler,
    CreateFileW: (() => 10n) as Handler,
    CreateProcessW: ((...args: unknown[]) => {
      writeProcess(args[9] as Buffer)
      return 1
    }) as Handler,
    CreateProcessAsUserW: ((...args: unknown[]) => {
      writeProcess(args[10] as Buffer)
      return 1
    }) as Handler,
    ResumeThread: (() => 1) as Handler,
    WaitForSingleObject: (() => 0) as Handler,
    GetExitCodeProcess: ((_handle: unknown, buffer: Buffer) => {
      buffer.writeUInt32LE(7, 0)
      return 1
    }) as Handler,
    TerminateProcess: (() => 1) as Handler,
    InitializeProcThreadAttributeList: ((
      attributes: unknown,
      _count: unknown,
      _flags: unknown,
      size: Buffer,
    ) => {
      if (attributes === null) {
        size.writeBigUInt64LE(64n, 0)
        return 0
      }
      return 1
    }) as Handler,
    UpdateProcThreadAttribute: (() => 1) as Handler,
    DeleteProcThreadAttributeList: (() => undefined) as Handler,
    OpenProcessToken: ((_process: unknown, _access: unknown, out: unknown[]) => {
      out[0] = 100n
      return 1
    }) as Handler,
    GetTokenInformation: ((
      _token: unknown,
      _class: unknown,
      info: Buffer | null,
      _length: unknown,
      needed: Buffer,
    ) => {
      if (info === null) {
        needed.writeUInt32LE(24, 0)
        state.lastError = 122
        return 0
      }
      info.writeBigUInt64LE(0x200n, 0)
      return 1
    }) as Handler,
    CreateRestrictedToken: ((...args: unknown[]) => {
      const out = args[args.length - 1] as unknown[]
      out[0] = 300n
      return 1
    }) as Handler,
    ConvertStringSidToSidW: ((_sid: unknown, out: unknown[]) => {
      out[0] = 0x400n
      return 1
    }) as Handler,
    ConvertSidToStringSidW: ((_sid: unknown, out: unknown[]) => {
      out[0] = 0x500n
      return 1
    }) as Handler,
    SetTokenInformation: (() => 1) as Handler,
    ConvertStringSecurityDescriptorToSecurityDescriptorW: ((
      _sddl: unknown,
      _revision: unknown,
      out: unknown[],
    ) => {
      out[0] = 0x800n
      return 1
    }) as Handler,
    GetSecurityDescriptorDacl: ((_descriptor: unknown, present: Buffer, out: unknown[]) => {
      present.writeUInt32LE(1, 0)
      out[0] = 0x810n
      return 1
    }) as Handler,
    CreateAppContainerProfile: ((...args: unknown[]) => {
      const out = args[args.length - 1] as unknown[]
      out[0] = 0x600n
      return 0
    }) as Handler,
    DeriveAppContainerSidFromAppContainerName: ((_name: unknown, out: unknown[]) => {
      out[0] = 0x700n
      return 0
    }) as Handler,
    DeleteAppContainerProfile: (() => 0) as Handler,
  }
  const handlers = { ...defaults, ...options.handlers }
  const koffi = {
    load(name: string) {
      libs.push(name)
      return {
        func(_convention: string, name: string) {
          return (...args: unknown[]) => {
            calls.push({ name, args })
            return handlers[name]!(...(args as never[]))
          }
        },
      }
    },
    pointer: (type: unknown) => type,
    opaque: () => 'opaque',
    out: (type: unknown) => type,
    address: () => 0x9000n,
    decode: () => 'S-1-5-21-1',
  }
  const api = createNativeApi(koffi as never)
  const called = (name: string) => calls.filter((call) => call.name === name)
  return { api, calls, called, libs, state }
}

describe('loadSandboxNativeApi', () => {
  it('skips non-Windows platforms', async () => {
    await expect(loadSandboxNativeApi('linux')).resolves.toBeUndefined()
  })

  it('either loads koffi or fails closed', async () => {
    const loaded = await loadSandboxNativeApi('win32')
    if (loaded) expect(typeof loaded.currentUserSid).toBe('function')
    else expect(loaded).toBeUndefined()
  })
})

describe('createNativeApi', () => {
  it('binds kernel32, advapi32 and userenv', () => {
    const { libs } = fakeKoffi()
    expect(libs).toEqual(['kernel32.dll', 'advapi32.dll', 'userenv.dll'])
  })

  it('resolves the current user SID and closes the token', () => {
    const { api, called } = fakeKoffi()
    expect(api.currentUserSid()).toBe('S-1-5-21-1')
    const [open] = called('OpenProcessToken')
    expect(open!.args.slice(0, 2)).toEqual([1n, 0x0008])
    expect(called('CloseHandle')[0]!.args).toEqual([100n])
    expect(called('ConvertSidToStringSidW')[0]!.args[0]).toBe(0x200n)
    expect(called('LocalFree')).toHaveLength(1)
  })

  it('fails when the user token cannot be queried', () => {
    const { api } = fakeKoffi({
      handlers: {
        GetTokenInformation: (() => 0) as Handler,
      },
    })
    expect(() => api.currentUserSid()).toThrow(SandboxError)
    expect(() => api.currentUserSid()).toThrow(/GetTokenInformation failed/)
  })

  it('creates a low-integrity restricted token', () => {
    const { api, called } = fakeKoffi()
    expect(api.createRestrictedToken('low')).toBe(300n)
    expect(called('ConvertStringSidToSidW')[0]!.args[0]).toBe('S-1-16-4096')
    const set = called('SetTokenInformation')[0]!
    expect(set.args[0]).toBe(300n)
    expect(set.args[1]).toBe(25)
    const label = set.args[2] as Buffer
    expect(label).toHaveLength(16)
    expect(label.readBigUInt64LE(0)).toBe(0x400n)
    // 先关标签 SID，再关读用户 SID 的令牌与父进程令牌
    expect(called('CloseHandle').map((call) => call.args[0])).toEqual([0x400n, 100n, 100n])
  })

  it('replaces the default DACL so the child can open its own process object', () => {
    const { api, called } = fakeKoffi()
    api.createRestrictedToken('low')
    const [convert] = called('ConvertStringSecurityDescriptorToSecurityDescriptorW')
    expect(convert!.args.slice(0, 2)).toEqual(['D:(A;;GA;;;S-1-5-21-1)(A;;GA;;;SY)', 1])
    expect(called('GetSecurityDescriptorDacl')[0]!.args[0]).toBe(0x800n)
    const set = called('SetTokenInformation')[1]!
    expect(set.args.slice(0, 2)).toEqual([300n, 6])
    expect((set.args[2] as Buffer).readBigUInt64LE(0)).toBe(0x810n)
    expect(set.args[3]).toBe(8)
    expect(called('LocalFree').map((call) => call.args[0])).toContain(0x800n)
  })

  it('takes the DACL address from a pointer object', () => {
    const { api, called } = fakeKoffi({
      handlers: {
        GetSecurityDescriptorDacl: ((_descriptor: unknown, _present: unknown, out: unknown[]) => {
          out[0] = { pointer: true }
          return 1
        }) as Handler,
      },
    })
    api.createRestrictedToken('low')
    expect((called('SetTokenInformation')[1]!.args[2] as Buffer).readBigUInt64LE(0)).toBe(0x9000n)
  })

  it.each([
    ['ConvertStringSecurityDescriptorToSecurityDescriptorW', false],
    ['GetSecurityDescriptorDacl', true],
  ])('closes the restricted token when %s fails', (name, frees) => {
    const { api, called } = fakeKoffi({
      handlers: { [name]: (() => 0) as Handler, GetLastError: lastErrors(87) },
    })
    expect(() => api.createRestrictedToken('low')).toThrow(new RegExp(`${name} failed`))
    expect(called('CloseHandle').map((call) => call.args[0])).toContain(300n)
    expect(called('LocalFree').some((call) => call.args[0] === 0x800n)).toBe(frees)
  })

  it('closes the restricted token when the default DACL cannot be set', () => {
    let calls = 0
    const { api, called } = fakeKoffi({
      handlers: {
        SetTokenInformation: (() => (++calls === 1 ? 1 : 0)) as Handler,
        GetLastError: lastErrors(5),
      },
    })
    expect(() => api.createRestrictedToken('low')).toThrow(
      /SetTokenInformation\(TokenDefaultDacl\) failed \(Win32 5\)/,
    )
    expect(called('CloseHandle').map((call) => call.args[0])).toEqual([0x400n, 100n, 300n, 100n])
    expect(called('LocalFree').map((call) => call.args[0])).toContain(0x800n)
  })

  it('uses a medium label and closes the restricted token when it cannot be set', () => {
    const ok = fakeKoffi()
    ok.api.createRestrictedToken('medium')
    expect(ok.called('ConvertStringSidToSidW')[0]!.args[0]).toBe('S-1-16-8192')

    const failing = fakeKoffi({
      handlers: {
        SetTokenInformation: (() => 0) as Handler,
        GetLastError: (() => 5) as Handler,
      },
    })
    const error = (() => {
      try {
        failing.api.createRestrictedToken('low')
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toMatchObject({ code: 'sandbox.setup_failed', params: { win32: '5' } })
    expect(failing.called('CloseHandle').map((call) => call.args[0])).toEqual([300n, 0x400n, 100n])
  })

  it('opens inheritable output files and NUL', () => {
    const { api, called } = fakeKoffi()
    expect(api.openInheritableFile('C:\\out.log', 'write')).toBe(10n)
    expect(api.openInheritableFile('C:\\in.log', 'read')).toBe(10n)
    expect(api.openNul()).toBe(10n)
    const writes = called('CreateFileW')
    expect(writes[0]!.args[0]).toBe('C:\\out.log')
    expect(Number(writes[0]!.args[1]) >>> 0).toBe(0xc0000000)
    expect(writes[0]!.args[4]).toBe(2)
    expect(Number(writes[1]!.args[1]) >>> 0).toBe(0x80000000)
    expect(writes[1]!.args[4]).toBe(3)
    const attributes = writes[0]!.args[3] as Buffer
    expect(attributes.readUInt32LE(0)).toBe(24)
    expect(attributes.readUInt32LE(16)).toBe(1)
    expect(writes[2]!.args[0]).toBe('NUL')
  })

  it('fails closed when a handle cannot be opened', () => {
    const file = fakeKoffi({
      handlers: { CreateFileW: (() => 0n) as Handler, GetLastError: (() => 2) as Handler },
    })
    expect(() => file.api.openInheritableFile('C:\\missing', 'write')).toThrow(
      /CreateFileW\(C:\\missing\) failed \(Win32 2\)/,
    )
    expect(() => file.api.openNul()).toThrow(/CreateFileW\(NUL\)/)
  })

  it('starts a suspended process with the restricted token', () => {
    const { api, called } = fakeKoffi()
    const env = Buffer.from('PATH=C:\\bin\0', 'utf16le')
    expect(
      api.spawn({
        token: 300n,
        commandLine: 'cmd.exe /c echo hi',
        cwd: 'C:\\work',
        env,
        stdin: 1n,
        stdout: 2n,
        stderr: 3n,
      }),
    ).toEqual({ pid: 4321, process: 0xa1n, thread: 0xb2n })
    const [spawn] = called('CreateProcessAsUserW')
    const args = spawn!.args
    expect(args[0]).toBe(300n)
    expect((args[2] as Buffer).toString('utf16le')).toBe('cmd.exe /c echo hi\0')
    expect(args[5]).toBe(1)
    expect(args[6]).toBe(
      CREATE_SUSPENDED | CREATE_NO_WINDOW | 0x0000_0400 | CREATE_BREAKAWAY_FROM_JOB,
    )
    expect(args[7]).toBe(env)
    expect(args[8]).toBe('C:\\work')
    const startup = args[9] as Buffer
    expect(startup).toHaveLength(STARTUPINFO_SIZE)
    expect(startup.readUInt32LE(0)).toBe(STARTUPINFO_SIZE)
    expect(startup.readUInt32LE(60)).toBe(0x0000_0100)
    expect(startup.readBigUInt64LE(80)).toBe(1n)
    expect(startup.readBigUInt64LE(88)).toBe(2n)
    expect(startup.readBigUInt64LE(96)).toBe(3n)
  })

  it('reports a failed restricted-token spawn', () => {
    const { api, called } = fakeKoffi({
      handlers: { CreateProcessAsUserW: (() => 0) as Handler, GetLastError: (() => 87) as Handler },
    })
    expect(() =>
      api.spawn({
        token: 300n,
        commandLine: 'x',
        cwd: 'C:\\work',
        env: Buffer.alloc(0),
        stdin: 1n,
        stdout: 2n,
        stderr: 3n,
      }),
    ).toThrow(/CreateProcessAsUserW failed \(Win32 87\)/)
    // 只有宿主作业禁止脱离时才重试一次；其他错误不重试
    expect(called('CreateProcessAsUserW')).toHaveLength(1)
  })

  it('retries without breaking away when the host job forbids it', () => {
    let attempts = 0
    const { api, called } = fakeKoffi({
      handlers: {
        CreateProcessAsUserW: ((...args: unknown[]) => {
          attempts += 1
          if (attempts === 1) return 0
          const info = args[10] as Buffer
          info.writeBigUInt64LE(0xa1n, 0)
          info.writeBigUInt64LE(0xb2n, 8)
          info.writeUInt32LE(4321, 16)
          return 1
        }) as Handler,
        GetLastError: (() => 5) as Handler,
      },
    })
    expect(
      api.spawn({
        token: 300n,
        commandLine: 'cmd.exe /c echo hi',
        cwd: 'C:\\work',
        env: Buffer.alloc(0),
        stdin: 1n,
        stdout: 2n,
        stderr: 3n,
      }),
    ).toEqual({ pid: 4321, process: 0xa1n, thread: 0xb2n })
    const calls = called('CreateProcessAsUserW')
    expect(calls).toHaveLength(2)
    const base = CREATE_SUSPENDED | CREATE_NO_WINDOW | 0x0000_0400
    expect(calls[0]!.args[6]).toBe(base | CREATE_BREAKAWAY_FROM_JOB)
    expect(calls[1]!.args[6]).toBe(base)
  })

  it('starts an AppContainer process with network capabilities', () => {
    const { api, called } = fakeKoffi()
    expect(
      api.spawn({
        token: 0n,
        commandLine: 'cmd.exe',
        cwd: 'C:\\work',
        env: Buffer.alloc(0),
        stdin: 1n,
        stdout: 2n,
        stderr: 3n,
        appContainer: { sid: 0x600n, capabilitySids: ['S-1-15-3-1'] },
      }),
    ).toEqual({ pid: 4321, process: 0xa1n, thread: 0xb2n })
    expect(called('ConvertStringSidToSidW')[0]!.args[0]).toBe('S-1-15-3-1')
    expect(called('InitializeProcThreadAttributeList')).toHaveLength(2)
    expect(called('UpdateProcThreadAttribute')[0]!.args[1]).toBe(0)
    expect(called('DeleteProcThreadAttributeList')).toHaveLength(1)
    expect(called('CloseHandle').map((call) => call.args[0])).toContain(0x400n)
    const [spawn] = called('CreateProcessW')
    expect(spawn!.args[5]).toBe(CREATE_SUSPENDED | CREATE_NO_WINDOW | 0x0000_0400 | 0x0008_0000)
    expect(spawn!.args[6]).toEqual(expect.any(Buffer))
    const startup = spawn!.args[8] as Buffer
    expect(startup).toHaveLength(STARTUPINFOEX_SIZE)
    expect(startup.readBigUInt64LE(104)).toBe(0x9000n)
  })

  it('starts an AppContainer process without capability SIDs', () => {
    const { api, called } = fakeKoffi()
    api.spawn({
      token: 0n,
      commandLine: 'cmd.exe',
      cwd: 'C:\\work',
      env: Buffer.alloc(0),
      stdin: 1n,
      stdout: 2n,
      stderr: 3n,
      appContainer: { sid: 0x600n, capabilitySids: [] },
    })
    expect(called('ConvertStringSidToSidW')).toHaveLength(0)
  })

  it('fails when the AppContainer attributes cannot be prepared', () => {
    const noSize = fakeKoffi({
      handlers: {
        InitializeProcThreadAttributeList: ((
          _attributes: unknown,
          _count: unknown,
          _flags: unknown,
          size: Buffer,
        ) => {
          size.writeBigUInt64LE(0n, 0)
          return 0
        }) as Handler,
        GetLastError: (() => 8) as Handler,
      },
    })
    const spawn = (target: ReturnType<typeof fakeKoffi>) =>
      target.api.spawn({
        token: 0n,
        commandLine: 'cmd.exe',
        cwd: 'C:\\work',
        env: Buffer.alloc(0),
        stdin: 1n,
        stdout: 2n,
        stderr: 3n,
        appContainer: { sid: 0x600n, capabilitySids: [] },
      })
    expect(() => spawn(noSize)).toThrow(/InitializeProcThreadAttributeList failed/)

    const allocation = fakeKoffi({
      handlers: {
        InitializeProcThreadAttributeList: ((
          attributes: unknown,
          _count: unknown,
          _flags: unknown,
          size: Buffer,
        ) => {
          if (attributes === null) {
            size.writeBigUInt64LE(64n, 0)
            return 0
          }
          return 0
        }) as Handler,
      },
    })
    expect(() => spawn(allocation)).toThrow(/InitializeProcThreadAttributeList failed/)

    const update = fakeKoffi({
      handlers: { UpdateProcThreadAttribute: (() => 0) as Handler },
    })
    expect(() => spawn(update)).toThrow(/UpdateProcThreadAttribute.*SECURITY_CAPABILITIES.* failed/)

    const process = fakeKoffi({
      handlers: { CreateProcessW: (() => 0) as Handler },
    })
    expect(() => spawn(process)).toThrow(/CreateProcessW\(AppContainer\) failed/)
  })

  it('creates and reuses AppContainer profiles', () => {
    const created = fakeKoffi()
    expect(created.api.appContainer('com.cairn.sandbox.test')).toEqual({
      sid: 0x600n,
      sidString: 'S-1-5-21-1',
    })
    expect(created.called('CreateAppContainerProfile')[0]!.args.slice(0, 5)).toEqual([
      'com.cairn.sandbox.test',
      'Cairn',
      'Cairn command sandbox',
      null,
      0,
    ])

    const existing = fakeKoffi({
      handlers: {
        CreateAppContainerProfile: ((...args: unknown[]) => {
          void args
          return -2147024713
        }) as Handler,
      },
    })
    expect(existing.api.appContainer('com.cairn.sandbox.test').sid).toBe(0x700n)
  })

  it('reports AppContainer creation failures', () => {
    const missingSid = fakeKoffi({
      handlers: {
        CreateAppContainerProfile: (() => 0) as Handler,
      },
    })
    expect(() => missingSid.api.appContainer('x')).toThrow(/CreateAppContainerProfile failed/)

    const hresult = fakeKoffi({
      handlers: {
        CreateAppContainerProfile: (() => -2147024891) as Handler,
      },
    })
    expect(() => hresult.api.appContainer('x')).toThrow(/HRESULT 0x80070005/)

    const deriveFailed = fakeKoffi({
      handlers: {
        CreateAppContainerProfile: (() => -2147024713) as Handler,
        DeriveAppContainerSidFromAppContainerName: ((_name: unknown, out: unknown[]) => {
          out[0] = null
          return -2147024891
        }) as Handler,
      },
    })
    expect(() => deriveFailed.api.appContainer('x')).toThrow(/HRESULT 0x80070005/)
  })

  it('derives AppContainer SIDs without creating profiles', () => {
    const { api, called } = fakeKoffi()
    expect(api.deriveAppContainer('x')).toBe(0x700n)
    expect(called('CreateAppContainerProfile')).toHaveLength(0)
    const failing = fakeKoffi({
      handlers: { DeriveAppContainerSidFromAppContainerName: (() => 1) as Handler },
    })
    expect(() => failing.api.deriveAppContainer('x')).toThrow(/HRESULT 0x1/)
  })

  it('converts SIDs both ways and reports failures', () => {
    const { api } = fakeKoffi()
    expect(api.sidFromString('S-1-5-21-1')).toBe(0x400n)
    expect(api.sidToString(0x400n)).toBe('S-1-5-21-1')
    const failing = fakeKoffi({
      handlers: {
        ConvertStringSidToSidW: (() => 0) as Handler,
        ConvertSidToStringSidW: (() => 0) as Handler,
      },
    })
    expect(() => failing.api.sidFromString('x')).toThrow(/ConvertStringSidToSidW\(x\) failed/)
    expect(() => failing.api.sidToString(1n)).toThrow(/ConvertSidToStringSidW failed/)
  })

  it('waits for process exit, reads the exit code and terminates', () => {
    const { api, called } = fakeKoffi()
    expect(api.hasExited(1n)).toBe(true)
    expect(api.exitCode(1n)).toBe(7)
    api.terminate(1n)
    expect(called('TerminateProcess')[0]!.args).toEqual([1n, 1])

    const waiting = fakeKoffi({ handlers: { WaitForSingleObject: (() => 258) as Handler } })
    expect(waiting.api.hasExited(1n)).toBe(false)
  })

  it('reports a failed exit-code lookup', () => {
    const { api } = fakeKoffi({
      handlers: { GetExitCodeProcess: (() => 0) as Handler, GetLastError: (() => 6) as Handler },
    })
    expect(() => api.exitCode(1n)).toThrow(/GetExitCodeProcess failed \(Win32 6\)/)
  })

  it('deletes AppContainer profiles', () => {
    const { api, called } = fakeKoffi()
    api.deleteAppContainer('com.cairn.sandbox.test')
    expect(called('DeleteAppContainerProfile')[0]!.args).toEqual(['com.cairn.sandbox.test'])
  })

  it('closes handles and resumes threads', () => {
    const { api, called } = fakeKoffi()
    api.closeHandle(9n)
    api.resumeThread(8n)
    expect(called('CloseHandle')[0]!.args).toEqual([9n])
    expect(called('ResumeThread')[0]!.args).toEqual([8n])
  })
})
