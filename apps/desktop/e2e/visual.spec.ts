/**
 * 视觉验收（三栏布局）：主题切换 + 六档窗口尺寸。
 *
 * - 默认跟随系统；浅色、深色都必须真的写到 <html data-theme>。
 * - 没有图标栏；252px 左栏 ≥900px 常驻，<900px 改为抽屉，由顶栏按钮展开。
 * - 工作台 ≥1440px 占布局宽度，更窄时是右侧浮层。
 * - 页面不能出现横向滚动，输入框始终可见。
 * - 截图保存到 .cache/cairn-visual-check/live，便于人工复核。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './app.js'
import {
  createSession,
  liveMessage,
  projectDir,
  runStatus,
  sendPrompt,
  sessionPanel,
} from './session.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../.cache/cairn-visual-check/live')
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

/**
 * 直接写 `data-theme`，用于给同一条状态拍浅色 / 深色两张截图（持久化在别处断言）。
 * 等颜色过渡结束再返回，避免截图停在过渡中间。
 */
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (value) => {
    const view = globalThis as unknown as {
      document: {
        documentElement: { setAttribute(name: string, value: string): void }
        getAnimations(): readonly {
          readonly constructor: { readonly name: string }
          readonly finished: Promise<unknown>
        }[]
      }
    }
    view.document.documentElement.setAttribute('data-theme', value)
    // 只等颜色过渡：循环动画（转圈、微光）永远不结束，不能一起等。
    await Promise.all(
      view.document
        .getAnimations()
        .filter((animation) => animation.constructor.name === 'CSSTransition')
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  }, theme)
}

const themeOf = (page: Page) =>
  page.evaluate(() => {
    const view = globalThis as unknown as {
      document: { documentElement: { dataset: Record<string, string | undefined> } }
    }
    return view.document.documentElement.dataset['theme']
  })

const sessions = (page: Page) => page.getByRole('navigation', { name: '会话' })
const panel = (page: Page) => sessionPanel(page)

test('layouts hold at every target size and themes apply', async ({ launch, userData }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window
  await createSession(window, projectDir(userData), '重构设置页的信息层级')
  await sendPrompt(window, '把「模型供应商」拆成独立入口，并统一表单控件的间距。')
  await expect(runStatus(window)).toHaveText('空闲')

  // 第一次启动没有保存过主题，跟随系统解析成浅色或深色。
  await resize(app.app, window, { width: 1440, height: 900 })
  await expect.poll(() => themeOf(window)).toMatch(/^(light|dark)$/)
  await expect(panel(window)).toBeVisible()

  for (const size of SIZES) {
    await resize(app.app, window, size)
    await noHorizontalOverflow(window)
    await expect(window.getByRole('navigation', { name: '全局导航' })).toHaveCount(0)
    await expect(window.getByLabel('输入消息')).toBeVisible()
    await window.screenshot({
      path: path.join(ARTIFACTS, `chat-${size.width}x${size.height}.png`),
    })
  }

  // 1440：左栏 252 / 会话信息栏 348，中间是对话。
  await resize(app.app, window, { width: 1440, height: 900 })
  const widthOf = async (locator: ReturnType<typeof sessions>) =>
    Math.round((await locator.boundingBox())!.width)
  expect(Math.round((await sessions(window).boundingBox())!.x)).toBeLessThanOrEqual(8)
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

  // 880：左栏变成抽屉，由顶栏按钮展开。
  await resize(app.app, window, { width: 880, height: 800 })
  await expect(sessions(window)).toHaveCount(0)
  await window.getByRole('button', { name: '展开侧栏' }).click()
  await expect(sessions(window)).toBeVisible()
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'sessions-drawer-880x800.png') })
  await window.keyboard.press('Escape')
  await expect(sessions(window)).toHaveCount(0)

  // 880：设置页同样不能横向溢出。设置入口在左栏抽屉里。
  await window.getByRole('button', { name: '展开侧栏' }).click()
  await window.getByRole('button', { name: /^设置/ }).click()
  await expect(window.getByRole('heading', { name: '通用与外观' })).toBeVisible()
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'settings-880x800.png') })
  await window.keyboard.press('Escape')
  await expect(window.getByRole('heading', { name: '通用与外观' })).toHaveCount(0)

  // 主题：浅色、深色逐个应用并截图。
  await resize(app.app, window, { width: 1440, height: 900 })
  await window.getByRole('button', { name: /^设置/ }).click()
  await window
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /^通用与外观/ })
    .click()
  const themes = window.getByRole('radiogroup', { name: '主题' })
  for (const [label, id] of [
    ['深色', 'dark'],
    ['浅色', 'light'],
  ] as const) {
    await themes.getByRole('radio', { name: new RegExp(`^${label}`) }).click()
    await expect.poll(() => themeOf(window)).toBe(id)
    await noHorizontalOverflow(window)
    await window.screenshot({
      path: path.join(ARTIFACTS, `theme-${id}.png`),
    })
  }
})

/**
 * 状态呈现（聊天区域状态显示优化方案 §5）：空会话引导、停止结局的分级卡片在浅色 / 深色下都可读，
 * 并且输入框上方没有新增可见状态条、计时或「按 Esc 停止」提示。
 */
test('chat status reads the same in both themes without a status bar', async ({
  launch,
  userData,
}) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window
  await createSession(window, projectDir(userData), '状态呈现')
  await resize(app.app, window, { width: 1440, height: 900 })

  // 输入框上方没有状态条：唯一的 role=status 是不占位的读屏播报。
  const status = runStatus(window)
  await expect(status).toHaveText('空闲')
  const box = await status.boundingBox()
  expect(box?.height ?? 0).toBeLessThanOrEqual(1)
  await expect(window.getByText(/按 Esc 停止|已用时间|剩余步数/)).toHaveCount(0)

  // 空会话：品牌图形 + 一句引导，而不是一条空白。
  await expect(window.getByText('开始一个新任务')).toBeVisible()
  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(ARTIFACTS, 'chat-empty-light.png') })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(ARTIFACTS, 'chat-empty-dark.png') })

  // 停止结局：中性卡片加图标标签，浅色 / 深色下都能分辨。
  const long = '这是一段很长的输入，用来在回复过程中停止。'.repeat(8)
  await sendPrompt(window, long)
  await expect(liveMessage(window)).toContainText(long.slice(0, 5))
  await window.getByRole('button', { name: '停止', exact: true }).click()
  await expect(runStatus(window)).toHaveText('空闲')
  await expect(window.getByRole('img', { name: '已停止' })).toBeVisible()
  await expect(window.getByText('开始一个新任务')).toHaveCount(0)
  await setTheme(window, 'light')
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'chat-stopped-light.png') })
  await setTheme(window, 'dark')
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'chat-stopped-dark.png') })
})
