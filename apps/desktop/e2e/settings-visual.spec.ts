/**
 * 设置页视觉验收：四种窗口尺寸 × 全部分类，全部不能出现横向滚动；同时检查分类搜索与
 * Windows 窗口标题区底色是否跟随主题。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'
import { resizeWindow } from './window-size.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../.cache/cairn-visual-check/settings')
mkdirSync(ARTIFACTS, { recursive: true })

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 880, height: 800 },
] as const

const SECTIONS = [
  ['general', '通用与外观'],
  ['archived', '已归档的对话'],
  ['agents', 'Agents'],
  ['teams', '团队模板'],
  ['providers', '模型供应商'],
  ['skills', '技能'],
  ['mcp', 'MCP 服务'],
  ['memory', '记忆'],
  ['permissions', '权限与审批'],
  ['about', '关于 Cairn'],
] as const

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

/** 等分类里的异步内容就绪：团队模板列表至少要有内置模板，否则测到的是空状态。 */
async function waitForSectionContent(window: Page, id: string) {
  if (id !== 'teams') return
  await expect(window.getByText('代码审查小组')).toBeVisible()
}

test('设置页在四种窗口尺寸下都不溢出', async ({ launch }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })

  for (const size of SIZES) {
    await resizeWindow(app.app, window, size)
    for (const [id, title] of SECTIONS) {
      await nav.getByRole('button', { name: new RegExp(`^${title}`) }).click()
      await expect(window.getByRole('heading', { name: title, level: 2 })).toBeVisible()
      await waitForSectionContent(window, id)
      await noHorizontalOverflow(window)
      if (size.width === 1440) {
        await window.screenshot({
          path: path.join(ARTIFACTS, `section-${id}-1440x900.png`),
        })
      }
    }
    await window.screenshot({
      path: path.join(ARTIFACTS, `settings-${size.width}x${size.height}.png`),
    })
  }

  // 分类搜索只留下匹配项
  await window.getByRole('searchbox', { name: '搜索设置' }).fill('技能')
  await expect(nav.getByRole('button', { name: /^技能/ })).toBeVisible()
  await expect(nav.getByRole('button', { name: /^模型供应商/ })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: /^通用与外观/ })).toHaveCount(0)

  // 团队模板的关键词也能命中所属分类。
  await window.getByRole('searchbox', { name: '搜索设置' }).fill('团队')
  await expect(nav.getByRole('button', { name: /^团队模板/ })).toBeVisible()
  await expect(nav.getByRole('button', { name: /^Agents/ })).toHaveCount(0)

  // 搜索具体设置项（而不是分类名）也能定位到所属分类
  await window.getByRole('searchbox', { name: '搜索设置' }).fill('shell')
  await expect(nav.getByRole('button', { name: /^通用与外观/ })).toBeVisible()
  await expect(nav.getByRole('button', { name: /^技能/ })).toHaveCount(0)
})

test('浅色主题在窄窗口下全部分类都不溢出', async ({ launch }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window

  await window.getByRole('button', { name: /^设置/ }).click()
  await window
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: /^浅色/ })
    .click()

  const nav = window.getByRole('navigation', { name: '设置分类' })
  await resizeWindow(app.app, window, { width: 880, height: 800 })
  for (const [id, title] of SECTIONS) {
    await nav.getByRole('button', { name: new RegExp(`^${title}`) }).click()
    await expect(window.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    await waitForSectionContent(window, id)
    await noHorizontalOverflow(window)
    if (id === 'general' || id === 'skills' || id === 'mcp' || id === 'memory' || id === 'teams') {
      await window.screenshot({
        path: path.join(ARTIFACTS, `section-${id}-light-880x800.png`),
      })
    }
  }

  await resizeWindow(app.app, window, { width: 1024, height: 768 })
  for (const [id, title] of SECTIONS) {
    await nav.getByRole('button', { name: new RegExp(`^${title}`) }).click()
    await waitForSectionContent(window, id)
    await noHorizontalOverflow(window)
  }

  // 批量操作栏在窄窗口下换行，不能把页面撑宽。
  await nav.getByRole('button', { name: /^技能/ }).click()
  await window.getByRole('button', { name: '批量' }).click()
  await expect(window.getByRole('button', { name: '退出批量' })).toBeVisible()
  await noHorizontalOverflow(window)
  await resizeWindow(app.app, window, { width: 880, height: 800 })
  await noHorizontalOverflow(window)
  await window.screenshot({
    path: path.join(ARTIFACTS, 'section-skills-batch-880x800.png'),
  })
})

test('记忆页在深色下不溢出（M7-04）', async ({ launch }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' }, theme: 'dark' })
  const window = app.window
  await window.getByRole('button', { name: /^设置/ }).click()
  await window
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /^记忆/ })
    .click()
  await expect(window.getByRole('heading', { name: '记忆', level: 2 })).toBeVisible()
  await resizeWindow(app.app, window, { width: 1440, height: 900 })
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'section-memory-dark-1440x900.png') })
})

test('记忆页的英文界面在窄窗口下不溢出（M7-04）', async ({ launch }) => {
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' }, locale: 'en-US', theme: 'light' })
  const window = app.window
  await window.getByRole('button', { name: /^Settings/ }).click()
  await window
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: /^Memory/ })
    .click()
  await expect(window.getByRole('heading', { name: 'Memory', level: 2 })).toBeVisible()
  await resizeWindow(app.app, window, { width: 1024, height: 768 })
  await noHorizontalOverflow(window)
  await window.screenshot({ path: path.join(ARTIFACTS, 'section-memory-en-1024x768.png') })
})

test('窗口标题区底色跟随主题', async ({ launch }) => {
  test.skip(process.platform === 'darwin', 'macOS 使用系统红绿灯')
  const app = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const window = app.window

  const background = async () =>
    (
      (await app.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
      )) ?? ''
    ).toLowerCase()

  await window.getByRole('button', { name: /^设置/ }).click()
  const themes = window.getByRole('radiogroup', { name: '主题' })

  await themes.getByRole('radio', { name: /^深色/ }).click()
  await expect.poll(background).toBe('#0a0c10')

  await themes.getByRole('radio', { name: /^浅色/ }).click()
  await expect.poll(background).toBe('#f5f5f6')
})
