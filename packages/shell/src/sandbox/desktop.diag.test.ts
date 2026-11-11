/**
 * 临时诊断（验证完即删）：在 CI 的非交互窗口站上，比较沙箱进程沿用宿主桌面与使用专用桌面的结果。
 * 只在设置 `CAIRN_SANDBOX_DIAG=1` 的 Windows 上运行。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { runCommand } from '../run.js'
import { createSandboxRunner } from './restricted.js'
import { loadSandboxNativeApi } from './windows-api.js'

describe.skipIf(process.platform !== 'win32' || !process.env['CAIRN_SANDBOX_DIAG'])(
  '沙箱桌面诊断',
  () => {
    it('沿用宿主桌面与专用桌面', { timeout: 120_000 }, async () => {
      const lines: string[] = []
      for (const mode of ['inherit', 'private'] as const) {
        const api = await loadSandboxNativeApi('win32')
        const env = { ...process.env, CAIRN_SANDBOX_DESKTOP: mode === 'inherit' ? 'inherit' : '' }
        // 每种模式各自一份原生 API，桌面缓存互不影响
        const { createNativeApi } = await import('./windows-api.js')
        const { default: koffi } = await import('koffi')
        const native = createNativeApi(koffi as never, { env })
        const runner = await createSandboxRunner({ api: native })
        const cwd = mkdtempSync(path.join(tmpdir(), `cairn-diag-${mode}-`))
        for (const shell of [
          {
            kind: 'cmd' as const,
            exe: path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'),
          },
        ]) {
          try {
            const result = await runCommand(shell, 'echo ok>probe.txt & type probe.txt', {
              cwd,
              timeoutMs: 30_000,
              sandbox: { runner, policy: { profile: 'workspace-write', network: 'none' } },
            })
            lines.push(
              `${mode} ${shell.kind}: exit=${result.exitCode} out=${JSON.stringify(result.stdout)} err=${JSON.stringify(result.stderr)} desktop=${native.describeDesktop?.()} available=${runner.capability.available}`,
            )
          } catch (error) {
            lines.push(
              `${mode} ${shell.kind}: threw ${error instanceof Error ? error.message : String(error)} desktop=${native.describeDesktop?.()}`,
            )
          }
        }
        void api
      }
      console.log(`SANDBOX-DIAG\n${lines.join('\n')}`)
    })
  },
)
