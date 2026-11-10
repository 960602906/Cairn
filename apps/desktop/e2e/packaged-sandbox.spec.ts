/**
 * 已打包应用中的命令沙箱（M5-10 补充）：在“没有 Git / Node 的最简 PATH”下，ASCII 工作区与
 * 中文+空格+长路径工作区都要能把文件真正写进工作区，并显示真实的终端卡片。
 *
 * 这两个用例是发布验收的基线：只有它们通过，`acceptance.spec.ts` 中“中文长路径项目里执行命令”
 * 的失败才能归因到产品行为而不是测试环境。失败时把终端卡片与工具结果写进断言消息，便于在 CI
 * 日志里直接看到 shell、工作目录与退出码。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { SandboxStatus } from '@cairn/protocol'
import { startMockModel } from '../scripts/mock-model.js'
import { startPackagedApp } from './packaged-app.js'
import {
  chatRequests,
  configureProvider,
  createSession,
  expandToolStep,
  rpc,
  sendPrompt,
} from './session.js'

const API_KEY = 'acceptance-key-value'

interface Case {
  readonly title: string
  readonly segments: readonly string[]
  readonly file: string
}

const CASES: readonly Case[] = [
  { title: 'ASCII 工作区', segments: ['ascii', 'probe'], file: 'probe.txt' },
  {
    title: '中文工作区',
    segments: ['项目 目录', '跨境 冷链 订单 管理 系统', '一个用于验收长路径的项目文件夹'],
    file: '验收.txt',
  },
]

/** 只用系统目录的 PATH：没有 Git、没有 Node，也没有开发机上的其他工具。 */
function systemOnlyPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return [
    path.win32.join(root, 'System32'),
    root,
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';')
}

for (const item of CASES) {
  test(`已打包应用的沙箱能在${item.title}写入文件`, async () => {
    test.setTimeout(180_000)
    test.skip(process.platform !== 'win32', '命令沙箱目前只在 Windows 上生效')

    const root = mkdtempSync(path.join(tmpdir(), 'cairn-sandbox-packaged-'))
    const userData = path.join(root, '用户 数据 目录')
    const workspace = path.join(userData, ...item.segments)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      path.join(userData, 'settings.json'),
      `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: true })}\n`,
    )

    const reply = '沙箱写入完成'
    const mock = await startMockModel({
      reply,
      toolCall: {
        name: 'run_command',
        arguments: {
          command: [
            `Set-Content -LiteralPath '${item.file}' -Value 'ok' -Encoding utf8 -ErrorAction Stop`,
            `Get-Content -LiteralPath '${item.file}' -Encoding utf8`,
            'Get-Location',
          ].join('\n'),
        },
      },
    })
    let running: Awaited<ReturnType<typeof startPackagedApp>> | undefined
    try {
      running = await startPackagedApp({
        userData,
        env: { PATH: systemOnlyPath() },
      })
      const { page } = running
      const status = await rpc<SandboxStatus>(page, 'sandbox.status', {})
      test.skip(!status.capability.available, '当前机器的沙箱能力不可用')
      await configureProvider(page, mock.baseUrl, API_KEY)
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      await createSession(page, workspace, item.title)
      await sendPrompt(page, '写入沙箱文件')
      const card = page.getByRole('article', { name: '需要审批：run_command' })
      await expect(card).toBeVisible()
      await expect(card.getByTestId('sandbox-badge')).toHaveAttribute(
        'data-sandbox-enforced',
        'true',
      )
      await card.getByRole('button', { name: '运行一次' }).click()
      await expect(page.getByText(reply)).toBeVisible()
      await expect(page.getByRole('status')).toHaveText('空闲')

      const step = await expandToolStep(page, 'run_command')
      const terminal = step.getByRole('figure', { name: /^终端：/ })
      await expect(terminal).toBeVisible()
      const terminalText = await terminal.innerText()
      const latest = chatRequests(mock.requests).at(-1)
      const toolResult = JSON.stringify(
        ((latest?.messages ?? []) as { role: string }[]).filter(
          (message) => message.role === 'tool',
        ),
      )
      const report = `${item.title}\n终端卡片:\n${terminalText}\n工具结果: ${toolResult}`

      expect(terminalText, report).toContain(item.file)
      expect(terminalText, report).toContain('工作目录')
      expect(toolResult, report).toContain('Exit code: 0')
      expect(toolResult, report).toContain('ok')
      expect(existsSync(path.join(workspace, item.file)), report).toBe(true)
      expect(readFileSync(path.join(workspace, item.file), 'utf8').trim(), report).toBe('ok')
    } finally {
      await running?.stop()
      await mock.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
