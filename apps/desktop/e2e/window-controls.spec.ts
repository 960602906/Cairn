/** 自绘窗口按钮：三个按钮都能被真实鼠标命中并触发主进程动作。 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../design/redesign-v8/window')
mkdirSync(ARTIFACTS, { recursive: true })

/** 三个按钮中心点命中的元素必须就是按钮本身，防止被拖拽区或遮罩吞掉点击。 */
async function hitTest(window: Page, labels: readonly string[]): Promise<string[]> {
  return window.evaluate((names) => {
    const view = globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          getBoundingClientRect(): { x: number; y: number; width: number; height: number }
        } | null
        elementFromPoint(
          x: number,
          y: number,
        ): {
          closest(selector: string): { getAttribute(name: string): string | null } | null
        } | null
      }
    }
    return names.map((label) => {
      const button = view.document.querySelector(`[aria-label="${label}"]`)
      if (!button) return `${label}:missing`
      const rect = button.getBoundingClientRect()
      const hit = view.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hit?.closest('button')?.getAttribute('aria-label') ?? 'none'
    })
  }, labels)
}

test('Windows / Linux 自绘窗口按钮可以点击', async ({ launch }) => {
  test.skip(process.platform === 'darwin', 'macOS 使用系统红绿灯')
  const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  await expect(window.getByRole('button', { name: '最小化窗口' })).toBeVisible()
  await expect(window.getByRole('button', { name: '关闭窗口' })).toBeVisible()
  expect(await hitTest(window, ['最小化窗口', '最大化窗口', '关闭窗口'])).toEqual([
    '最小化窗口',
    '最大化窗口',
    '关闭窗口',
  ])

  // 回归：窗口按钮必须渲染在拖拽顶栏之后。Windows 的原生拖拽区按绘制顺序取矩形，
  // 先渲染的 no-drag 会被后面的 drag 覆盖，真实鼠标点击就会被当成拖动而毫无反应。
  const afterDragHeader = await window.evaluate(() => {
    const view = globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          compareDocumentPosition(other: unknown): number
        } | null
      }
    }
    const header = view.document.querySelector('header.drag')
    const close = view.document.querySelector('[aria-label="关闭窗口"]')
    if (!header || !close) return false
    return (header.compareDocumentPosition(close) & 4) !== 0
  })
  expect(afterDragHeader).toBe(true)

  // 打开弹窗后，按钮仍在遮罩之上：命中的元素必须是窗口按钮本身。
  await window.keyboard.press('Control+K')
  await expect(window.getByRole('dialog')).toBeVisible()
  expect(await hitTest(window, ['最小化窗口', '最大化窗口', '关闭窗口'])).toEqual([
    '最小化窗口',
    '最大化窗口',
    '关闭窗口',
  ])
  await window.keyboard.press('Escape')

  if (process.platform === 'win32') {
    await window.getByRole('button', { name: '最大化窗口' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized()),
      )
      .toBe(true)
    // 主进程已最大化后，渲染进程还要等 maximize 事件才换成“还原窗口”。
    await expect(window.getByRole('button', { name: '还原窗口' })).toBeVisible()
    expect(await hitTest(window, ['最小化窗口', '还原窗口', '关闭窗口'])).toEqual([
      '最小化窗口',
      '还原窗口',
      '关闭窗口',
    ])
    await window.getByRole('button', { name: '还原窗口' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized()),
      )
      .toBe(false)
  }

  // Xvfb 下没有窗口管理器，最小化状态不可靠，只在实际桌面平台验证。
  if (process.platform === 'win32') {
    await window.getByRole('button', { name: '最小化窗口' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      )
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.restore()
      win?.focus()
    })
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      )
      .toBe(false)
  }

  await window.screenshot({
    path: path.join(ARTIFACTS, 'window-controls-1280x800.png'),
  })
})

test('关闭按钮关闭窗口', async ({ launch }) => {
  test.skip(process.platform === 'darwin', 'macOS 使用系统红绿灯')
  const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  const closed = app.waitForEvent('close')
  await window
    .getByRole('button', { name: '关闭窗口' })
    .evaluate((button) => (button as unknown as { click(): void }).click())
    .catch(() => {})
  await closed
})
