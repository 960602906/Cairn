/**
 * 临时诊断（验证完即删）：在最简 PATH 上逐项加回候选目录，定位 PowerShell 7 在低完整性沙箱里
 * 初始化失败（0xC0000142）缺的是哪一段环境。
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
  readonly path: string
}

function variants(): readonly Variant[] {
  const minimal = systemOnlyPath()
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const additions: readonly (readonly [string, string])[] = [
    ['+shell', path.win32.join(programFiles, 'PowerShell', '7')],
    ['+dotnet', path.win32.join(programFiles, 'dotnet')],
    ['+wbem', path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'Wbem')],
    ['+git', path.win32.join(programFiles, 'Git', 'cmd')],
  ]
  return [
    { name: 'minimal', path: minimal },
    ...additions.map(([name, dir]) => ({ name, path: `${minimal};${dir}` })),
    ...(process.env['PATH'] ? [{ name: 'full', path: process.env['PATH'] }] : []),
  ]
}

test('诊断：沙箱内的 PowerShell 7 在各种 PATH 下的启动情况', async () => {
  test.setTimeout(300_000)
  test.skip(process.platform !== 'win32', '命令沙箱目前只在 Windows 上生效')

  const results: string[] = []
  for (const variant of variants()) {
    const root = mkdtempSync(path.join(tmpdir(), 'cairn-path-probe-'))
    const userData = path.join(root, '用户 数据 目录')
    const workspace = path.join(userData, 'ascii', 'probe')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      path.join(userData, 'settings.json'),
      `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: true })}\n`,
    )
    const reply = `完成 ${variant.name}`
    const mock = await startMockModel({
      reply,
      toolCall: {
        name: 'run_command',
        arguments: {
          command: [
            "Set-Content -LiteralPath 'probe.txt' -Value 'ok' -Encoding utf8 -ErrorAction Stop",
            "Get-Content -LiteralPath 'probe.txt' -Encoding utf8",
          ].join('\n'),
        },
      },
    })
    let running: Awaited<ReturnType<typeof startPackagedApp>> | undefined
    try {
      running = await startPackagedApp({ userData, env: { PATH: variant.path } })
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
  throw new Error(`PATH 诊断:\n${results.join('\n')}`)
})
