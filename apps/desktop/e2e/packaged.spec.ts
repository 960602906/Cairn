/**
 * 已打包应用（M5-02）：通过 Chromium CDP 启动 `dist/<platform>-unpacked` 中的真实程序，
 * 验证安装包布局、preload/IPC、SQLite 与项目/会话创建。数据目录始终是临时目录。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, expect, test, type Browser } from '@playwright/test'
import { applicationEnvironment, packagedApp, packagedArguments } from '../scripts/packaged-app.mjs'

const APP = packagedApp()

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForDevTools(port: number): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/version`
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(endpoint)
      if (response.ok) return
    } catch {
      // 应用还在启动
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`packaged application did not expose CDP on port ${port}`)
}

async function stopApp(child: ChildProcess, browser: Browser | undefined): Promise<void> {
  await browser?.close().catch(() => {})
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

test('已打包应用启动、读取构建信息并创建项目会话', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'cairn-packaged-e2e-'))
  const workspace = path.join(userData, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path.join(userData, 'settings.json'), `${JSON.stringify({ locale: 'zh-CN' })}\n`)
  const port = await freePort()
  let browser: Browser | undefined
  const child = spawn(APP.executable, [`--remote-debugging-port=${port}`, ...packagedArguments()], {
    cwd: APP.directory,
    env: applicationEnvironment({ userData }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  try {
    await waitForDevTools(port)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    if (!context) throw new Error('packaged application exposed no browser context')
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('heading', { level: 1, name: 'Cairn' })).toBeVisible()

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
    await stopApp(child, browser)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
