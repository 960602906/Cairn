/**
 * 设置页“通用与外观”（M2-09）：从侧栏打开，主题即时生效，默认 Shell 显示主进程检测到的 shell，
 * 全局指令保存到 `settings.json`；Esc 返回对话，重新打开后仍是保存的内容。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'

test('设置页：主题、默认 Shell 与全局指令', async ({ launch, userData }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  await window.getByRole('button', { name: /^设置/ }).click()
  await expect(window.getByRole('heading', { name: '通用与外观' })).toBeVisible()

  await window
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: /^板岩/ })
    .click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'slate')

  if (process.platform === 'win32') {
    await expect(
      window
        .getByRole('radiogroup', { name: '默认 Shell' })
        .getByRole('radio', { name: /^自动（/ }),
    ).toHaveAttribute('aria-checked', 'true')
  } else {
    await expect(window.getByText(/^自动（(bash|zsh|sh)）$/)).toBeVisible()
  }

  const box = window.getByRole('textbox', { name: '全局指令' })
  await box.fill('回复用中文')
  await window.getByRole('button', { name: '保存' }).click()
  await expect(window.getByRole('button', { name: '保存' })).toHaveCount(0)

  await window.keyboard.press('Escape')
  await expect(window.getByRole('heading', { name: '通用与外观' })).toHaveCount(0)
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
  await expect(window.getByRole('textbox', { name: '全局指令' })).toHaveValue('回复用中文')

  const saved = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
  expect(saved).toMatchObject({ theme: 'slate', instructions: '回复用中文' })
})
