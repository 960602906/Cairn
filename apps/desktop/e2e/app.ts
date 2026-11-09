/**
 * 端到端测试的应用启动与夹具（M0-16a）。
 *
 * - 每个用例一个临时数据目录（`CAIRN_USER_DATA_DIR`），用例结束后关闭所有应用实例并删除，不污染开发
 *   与正式数据。同一用例中多次 `launch()` 共用这个目录，用于验证重启后恢复。
 * - 启动前写入 `settings.json` 固定界面语言（默认 `zh-CN`），断言的文案不受系统语言影响；已有设置文件
 *   （重启时）不覆盖。
 * - Linux 上需要显示器（CI 用 `xvfb-run`）：`--ozone-platform=headless` 下窗口只有 1×1，Playwright 判定
 *   元素不可见。另加 `--disable-gpu`、`--no-sandbox`（CI 的 Linux 环境不支持 Chromium 沙箱），只用于测试，
 *   应用本身的沙箱设置不受影响。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron, test as base, type ElectronApplication, type Page } from '@playwright/test'

export const APP_DIR = path.resolve(import.meta.dirname, '..')
export const MAIN_ENTRY = path.join(APP_DIR, 'out/main/index.js')

const electronPath = createRequire(import.meta.url)('electron') as unknown as string

const PLATFORM_ARGS = process.platform === 'linux' ? ['--disable-gpu', '--no-sandbox'] : []

export type TestLocale = 'zh-CN' | 'en-US'

export interface LaunchOptions {
  /** 首次启动时写入设置的界面语言，默认 `zh-CN`。 */
  readonly locale?: TestLocale
  readonly env?: Readonly<Record<string, string>>
  /** 追加的 Electron/Chromium 启动参数（例如本地自签名更新源）。 */
  readonly args?: readonly string[]
}

export interface RunningApp {
  readonly app: ElectronApplication
  /** 主窗口。 */
  readonly window: Page
  /** 正常退出应用（触发 `before-quit`：停止宿主、关闭数据库）并等待进程结束。 */
  close(): Promise<void>
}

/** 用指定的数据目录启动构建产物，等待主窗口加载完成。 */
export async function launchApp(
  userData: string,
  options: LaunchOptions = {},
): Promise<RunningApp> {
  const settings = path.join(userData, 'settings.json')
  if (!existsSync(settings)) {
    writeFileSync(settings, `${JSON.stringify({ locale: options.locale ?? 'zh-CN' })}\n`)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CAIRN_SMOKE' && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value
    }
  }
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [APP_DIR, ...PLATFORM_ARGS, ...(options.args ?? [])],
    env: { ...env, ...options.env, CAIRN_USER_DATA_DIR: userData },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  let closed: Promise<void> | undefined
  return {
    app,
    window,
    close: () => (closed ??= app.close()),
  }
}

export interface AppFixtures {
  /** 本用例的数据目录。 */
  readonly userData: string
  /** 用本用例的数据目录启动应用；可多次调用（先 `close()` 再启动即为重启）。 */
  readonly launch: (options?: LaunchOptions) => Promise<RunningApp>
}

export const test = base.extend<AppFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求夹具的第一个参数使用解构
  userData: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cairn-e2e-'))
    await use(dir)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  },
  launch: async ({ userData }, use) => {
    const running: RunningApp[] = []
    await use(async (options) => {
      const app = await launchApp(userData, options)
      running.push(app)
      return app
    })
    await Promise.all(running.map((app) => app.close()))
  },
})

export { expect } from '@playwright/test'
