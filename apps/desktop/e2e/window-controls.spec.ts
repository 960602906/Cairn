/** 自绘窗口按钮：主题跟随、最大化 / 还原，以及打开弹窗后仍在最上层。 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../design/redesign-v8/window')
mkdirSync(ARTIFACTS, { recursive: true })

test('Windows / Linux 使用自绘窗口按钮', async ({ launch }) => {
  test.skip(process.platform === 'darwin', 'macOS 使用系统红绿灯')
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  await expect(window.getByRole('button', { name: '最小化窗口' })).toBeVisible()
  await expect(window.getByRole('button', { name: '关闭窗口' })).toBeVisible()

  const maximize = window.getByRole('button', { name: '最大化窗口' })
  await expect(maximize).toBeVisible()

  if (process.platform === 'win32') {
    await maximize.click()
    await expect(window.getByRole('button', { name: '还原窗口' })).toBeVisible()
    await window.getByRole('button', { name: '还原窗口' }).click()
    await expect(window.getByRole('button', { name: '最大化窗口' })).toBeVisible()
  }

  // 打开弹窗后，按钮仍在遮罩之上：命中的元素必须是窗口按钮本身。
  await window.keyboard.press('Control+K')
  await expect(window.getByRole('dialog')).toBeVisible()
  const topmost = await window.evaluate(() => {
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
    const button = view.document.querySelector('[aria-label="最大化窗口"]')
    if (!button) return undefined
    const rect = button.getBoundingClientRect()
    return view.document
      .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      ?.closest('button')
      ?.getAttribute('aria-label')
  })
  expect(topmost).toBe('最大化窗口')

  await window.screenshot({
    path: path.join(ARTIFACTS, 'window-controls-dialog-1280x800.png'),
  })
})
