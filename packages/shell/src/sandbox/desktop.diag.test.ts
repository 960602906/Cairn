/* eslint-disable */
/**
 * 临时诊断（验证完即删）：直接调用 Win32，比较沙箱进程启动方式的各种变体，定位 0xC0000142。
 * 只在设置 `CAIRN_SANDBOX_DIAG=1` 的 Windows 上运行。
 */
import { mkdtempSync, readFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'

describe.skipIf(process.platform !== 'win32' || !process.env['CAIRN_SANDBOX_DIAG'])(
  '沙箱启动诊断',
  () => {
    it('各种变体', { timeout: 600_000 }, async () => {
      const { default: koffi } = (await import('koffi')) as never as { default: any }
      const k32 = koffi.load('kernel32.dll')
      const adv = koffi.load('advapi32.dll')
      const H = 'void *'
      const OUT = koffi.out(koffi.pointer('void *'))
      const f = (lib: any, name: string, r: string, a: unknown[]) =>
        lib.func('__stdcall', name, r, a)
      const W = {
        GetCurrentProcess: f(k32, 'GetCurrentProcess', H, []),
        GetLastError: f(k32, 'GetLastError', 'uint32_t', []),
        CloseHandle: f(k32, 'CloseHandle', 'int', [H]),
        IsProcessInJob: f(k32, 'IsProcessInJob', 'int', [H, H, 'void *']),
        QueryInformationJobObject: f(k32, 'QueryInformationJobObject', 'int', [
          H,
          'int',
          'void *',
          'uint32_t',
          'void *',
        ]),
        GetConsoleWindow: f(k32, 'GetConsoleWindow', H, []),
        GetFileType: f(k32, 'GetFileType', 'uint32_t', [H]),
        GetStdHandle: f(k32, 'GetStdHandle', H, ['int32_t']),
        CreateFileW: f(k32, 'CreateFileW', H, [
          'str16',
          'uint32_t',
          'uint32_t',
          'void *',
          'uint32_t',
          'uint32_t',
          H,
        ]),
        ResumeThread: f(k32, 'ResumeThread', 'uint32_t', [H]),
        WaitForSingleObject: f(k32, 'WaitForSingleObject', 'uint32_t', [H, 'uint32_t']),
        GetExitCodeProcess: f(k32, 'GetExitCodeProcess', 'int', [H, 'void *']),
        TerminateProcess: f(k32, 'TerminateProcess', 'int', [H, 'uint32_t']),
        CreateProcessW: f(k32, 'CreateProcessW', 'int', [
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
        InitializeProcThreadAttributeList: f(k32, 'InitializeProcThreadAttributeList', 'int', [
          'void *',
          'uint32_t',
          'uint32_t',
          'void *',
        ]),
        UpdateProcThreadAttribute: f(k32, 'UpdateProcThreadAttribute', 'int', [
          'void *',
          'uint32_t',
          'uintptr_t',
          'void *',
          'uintptr_t',
          'void *',
          'void *',
        ]),
        OpenProcessToken: f(adv, 'OpenProcessToken', 'int', [H, 'uint32_t', OUT]),
        DuplicateTokenEx: f(adv, 'DuplicateTokenEx', 'int', [
          H,
          'uint32_t',
          'void *',
          'int',
          'int',
          OUT,
        ]),
        CreateRestrictedToken: f(adv, 'CreateRestrictedToken', 'int', [
          H,
          'uint32_t',
          'uint32_t',
          'void *',
          'uint32_t',
          'void *',
          'uint32_t',
          'void *',
          OUT,
        ]),
        GetTokenInformation: f(adv, 'GetTokenInformation', 'int', [
          H,
          'int',
          'void *',
          'uint32_t',
          'void *',
        ]),
        SetTokenInformation: f(adv, 'SetTokenInformation', 'int', [H, 'int', 'void *', 'uint32_t']),
        ConvertStringSidToSidW: f(adv, 'ConvertStringSidToSidW', 'int', ['str16', OUT]),
        ConvertSidToStringSidW: f(adv, 'ConvertSidToStringSidW', 'int', ['void *', OUT]),
        CreateProcessAsUserW: f(adv, 'CreateProcessAsUserW', 'int', [
          H,
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
      }
      const lines = { push: (t: string) => writeSync(2, `DIAG ${t}\n`), join: () => '' }
      const step = (t: string) => writeSync(2, `STEP ${t}\n`)
      step('const self = W.GetCurrentProce')
      const self = W.GetCurrentProcess()
      const inJob = Buffer.alloc(4)
      W.IsProcessInJob(self, null, inJob)
      const ext = Buffer.alloc(144)
      const ui = Buffer.alloc(4)
      const q1 = W.QueryInformationJobObject(null, 9, ext, 144, null)
      const q2 = W.QueryInformationJobObject(null, 4, ui, 4, null)
      lines.push(
        `parent: inJob=${inJob.readUInt32LE(0)} limits=${q1 ? '0x' + ext.readUInt32LE(16).toString(16) : 'err' + W.GetLastError()} ui=${q2 ? '0x' + ui.readUInt32LE(0).toString(16) : 'err' + W.GetLastError()} console=${W.GetConsoleWindow() ? 'yes' : 'no'} stdin=${W.GetFileType(W.GetStdHandle(-10))} stdout=${W.GetFileType(W.GetStdHandle(-11))} stderr=${W.GetFileType(W.GetStdHandle(-12))}`,
      )
      const tok: unknown[] = [null]
      step('W.OpenProcessToken(self, 0xf01')
      W.OpenProcessToken(self, 0xf01ff, tok)
      const ilBuf = Buffer.alloc(64)
      const need = Buffer.alloc(4)
      step('if (W.GetTokenInformation(tok[')
      if (W.GetTokenInformation(tok[0], 25, ilBuf, 64, need)) {
        const s: unknown[] = [null]
        W.ConvertSidToStringSidW(koffi.decode(ilBuf, 'void *'), s)
        lines.push(`parent IL=${koffi.decode(s[0], 'str16')}`)
      }
      const et = Buffer.alloc(4)
      step('W.GetTokenInformation(tok[0], ')
      W.GetTokenInformation(tok[0], 18, et, 4, need)
      lines.push(`parent elevationType=${et.readUInt32LE(0)}`)

      const setIl = (t: unknown, sid: string) => {
        const p: unknown[] = [null]
        W.ConvertStringSidToSidW(sid, p)
        const label = Buffer.alloc(16)
        label.writeBigUInt64LE(BigInt(koffi.address(p[0])), 0)
        return W.SetTokenInformation(t, 25, label, 16) ? '' : ` setIL err ${W.GetLastError()}`
      }
      const restricted = (flags: number, il?: string) => {
        const out: unknown[] = [null]
        if (!W.CreateRestrictedToken(tok[0], flags, 0, null, 0, null, 0, null, out))
          return { err: `crt ${W.GetLastError()}` }
        return { t: out[0], note: il ? setIl(out[0], il) : '' }
      }
      const dup = (il?: string) => {
        const out: unknown[] = [null]
        if (!W.DuplicateTokenEx(tok[0], 0x02000000, null, 2, 1, out))
          return { err: `dup ${W.GetLastError()}` }
        return { t: out[0], note: il ? setIl(out[0], il) : '' }
      }
      const LOW = 'S-1-16-4096'
      const MED = 'S-1-16-8192'
      const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
      const cases: Array<{
        name: string
        token?: () => { t?: unknown; err?: string; note?: string }
        inherit: 'std' | 'none' | 'list'
        flags?: number
      }> = [
        { name: 'createprocess-plain', inherit: 'std' },
        { name: 'dup-same', token: () => dup(), inherit: 'std' },
        { name: 'dup-medium', token: () => dup(MED), inherit: 'std' },
        { name: 'dup-low', token: () => dup(LOW), inherit: 'std' },
        { name: 'restrict-0', token: () => restricted(0), inherit: 'std' },
        { name: 'restrict-lua', token: () => restricted(0x4), inherit: 'std' },
        { name: 'restrict-dmp', token: () => restricted(0x1), inherit: 'std' },
        { name: 'restrict-both-low (product)', token: () => restricted(0x5, LOW), inherit: 'std' },
        { name: 'restrict-both-low noinherit', token: () => restricted(0x5, LOW), inherit: 'none' },
        {
          name: 'restrict-both-low handlelist',
          token: () => restricted(0x5, LOW),
          inherit: 'list',
        },
        {
          name: 'restrict-both-low nobreakaway',
          token: () => restricted(0x5, LOW),
          inherit: 'std',
          flags: 0,
        },
      ]
      for (const c of cases) {
        step(c.name)
        const dir = mkdtempSync(path.join(tmpdir(), 'cairn-diag-'))
        const outFile = path.join(dir, 'out.txt')
        const sa = Buffer.alloc(24)
        sa.writeUInt32LE(24, 0)
        sa.writeUInt32LE(1, 16)
        step('const fh = W.CreateFileW(')
        const fh = W.CreateFileW(outFile, 0xc0000000, 3, sa, 2, 0x80, null)
        const extended = c.inherit === 'list'
        const si = Buffer.alloc(extended ? 112 : 104)
        si.writeUInt32LE(si.length, 0)
        let attrs: Buffer | undefined
        let handleArr: Buffer | undefined
        if (c.inherit !== 'none') {
          si.writeUInt32LE(0x100, 60)
          const addr = BigInt(koffi.address(fh))
          si.writeBigUInt64LE(addr, 80)
          si.writeBigUInt64LE(addr, 88)
          si.writeBigUInt64LE(addr, 96)
        }
        if (extended) {
          const size = Buffer.alloc(8)
          W.InitializeProcThreadAttributeList(null, 1, 0, size)
          attrs = Buffer.alloc(Number(size.readBigUInt64LE(0)))
          W.InitializeProcThreadAttributeList(attrs, 1, 0, size)
          handleArr = Buffer.alloc(8)
          handleArr.writeBigUInt64LE(BigInt(koffi.address(fh)), 0)
          W.UpdateProcThreadAttribute(attrs, 0, 0x20002, handleArr, 8, null, null)
          si.writeBigUInt64LE(BigInt(koffi.address(attrs)), 104)
        }
        const pi = Buffer.alloc(24)
        const flags =
          0x4 | 0x08000000 | 0x400 | (c.flags ?? 0x01000000) | (extended ? 0x00080000 : 0)
        const line = Buffer.from(`"${cmd}" /d /c echo ok\0`, 'utf16le')
        let tokenNote = ''
        let ok = 0
        let err = 0
        if (c.token) {
          const t = c.token()
          if (!t.t) {
            lines.push(`${c.name}: token ${t.err}`)
            continue
          }
          tokenNote = t.note ?? ''
          ok = W.CreateProcessAsUserW(
            t.t,
            null,
            line,
            null,
            null,
            c.inherit === 'none' ? 0 : 1,
            flags,
            null,
            dir,
            si,
            pi,
          )
          err = ok ? 0 : W.GetLastError()
          if (!ok && err === 5 && c.flags === undefined) {
            ok = W.CreateProcessAsUserW(
              t.t,
              null,
              line,
              null,
              null,
              c.inherit === 'none' ? 0 : 1,
              flags & ~0x01000000,
              null,
              dir,
              si,
              pi,
            )
            tokenNote += ok ? ' (no breakaway)' : ''
            err = ok ? 0 : W.GetLastError()
          }
        } else {
          ok = W.CreateProcessW(null, line, null, null, 1, flags & ~0x01000000, null, dir, si, pi)
          err = ok ? 0 : W.GetLastError()
        }
        if (!ok) {
          lines.push(`${c.name}: create failed ${err}${tokenNote}`)
          W.CloseHandle(fh)
          continue
        }
        const proc = koffi.decode(pi, 'void *')
        const thread = koffi.decode(pi, 8, 'void *')
        step('W.ResumeThread(thread)')
        W.ResumeThread(thread)
        const waited = W.WaitForSingleObject(proc, 20_000)
        if (waited !== 0) W.TerminateProcess(proc, 1)
        const code = Buffer.alloc(4)
        W.GetExitCodeProcess(proc, code)
        W.CloseHandle(fh)
        let text = ''
        try {
          text = readFileSync(outFile, 'utf8').trim()
        } catch {}
        lines.push(
          `${c.name}: exit=0x${code.readUInt32LE(0).toString(16)} out=${JSON.stringify(text)}${tokenNote}`,
        )
      }
      console.log(`SANDBOX-DIAG\n${lines.join('\n')}`)
    })
  },
)
