/**
 * 发布验收（M5-10）：在已打包程序上走通“首次运行 → 配置模型 → 创建项目 → 沙箱命令 →
 * 检查点/撤销 → 更新检查 → 许可证 → 诊断包”。
 *
 * 环境尽量接近干净安装的普通用户机器：
 * - 数据目录与项目路径含中文、空格与较长层级，覆盖非 ASCII 与长路径；
 * - 启动进程的 `PATH` 只保留系统目录，`where git` 必须失败，检查点只能走随包 MinGit；
 * - 更新使用本地自签名静态源（只在本机回环地址），断言 unsigned beta 的
 *   `signatureVerified: false`，不执行真实安装重启。
 *
 * 真实干净 VM、Windows 10、标准用户账户与 Defender/SmartScreen 仍属于人工验收矩阵，
 * 见 `docs/plan/m5-report.md`；本用例只覆盖可以在任何 Windows 机器上自动复现的接线与数据路径。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { UpdateStatus } from '@cairn/protocol'
import { startMockModel } from '../scripts/mock-model.js'
import { startUpdateSource } from './update-source.js'
import { startPackagedApp } from './packaged-app.js'
import { chatRequests, createSession, sendPrompt } from './session.js'

const REPLY = '发布验收完成'
const API_KEY = 'acceptance-key-value'
const WORKSPACE_SEGMENTS = [
  '项目 目录',
  '跨境 冷链 订单 管理 系统',
  '一个用于验收长路径的项目文件夹',
] as const

interface Reply<T> {
  readonly ok: boolean
  readonly result?: T
  readonly error?: unknown
}

async function request<T>(page: Page, method: string, params: object): Promise<T> {
  const reply = (await page.evaluate(
    async ([name, payload]) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { request(method: string, params: object): Promise<unknown> }
        }
      ).cairn
      return cairn.request(name as string, payload as object)
    },
    [method, params] as const,
  )) as Reply<T>
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

/** 只用系统目录的 PATH：没有 Git、没有 Node，也没有开发机上的其他工具。 */
function systemOnlyPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return [
    path.join(root, 'System32'),
    root,
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

test('已打包应用完成首次运行到诊断包的全流程验收', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform !== 'win32', '发布验收矩阵只针对 Windows 首发平台')

  const root = mkdtempSync(path.join(tmpdir(), 'cairn-acceptance-'))
  const userData = path.join(root, '用户 数据 目录', '一个用于验收的中文数据目录名称')
  const workspace = path.join(userData, ...WORKSPACE_SEGMENTS)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(path.join(userData, 'diagnostics'), { recursive: true })
  writeFileSync(
    path.join(userData, 'settings.json'),
    `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: false })}\n`,
  )

  const minimalPath = systemOnlyPath()
  const gitProbe = spawnSync('where.exe', ['git'], {
    env: { ...process.env, PATH: minimalPath },
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(gitProbe.status, '验收环境必须在 PATH 中找不到 Git').not.toBe(0)

  const mock = await startMockModel({
    reply: REPLY,
    toolCallsByPrompt: {
      运行验收命令: [
        {
          name: 'run_command',
          arguments: {
            command:
              "Set-Content -LiteralPath '验收.txt' -Value 'ok' -Encoding utf8 -ErrorAction Stop\nGet-Content -LiteralPath '验收.txt' -Encoding utf8",
          },
        },
      ],
    },
  })
  const source = await startUpdateSource()
  const exportDir = path.join(userData, 'diagnostics')
  let running: Awaited<ReturnType<typeof startPackagedApp>> | undefined
  try {
    running = await startPackagedApp({
      userData,
      args: ['--ignore-certificate-errors'],
      env: {
        PATH: minimalPath,
        CAIRN_UPDATE_URL: source.url,
        CAIRN_DIAGNOSTICS_DIR: exportDir,
      },
    })
    const { page } = running

    // 1. 干净安装的首次运行：没有供应商时引导到模型设置，关闭后写入已读标记。
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
    await expect(dialog.getByText(/还没有配置模型供应商/)).toBeVisible()
    await dialog.getByRole('button', { name: '稍后' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(userData, 'settings.json'), 'utf8'),
        ) as Record<string, unknown>
        return saved['onboardingSeen']
      })
      .toBe(true)

    // 2. 身份与版本来自打包产物，而不是开发仓库。
    const info = await request<{
      version: string
      appId: string
      packaged: boolean
      channel: string
      commit: string
    }>(page, 'app.info', {})
    expect(info).toMatchObject({
      version: '0.1.0',
      appId: 'com.cairn.desktop',
      packaged: true,
      channel: 'beta',
    })
    expect(info.commit).toMatch(/^[0-9a-f]{7,40}$/)

    // 3. 配置模型与凭据后重新加载界面（设置由主进程持久化）。
    await page.evaluate(
      async ({ url, key }) => {
        const cairn = (
          globalThis as unknown as {
            cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
          }
        ).cairn
        await cairn.ready()
        const stored = await cairn.request('credentials.set', {
          ref: 'acceptance-key',
          secret: key,
        })
        if (!(stored as { ok: boolean }).ok) throw new Error('credentials.set failed')
        const updated = await cairn.request('settings.update', {
          providers: [
            {
              id: 'acceptance',
              kind: 'openai',
              displayName: 'Acceptance',
              baseUrl: url,
              credentialRef: 'acceptance-key',
              models: [
                {
                  id: 'acceptance-model',
                  contextWindow: 32_000,
                  maxOutputTokens: 1_000,
                  supportsTools: true,
                  supportsParallelToolCalls: false,
                  supportsReasoning: false,
                },
              ],
            },
          ],
          defaultModel: { providerId: 'acceptance', modelId: 'acceptance-model' },
        })
        if (!(updated as { ok: boolean }).ok) throw new Error('settings.update failed')
      },
      { url: mock.baseUrl, key: API_KEY },
    )
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('heading', { name: '欢迎使用 Cairn' })).toHaveCount(0)

    // 4. 中文长路径项目：创建会话并让模型调用沙箱命令。
    await createSession(page, workspace, '发布验收')
    await sendPrompt(page, '运行验收命令')
    const card = page.getByRole('article', { name: '需要审批：run_command' })
    await expect(card).toBeVisible()
    const sandbox = await request<{ capability: { available: boolean } }>(
      page,
      'sandbox.status',
      {},
    )
    await expect(card.getByTestId('sandbox-badge')).toHaveAttribute(
      'data-sandbox-enforced',
      String(sandbox.capability.available),
    )
    await card.getByRole('button', { name: '运行一次' }).click()
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('空闲')

    // 工具必须真的执行成功：退出码为 0，且 `Get-Content` 回显了写入的内容。
    // 失败时把工具结果与沙箱状态一并放进断言消息，便于在 CI 日志里直接定位。
    const latest = chatRequests(mock.requests).at(-1)
    const toolResult = JSON.stringify(
      ((latest?.messages ?? []) as { role: string }[]).filter((message) => message.role === 'tool'),
    )
    expect(toolResult, `sandbox.status: ${JSON.stringify(sandbox)}`).toContain('Exit code: 0')
    expect(toolResult).toContain('ok')
    expect(readFileSync(path.join(workspace, '验收.txt'), 'utf8').trim()).toBe('ok')

    // 5. PATH 中没有 Git，检查点仍由随包 MinGit 建立；撤销本轮恢复工作区。
    const sessionId = await page.evaluate(async () => {
      const cairn = (
        globalThis as unknown as {
          cairn: { request(m: string, p: object): Promise<{ ok: boolean; result?: unknown }> }
        }
      ).cairn
      const listed = await cairn.request('session.list', {})
      const sessions = (listed.result as { sessions: { sessionId: string; title: string }[] })
        .sessions
      return sessions.find((session) => session.title === '发布验收')?.sessionId ?? ''
    })
    expect(sessionId).not.toBe('')
    const checkpoints = await request<{ checkpoints: unknown[] }>(page, 'checkpoint.list', {
      sessionId,
    })
    expect(checkpoints.checkpoints.length).toBeGreaterThan(0)
    expect(
      readdirSync(path.join(userData, 'checkpoints')).some((name) => name.endsWith('.git')),
    ).toBe(true)

    await page.getByRole('button', { name: '撤销本轮' }).click()
    const undo = page.getByRole('dialog', { name: '撤销第 1 轮的改动？' })
    await expect(undo.getByRole('list', { name: '受影响的文件' })).toContainText('验收.txt')
    await undo.getByRole('button', { name: '撤销 1 个文件' }).click()
    await expect(page.getByText(/^已撤销到第 1 轮开始之前 · /)).toBeVisible()
    expect(() => readFileSync(path.join(workspace, '验收.txt'))).toThrow()

    // 6. 更新检查走公开只读静态源；unsigned beta 明确标记签名未验证。
    await expect(request<UpdateStatus>(page, 'update.status', {})).resolves.toMatchObject({
      phase: 'idle',
      enabled: true,
      currentVersion: '0.1.0',
      channel: 'beta',
    })
    const checked = await request<UpdateStatus>(page, 'update.check', {})
    expect(checked.phase, JSON.stringify(checked)).toBe('available')
    expect(checked.availableVersion).toBe('0.1.1')
    const downloaded = await request<UpdateStatus>(page, 'update.download', {})
    expect(downloaded.phase, JSON.stringify(downloaded)).toBe('downloaded')
    expect(downloaded).toMatchObject({ requiresRestart: true, signatureVerified: false })

    // 7. 关于页的第三方许可与诊断包都能在安装形态下读取。
    const licenses = await request<{ available: boolean; text: string; truncated: boolean }>(
      page,
      'app.licenses',
      {},
    )
    expect(licenses).toMatchObject({ available: true, truncated: false })
    expect(licenses.text).toContain('Cairn includes the following third-party software.')

    const exported = await request<{ path?: string; cancelled: boolean }>(
      page,
      'diagnostics.export',
      {},
    )
    expect(exported.cancelled).toBe(false)
    expect(exported.path).toBeDefined()
    const archive = unzipSync(readFileSync(exported.path!))
    const names = Object.keys(archive)
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'app-version.json']))
    const text = names.map((name) => new TextDecoder().decode(archive[name]!)).join('\n')
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(userData)

    // 8. 关闭后重启：设置、凭据、会话与检查点都留在数据目录，欢迎页不再出现。
    //    升级与重装依赖同一批文件，这里先验证“换一个进程仍能恢复”的最小闭环。
    await running.stop()
    running = undefined
    running = await startPackagedApp({ userData, env: { PATH: minimalPath } })
    const restarted = running.page
    await expect(restarted.getByRole('heading', { name: '欢迎使用 Cairn' })).toHaveCount(0)
    await expect(restarted.getByRole('button', { name: /^设置/ })).toBeVisible()
    await restarted
      .getByRole('navigation', { name: '会话' })
      .getByRole('button', { name: '发布验收' })
      .click()
    await expect(restarted.getByRole('heading', { level: 2, name: '发布验收' })).toBeVisible()
    await expect(restarted.getByText(REPLY)).toBeVisible()
    await expect(restarted.getByText('运行验收命令')).toBeVisible()
  } finally {
    await running?.stop()
    await mock.close()
    await source.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
