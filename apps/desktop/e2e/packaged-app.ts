/**
 * 已打包应用的启动夹具（M5-02/M5-10）：生产 fuses 关闭了 `--inspect` 与
 * `ELECTRON_RUN_AS_NODE`，因此用 Chromium CDP 连接 `dist/<platform>-unpacked` 中的真实程序。
 *
 * 数据目录始终是临时目录；调用方负责在 `finally` 中 `stop()`。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Browser, Page } from '@playwright/test'
import { chromium } from '@playwright/test'
import { applicationEnvironment, packagedApp, packagedArguments } from '../scripts/packaged-app.mjs'

export const APP = packagedApp()

export interface PackagedApp {
  readonly child: ChildProcess
  readonly browser: Browser
  readonly page: Page
  stop(): Promise<void>
}

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

async function stopProcess(child: ChildProcess, browser: Browser | undefined): Promise<void> {
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

/**
 * 启动已打包程序并连接 CDP。
 *
 * `env` 会覆盖进程环境（例如去掉 Git/Node 的 `PATH`）；`args` 追加到启动参数后面（例如
 * `--ignore-certificate-errors` 用于本地自签名更新源）。
 */
export async function startPackagedApp({
  userData,
  env = {},
  args = [],
}: {
  readonly userData: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: readonly string[]
}): Promise<PackagedApp> {
  const port = await freePort()
  let browser: Browser | undefined
  const child = spawn(
    APP.executable,
    [`--remote-debugging-port=${port}`, ...packagedArguments(), ...args],
    {
      cwd: APP.directory,
      env: applicationEnvironment({ userData, extra: env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  try {
    await waitForDevTools(port)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    if (!context) throw new Error('packaged application exposed no browser context')
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    await page.waitForLoadState('domcontentloaded')
    return {
      child,
      browser,
      page,
      stop: () => stopProcess(child, browser),
    }
  } catch (error) {
    await stopProcess(child, browser)
    throw error
  }
}
