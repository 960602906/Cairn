/**
 * 临时诊断（验证完即删）：在 CI 上比较沙箱进程启动方式的各种变体，定位 0xC0000142。
 * 只在设置 `CAIRN_SANDBOX_DIAG=1` 的 Windows 上运行。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { runCommand } from '../run.js'
import { createSandboxRunner } from './restricted.js'
import { buildEnvironmentBlock } from './command-line.js'
import { createNativeApi, type NativeSpawnOptions } from './windows-api.js'

const MINIMAL = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'ComSpec',
  'USERPROFILE',
  'USERNAME',
]
const pick = (names: string[]) =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined && names.some((n) => n.toLowerCase() === name.toLowerCase()),
    ),
  )
const nobig = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value.length < 2000),
  )

type EnvMode = 'normal' | 'null' | 'minimal' | 'nobig'
const variants: Array<{
  name: string
  desktop: string
  spawn: string
  il: 'low' | 'medium'
  env?: EnvMode
}> = [
  { name: 'env-null', desktop: 'inherit', spawn: '', il: 'low', env: 'null' },
  { name: 'env-minimal', desktop: 'inherit', spawn: '', il: 'low', env: 'minimal' },
  { name: 'env-nobig', desktop: 'inherit', spawn: '', il: 'low', env: 'nobig' },
  { name: 'base', desktop: 'inherit', spawn: '', il: 'low' },
  { name: 'medium', desktop: 'inherit', spawn: '', il: 'medium' },
  { name: 'detached', desktop: 'inherit', spawn: 'detached', il: 'low' },
  { name: 'newconsole-hide', desktop: 'inherit', spawn: 'newconsole,hide', il: 'low' },
  { name: 'explicit', desktop: 'explicit', spawn: '', il: 'low' },
  { name: 'desktop', desktop: 'desktop', spawn: '', il: 'low' },
  { name: 'desktop-nolabel', desktop: 'desktop-nolabel', spawn: '', il: 'low' },
  { name: 'station', desktop: 'station', spawn: '', il: 'low' },
  { name: 'medium-detached', desktop: 'inherit', spawn: 'detached', il: 'medium' },
  { name: 'station-detached', desktop: 'station', spawn: 'detached', il: 'low' },
]

describe.skipIf(process.platform !== 'win32' || !process.env['CAIRN_SANDBOX_DIAG'])(
  '沙箱启动诊断',
  () => {
    it('各种变体', { timeout: 600_000 }, async () => {
      const { default: koffi } = await import('koffi')
      const lines: string[] = []
      const entries = Object.entries(process.env).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][]
      lines.push(
        `env count=${entries.length} total=${entries.reduce((n, [k, v]) => n + k.length + v.length + 2, 0)}`,
      )
      for (const [k, v] of entries.sort((a, b) => a[0].localeCompare(b[0])))
        lines.push(`  ${k} len=${v.length}${/[^\x20-\x7e]/.test(k + v) ? ' nonascii' : ''}`)
      const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
      for (const variant of variants) {
        process.env['CAIRN_SANDBOX_DIAG_SPAWN'] = variant.spawn
        const native = createNativeApi(koffi as never, {
          env: { ...process.env, CAIRN_SANDBOX_DESKTOP: variant.desktop },
        })
        const envMode = variant.env ?? 'normal'
        const api = {
          ...native,
          createRestrictedToken: () => native.createRestrictedToken(variant.il),
          spawn: (o: NativeSpawnOptions) =>
            native.spawn(
              envMode === 'normal'
                ? o
                : {
                    ...o,
                    env:
                      envMode === 'null'
                        ? (null as never)
                        : buildEnvironmentBlock(envMode === 'minimal' ? pick(MINIMAL) : nobig()),
                  },
            ),
        }
        const cwd = mkdtempSync(path.join(tmpdir(), `cairn-diag-${variant.name}-`))
        try {
          const runner = await createSandboxRunner({ api })
          const result = await runCommand(
            { kind: 'cmd', exe: cmd },
            'echo ok>probe.txt & type probe.txt',
            {
              cwd,
              timeoutMs: 30_000,
              sandbox: { runner, policy: { profile: 'workspace-write', network: 'none' } },
            },
          )
          lines.push(
            `${variant.name}: exit=${result.exitCode} out=${JSON.stringify(result.stdout.trim())} err=${JSON.stringify(result.stderr.trim().slice(0, 200))} desktop=${native.describeDesktop?.()}`,
          )
        } catch (error) {
          lines.push(
            `${variant.name}: threw ${error instanceof Error ? error.message : String(error)} desktop=${native.describeDesktop?.()}`,
          )
        }
      }
      delete process.env['CAIRN_SANDBOX_DIAG_SPAWN']
      console.log(`SANDBOX-DIAG\n${lines.join('\n')}`)
    })
  },
)
