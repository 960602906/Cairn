/**
 * 诊断包（M3-13）：设置 → 通用 → 导出诊断包，弹窗显示导出前清单；导出后检查 zip 中的文件列表，
 * 并断言其中没有真实主目录路径与 API Key。另存浅色 / 深色截图。
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'

const ARTIFACTS_DIR =
  process.platform === 'win32' ? 'C:\\opt\\cursor\\artifacts' : '/opt/cursor/artifacts'
const API_KEY = '{{API_KEY_diag4e2e}}'

async function setTheme(window: Page, theme: 'light' | 'dark') {
  await window.evaluate((value) => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(name: string, value: string): void } }
      }
    ).document.documentElement
    root.setAttribute('data-theme', value)
  }, theme)
}

test('从通用设置导出诊断包，清单与 zip 内容正确', async ({ launch, userData }) => {
  const exportDir = path.join(userData, 'diagnostics-export')
  mkdirSync(exportDir, { recursive: true })
  const { window } = await launch({ env: { CAIRN_DIAGNOSTICS_DIR: exportDir } })

  await window.evaluate(async (key) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    await cairn.request('credentials.set', { ref: 'openai-default', secret: key })
    await cairn.request('settings.update', {
      providers: [
        {
          id: 'local',
          kind: 'openai',
          displayName: 'Local',
          baseUrl: 'https://api.openai.com/v1',
          credentialRef: 'openai-default',
          models: [
            {
              id: 'e2e-model',
              contextWindow: 32_000,
              maxOutputTokens: 1_000,
              supportsTools: true,
              supportsParallelToolCalls: false,
              supportsReasoning: false,
            },
          ],
        },
      ],
      defaultModel: { providerId: 'local', modelId: 'e2e-model' },
    })
  }, API_KEY)
  await window.reload()

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: '通用' }).click()

  const trigger = window.getByRole('button', { name: '导出诊断包' })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText('导出内容清单')).toBeVisible()
  await expect(dialog.getByText(/应用与系统版本/)).toBeVisible()
  await expect(dialog.getByText(/脱敏设置摘要/)).toBeVisible()
  await expect(dialog.getByText(/运行日志/)).toBeVisible()

  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'diagnostics-dialog-light.png') })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'diagnostics-dialog-dark.png') })
  await setTheme(window, 'light')

  await dialog.getByRole('button', { name: '导出诊断包' }).click()
  await expect(dialog.getByText('诊断包导出成功')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '在文件夹中显示' })).toBeVisible()

  const files = readdirSync(exportDir).filter((name) => name.endsWith('.zip'))
  expect(files).toHaveLength(1)
  const zip = unzipSync(readFileSync(path.join(exportDir, files[0]!)))
  const names = Object.keys(zip)
  expect(names).toContain('manifest.json')
  expect(names).toContain('app-version.json')
  expect(names).toContain('settings-summary.json')
  expect(names).toContain('logs/main.log')
  expect(names).toContain('logs/host.log')

  const all = names.map((name) => new TextDecoder().decode(zip[name]!)).join('\n')
  expect(all).not.toContain(API_KEY)
  expect(all).not.toContain(userData)
})
