/**
 * MCP 设置页（M3-10）：添加本地进程、查看工具与日志、显示连接失败、删除。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'

const fixture = fileURLToPath(
  new URL('../../../packages/mcp/src/testing/fixture-server.mjs', import.meta.url),
)

const artifacts = '/opt/cursor/artifacts'

async function openMcp(page: Page) {
  await page.getByRole('button', { name: /^设置/ }).click()
  const nav = page.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: 'MCP 服务' }).click()
  await expect(page.getByRole('heading', { name: 'MCP 服务' })).toBeVisible()
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(name: string, value: string): void } }
      }
    ).document.documentElement
    root.setAttribute('data-theme', value)
  }, theme)
}

test('添加、连接失败与删除 MCP 服务', async ({ launch }) => {
  const { window } = await launch()
  await openMcp(window)

  mkdirSync(artifacts, { recursive: true })

  await window.getByRole('button', { name: '添加服务' }).click()
  let dialog = window.getByRole('dialog')
  await dialog.getByLabel('名称').fill('Fixture')
  await dialog.getByLabel('命令').fill(process.execPath)
  await dialog.getByLabel('参数').fill(fixture)
  await dialog.getByRole('button', { name: '保存' }).click()

  dialog = window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Fixture' })).toBeVisible()
  await expect(dialog.getByText('mcp_fixture_echo')).toBeVisible()
  await expect(dialog.getByText(/connecting to Fixture/)).toBeVisible()
  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(artifacts, 'mcp-settings-detail-light.png') })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(artifacts, 'mcp-settings-detail-dark.png') })
  await dialog.getByRole('button', { name: '关闭' }).click()
  const list = window.getByRole('list', { name: 'MCP 服务' })
  await expect(list.getByText('Fixture')).toBeVisible()
  await expect(list.getByText('已连接')).toBeVisible()
  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(artifacts, 'mcp-settings-light.png') })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(artifacts, 'mcp-settings-dark.png') })

  await window.getByRole('button', { name: '添加服务' }).click()
  dialog = window.getByRole('dialog')
  await dialog.getByLabel('名称').fill('Broken')
  await dialog.getByLabel('命令').fill('cairn-missing-mcp-command')
  await dialog.getByRole('button', { name: '保存' }).click()
  dialog = window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Broken' })).toBeVisible()
  await expect(dialog.getByText(/已断开|错误/).first()).toBeVisible()
  await expect(dialog.getByText(/connect failed/).first()).toBeVisible()

  await dialog.getByRole('button', { name: '删除' }).click()
  const confirm = window.getByRole('dialog')
  await expect(confirm.getByText(/会删除这份配置/)).toBeVisible()
  await confirm.getByRole('button', { name: '删除服务' }).click()
  await expect(window.getByRole('heading', { name: 'MCP 服务' })).toBeVisible()
  await expect(window.getByRole('list', { name: 'MCP 服务' }).getByText('Broken')).toHaveCount(0)

  await list.getByRole('button', { name: '查看 Fixture 的详情' }).click()
  dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: '删除' }).click()
  await window.getByRole('dialog').getByRole('button', { name: '删除服务' }).click()
  await expect(window.getByText(/还没有 MCP 服务/)).toBeVisible()
})
