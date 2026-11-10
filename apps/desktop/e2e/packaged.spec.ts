/**
 * 已打包应用（M5-02）：通过 Chromium CDP 启动 `dist/<platform>-unpacked` 中的真实程序，
 * 验证安装包布局、preload/IPC、SQLite 与项目/会话创建。数据目录始终是临时目录。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startPackagedApp } from './packaged-app.js'

test('已打包应用启动、读取构建信息并创建项目会话', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'cairn-packaged-e2e-'))
  const workspace = path.join(userData, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    path.join(userData, 'settings.json'),
    `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: false })}\n`,
  )
  let running: Awaited<ReturnType<typeof startPackagedApp>> | undefined
  try {
    running = await startPackagedApp({ userData })
    const { page } = running
    // 干净安装先显示欢迎说明；模态打开时主界面在 aria-hidden 之内，先关闭再断言主界面。
    await expect(page.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
    await page.getByRole('button', { name: '稍后' }).click()
    await expect(page.getByRole('heading', { name: '欢迎使用 Cairn' })).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: 'Cairn' })).toBeVisible()
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(userData, 'settings.json'), 'utf8'),
        ) as Record<string, unknown>
        return saved['onboardingSeen']
      })
      .toBe(true)

    const info = (await page.evaluate(async () => {
      const cairn = (
        globalThis as unknown as {
          cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      await cairn.ready()
      return cairn.request('app.info', {})
    })) as {
      ok: boolean
      result: { version: string; appId: string; packaged: boolean; channel: string }
    }
    expect(info).toMatchObject({
      ok: true,
      result: {
        version: '0.1.0',
        appId: 'com.cairn.desktop',
        packaged: true,
        channel: 'beta',
      },
    })

    const licenses = (await page.evaluate(async () => {
      const cairn = (
        globalThis as unknown as {
          cairn: { request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      return cairn.request('app.licenses', {})
    })) as {
      ok: boolean
      result: { available: boolean; text: string; truncated: boolean }
    }
    expect(licenses).toMatchObject({ ok: true, result: { available: true, truncated: false } })
    expect(licenses.result.text).toContain('Cairn includes the following third-party software.')

    const created = (await page.evaluate(
      async ({ workspace: directory }) => {
        const cairn = (
          globalThis as unknown as {
            cairn: { request(m: string, p: object): Promise<unknown> }
          }
        ).cairn
        return cairn.request('session.create', {
          projectPath: directory,
          title: 'Packaged project',
        })
      },
      { workspace },
    )) as { ok: boolean; result: { sessionId: string } }
    expect(created).toMatchObject({ ok: true, result: { sessionId: expect.any(String) } })

    const sessions = (await page.evaluate(async () => {
      const cairn = (
        globalThis as unknown as {
          cairn: { request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      return cairn.request('session.list', {})
    })) as { ok: boolean; result: { sessions: { sessionId: string; projectPath: string }[] } }
    expect(sessions.ok).toBe(true)
    expect(sessions.result.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: created.result.sessionId,
        projectPath: workspace,
      }),
    )
  } finally {
    await running?.stop()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
