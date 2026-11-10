/**
 * 首次运行（M5-09）：干净数据目录显示一次欢迎说明；没有模型供应商时可以直接进入设置；
 * 关闭后写入 `onboardingSeen`，再次启动不再出现。已有数据的用户升级时也可以关闭后继续使用。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test, type RunningApp } from './app.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../design/redesign-v8/onboarding')
mkdirSync(ARTIFACTS, { recursive: true })

function onboardingSeen(userData: string): unknown {
  const saved = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
  return saved['onboardingSeen']
}

/** 固定窗口内容尺寸，避免不同机器的屏幕工作区把默认 1200×800 夹到更小，导致布局断言随环境变化。 */
async function resizeWindow(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    },
    { width, height },
  )
}

/** 渲染进程的视口高度（CSS 像素）；e2e 的 TS 环境没有 DOM 类型，显式声明。 */
function viewportHeight(running: RunningApp): Promise<number> {
  return running.window.evaluate(
    () => (globalThis as unknown as { readonly innerHeight: number }).innerHeight,
  )
}

test('干净安装显示欢迎说明，配置模型后不再出现', async ({ launch, userData }) => {
  const first = await launch({
    onboardingSeen: false,
    env: { CAIRN_RUNTIME: 'fake' },
  })
  const dialog = first.window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
  await expect(dialog.getByText(/API Key 只保存在本机/)).toBeVisible()
  await expect(dialog.getByText(/命令沙箱不是虚拟机/)).toBeVisible()
  await expect(dialog.getByText(/还没有配置模型供应商/)).toBeVisible()

  await dialog.getByRole('button', { name: '配置模型' }).click()
  await expect(first.window.getByRole('heading', { name: '模型供应商' })).toBeVisible()
  await expect.poll(() => onboardingSeen(userData)).toBe(true)
  await first.close()

  const second = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  await expect(second.window.getByRole('button', { name: /^设置/ })).toBeVisible()
  await expect(second.window.getByRole('heading', { name: '欢迎使用 Cairn' })).toHaveCount(0)
})

test('稍后关闭欢迎说明后仍可浏览已有界面', async ({ launch, userData }) => {
  const { window } = await launch({
    onboardingSeen: false,
    env: { CAIRN_RUNTIME: 'fake' },
  })
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
  await dialog.getByRole('button', { name: '稍后' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(window.getByRole('region', { name: '工作空间' })).toContainText('默认项目')
  await expect.poll(() => onboardingSeen(userData)).toBe(true)
})

test('欢迎说明在深色与浅色主题下都完整显示', async ({ launch, userData }) => {
  for (const theme of ['bluestone', 'paper'] as const) {
    const running = await launch({
      onboardingSeen: false,
      theme,
      env: { CAIRN_RUNTIME: 'fake' },
    })
    const dialog = running.window.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
    await expect(running.window.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(dialog.getByText(/命令沙箱不是虚拟机/)).toBeVisible()
    await running.window.screenshot({
      path: path.join(ARTIFACTS, `welcome-${theme}.png`),
    })
    await running.close()
    rmSync(path.join(userData, 'settings.json'))
  }
})

test('常规窗口下一次读完五条说明，不出现内部滚动', async ({ launch }) => {
  const running = await launch({ onboardingSeen: false, env: { CAIRN_RUNTIME: 'fake' } })
  await expect(running.window.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
  // 1366×768 笔记本扣除任务栏与窗口边框后约 1000×720，是分发后最常见的可用高度；
  // 固定成这个尺寸，避免 CI 屏幕工作区把默认窗口夹小后断言随环境漂移。
  await resizeWindow(running.app, 1000, 720)
  const items = running.window.getByTestId('welcome-items')
  await expect.poll(() => viewportHeight(running)).toBe(720)
  const metrics = await items.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }))
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1)
  await expect(running.window.getByText(/不会自动上传/)).toBeVisible()
})

test('最小窗口下说明可以滚动读全，安全边界与操作按钮保持可见', async ({ launch }) => {
  const running = await launch({ onboardingSeen: false, env: { CAIRN_RUNTIME: 'fake' } })
  const dialog = running.window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeVisible()
  await resizeWindow(running.app, 640, 480)
  const items = dialog.getByTestId('welcome-items')
  // 应用允许把窗口缩到 640×480：此时内容应收在滚动区里，而不是把按钮挤出窗口。
  await expect.poll(() => viewportHeight(running)).toBe(480)
  await expect
    .poll(() => items.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
    .toBe(true)
  await items.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const fits = await items.evaluate((element) => {
    const container = element.getBoundingClientRect()
    const last = element.querySelector('li:last-of-type')?.getBoundingClientRect()
    return (
      last !== undefined && last.bottom <= container.bottom + 1 && last.top >= container.top - 1
    )
  })
  expect(fits).toBe(true)
  await expect(dialog.getByText(/命令沙箱不是虚拟机/)).toBeVisible()
  for (const name of ['稍后', '配置模型']) {
    const button = dialog.getByRole('button', { name })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(480)
  }
})
