/**
 * 临时诊断（验证完即删）：在已打包应用的沙箱里分别用 PowerShell 7、Windows PowerShell 5.1 与
 * cmd 执行同一条写文件命令，判断 0xC0000142 是“某个 shell 起不来”还是“沙箱里任何子进程都起不来”。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { startPackagedApp } from './packaged-app.js'
import { chatRequests, configureProvider, createSession, rpc, sendPrompt } from './session.js'

const API_KEY = 'acceptance-key-value'

function systemOnlyPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return [
    path.win32.join(root, 'System32'),
    root,
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';')
}

interface Variant {
  readonly name: string
  readonly shell: 'auto' | 'cmd'
  readonly command: string
  readonly env: Readonly<Record<string, string>>
}

const POWERSHELL_COMMAND = [
  "Set-Content -LiteralPath 'probe.txt' -Value 'ok' -Encoding utf8 -ErrorAction Stop",
  "Get-Content -LiteralPath 'probe.txt' -Encoding utf8",
].join('\n')

function variants(): readonly Variant[] {
  const minimal = { PATH: systemOnlyPath() }
  const noProgramFiles = {
    ...minimal,
    ProgramFiles: path.join(tmpdir(), 'cairn-no-program-files'),
    ProgramW6432: path.join(tmpdir(), 'cairn-no-program-files'),
  }
  return [
    { name: 'pwsh', shell: 'auto', command: POWERSHELL_COMMAND, env: minimal },
    { name: 'ps51', shell: 'auto', command: POWERSHELL_COMMAND, env: noProgramFiles },
    { name: 'cmd', shell: 'cmd', command: 'echo ok>probe.txt & type probe.txt', env: minimal },
  ]
}

test('诊断：已打包应用沙箱内的不同 shell', async () => {
  test.setTimeout(300_000)
  test.skip(process.platform !== 'win32', '命令沙箱目前只在 Windows 上生效')

  const results: string[] = []
  for (const variant of variants()) {
    const root = mkdtempSync(path.join(tmpdir(), 'cairn-shell-probe-'))
    const userData = path.join(root, '用户 数据 目录')
    const workspace = path.join(userData, 'ascii', 'probe')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      path.join(userData, 'settings.json'),
      `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: true, shell: variant.shell })}\n`,
    )
    const reply = `完成 ${variant.name}`
    const mock = await startMockModel({
      reply,
      toolCall: { name: 'run_command', arguments: { command: variant.command } },
    })
    let running: Awaited<ReturnType<typeof startPackagedApp>> | undefined
    try {
      running = await startPackagedApp({ userData, env: variant.env })
      const { page } = running
      const status = await rpc<{ capability: { available: boolean } }>(page, 'sandbox.status', {})
      await configureProvider(page, mock.baseUrl, API_KEY)
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await createSession(page, workspace, variant.name)
      await sendPrompt(page, '写入探针文件')
      await page
        .getByRole('article', { name: '需要审批：run_command' })
        .getByRole('button', { name: '运行一次' })
        .click()
      await expect(page.getByText(reply)).toBeVisible()
      const latest = chatRequests(mock.requests).at(-1)
      const tool = JSON.stringify(
        ((latest?.messages ?? []) as { role: string }[]).filter(
          (message) => message.role === 'tool',
        ),
      )
      results.push(
        JSON.stringify({
          name: variant.name,
          available: status.capability.available,
          file: existsSync(path.join(workspace, 'probe.txt')),
          tool,
        }),
      )
    } catch (error) {
      results.push(JSON.stringify({ name: variant.name, error: (error as Error).message }))
    } finally {
      await running?.stop()
      await mock.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
  throw new Error(`shell 诊断:\n${results.join('\n')}`)
})
