/**
 * 视觉验收（01 枢纽）：主题切换 + 六档窗口尺寸。
 *
 * - 默认主题是板岩；五套内置配色都必须真的写到 <html data-theme>。
 * - 60px 图标栏在所有目标尺寸下常驻；会话列 ≥900px 常驻，<900px 改为抽屉。
 * - 工作台 ≥1280px 占布局宽度，更窄时是右侧浮层。
 * - 页面不能出现横向滚动，输入框始终可见。
 * - 截图保存到 design/redesign-v8/live，便于人工复核。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../design/redesign-v8/live')
mkdirSync(ARTIFACTS, { recursive: true })

const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 880, height: 800 },
] as const

async function resize(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number },
) {
  await app.evaluate(({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setContentSize(next.width, next.height)
  }, size)
  await page.waitForFunction(
    (next) => {
      const view = globalThis as unknown as { innerWidth: number; innerHeight: number }
      return view.innerWidth === next.width && view.innerHeight === next.height
    },
    size,
    { timeout: 5_000 },
  )
}

async function noHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => {
    const view = globalThis as unknown as {
      innerWidth: number
      document: {
        documentElement: { scrollWidth: number }
        body: { scrollWidth: number }
      }
    }
    return {
      inner: view.innerWidth,
      document: view.document.documentElement.scrollWidth,
      body: view.document.body.scrollWidth,
    }
  })
  expect(metrics.document, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.inner + 1)
  expect(metrics.body, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.inner + 1)
}

const themeOf = (page: Page) =>
  page.evaluate(() => {
    const view = globalThis as unknown as {
      document: { documentElement: { dataset: Record<string, string | undefined> } }
    }
    return view.document.documentElement.dataset['theme']
  })

const rail = (page: Page) => page.getByRole('navigation', { name: '全局导航' })
const sessions = (page: Page) => page.getByRole('navigation', { name: '会话' })
const panel = (page: Page) => page.getByRole('complementary', { name: '会话信息' })

test('layouts hold at every target size and themes apply', async ({ launch, userData }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window
  await createSession(window, projectDir(userData), '重构设置页的信息层级')
  await sendPrompt(window, '把「模型供应商」拆成独立入口，并统一表单控件的间距。')
  await expect(runStatus(window)).toHaveText('空闲')

  // 第一次启动没有保存过主题，直接呈现板岩。
  await resize(app.app, window, { width: 1440, height: 900 })
  await expect.poll(() => themeOf(window)).toBe('slate')
  await expect(panel(window)).toBeVisible()

  for (const size of SIZES) {
    await resize(app.app, window, size)
    await noHorizontalOverflow(window)
    await expect(rail(window)).toBeVisible()
    await expect(window.getByLabel('输入消息')).toBeVisible()
    await window.screenshot({
      path: path.join(ARTIFACTS, `chat-${size.width}x${size.height}.png`),
    })
  }

  // 1440：三列尺寸符合 01 枢纽规格（图标栏 60 / 会话列 252 / 工作台 348）。
  await resize(app.app, window, { width: 1440, height: 900 })
  const widthOf = async (locator: ReturnType<typeof rail>) =>
    Math.round((await locator.boundingBox())!.width)
  expect(Math.abs((await widthOf(rail(window))) - 60)).toBeLessThanOrEqual(1)
  expect(Math.abs((await widthOf(sessions(window))) - 252)).toBeLessThanOrEqual(2)
  // 工作台从浮层切换为常驻时会有 200ms 的宽度过渡，等它稳定下来。
  await expect
    .poll(async () => Math.abs((await widthOf(panel(window))) - 348))
    .toBeLessThanOrEqual(2)
  await noHorizontalOverflow(window)

  // 1024：会话列仍在，工作台改为浮层，默认收起。
  await resize(app.app, window, { width: 1024, height: 768 })
  await expect(sessions(window)).toBeVisible()
  await expect(panel(window)).toBeHidden()
  await window.getByRole('button', { name: '会话信息', exact: true }).click()
  await expect(panel(window)).toBeVisible()
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'panel-overlay-1024x768.png') })
  await window.getByRole('button', { name: '会话信息', exact: true }).click()
  await expect(panel(window)).toBeHidden()

  // 880：会话列变成抽屉，由图标栏开合。
  await resize(app.app, window, { width: 880, height: 800 })
  await expect(sessions(window)).toHaveCount(0)
  await rail(window).getByRole('button', { name: '展开侧栏' }).click()
  await expect(sessions(window)).toBeVisible()
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'sessions-drawer-880x800.png') })
  await window.keyboard.press('Escape')
  await expect(sessions(window)).toHaveCount(0)

  // 880：设置页同样不能横向溢出。
  await rail(window).getByRole('button', { name: '设置' }).click()
  await expect(window.getByRole('heading', { name: '通用与外观' })).toBeVisible()
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'settings-880x800.png') })
  await window.keyboard.press('Escape')
  await expect(window.getByRole('heading', { name: '通用与外观' })).toHaveCount(0)

  // 主题：五套内置配色逐个应用并截图。
  await resize(app.app, window, { width: 1440, height: 900 })
  await rail(window).getByRole('button', { name: '设置' }).click()
  await window
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /^通用与外观/ })
    .click()
  const themes = window.getByRole('radiogroup', { name: '主题' })
  for (const [label, id] of [
    ['青石', 'bluestone'],
    ['黑曜', 'obsidian'],
    ['纸面', 'paper'],
    ['苔原', 'tundra'],
    ['板岩', 'slate'],
  ] as const) {
    await themes.getByRole('radio', { name: new RegExp(`^${label}`) }).click()
    await expect.poll(() => themeOf(window)).toBe(id)
    await noHorizontalOverflow(window)
    await window.screenshot({
      path: path.join(ARTIFACTS, `theme-${id}.png`),
    })
  }
})
