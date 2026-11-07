/**
 * 设置页“技能”（M3-08）：用系统对话框选择文件夹，先预览再安装；固定后在列表里显示正文占用的 token，
 * 详情里有正文与附带文件；最后卸载。对话框在主进程中替换为固定返回（与项目选择的 e2e 相同）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'

const BODY = 'The reviewer skill says reviewed-in-e2e.'

test('从文件夹安装技能，固定、查看详情后卸载', async ({ launch, userData }) => {
  const source = path.join(userData, 'skill-src')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    path.join(source, 'SKILL.md'),
    `---\nname: reviewer\ndescription: Reviews changes during the end-to-end test.\n---\n${BODY}\n`,
  )
  writeFileSync(path.join(source, 'notes.md'), 'Attached notes.\n')
  writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\n')

  const { app, window } = await launch()
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
  }, source)

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: '技能' }).click()
  await expect(window.getByRole('heading', { name: '技能' })).toBeVisible()
  const list = window.getByRole('list', { name: '技能' })
  await expect(list).toContainText('example')
  await expect(list).toContainText('内置')

  // 预览：读到了名称、描述、正文和附带文件，但还没有写盘
  await window.getByRole('button', { name: '安装技能' }).click()
  await window.getByRole('menuitem', { name: '从文件夹安装' }).click()
  const preview = window.getByRole('dialog')
  await expect(preview.getByRole('heading', { name: '安装“reviewer”？' })).toBeVisible()
  await expect(preview).toContainText('Reviews changes during the end-to-end test.')
  await expect(preview).toContainText(BODY)
  await expect(preview).toContainText('notes.md')
  await expect(preview).toContainText('这份技能包含脚本')
  expect(existsSync(path.join(userData, 'skills', 'reviewer'))).toBe(false)

  await preview.getByRole('button', { name: '安装' }).click()
  await expect(preview).toBeHidden()
  await expect(list).toContainText('reviewer')
  await expect(list).toContainText('已安装')
  expect(existsSync(path.join(userData, 'skills', 'reviewer', 'SKILL.md'))).toBe(true)

  // 固定后索引行加上正文的估算
  const card = list.getByRole('region', { name: 'reviewer' })
  await expect(card).toContainText(/约 \d+ tokens/)
  const pinned = list.getByRole('switch', { name: '始终加载 reviewer' })
  await pinned.click()
  await expect(pinned).toHaveAttribute('aria-checked', 'true')
  await expect(card).toContainText(/约 \d+ tokens/)

  const artifacts = '/opt/cursor/artifacts'
  mkdirSync(artifacts, { recursive: true })
  const setTheme = (theme: 'light' | 'dark') =>
    window.evaluate((value) => {
      const root = (
        globalThis as unknown as {
          document: { documentElement: { setAttribute(name: string, value: string): void } }
        }
      ).document.documentElement
      root.setAttribute('data-theme', value)
    }, theme)
  await setTheme('light')
  await window.screenshot({ path: path.join(artifacts, 'skills-settings-light.png') })
  await setTheme('dark')
  await window.screenshot({ path: path.join(artifacts, 'skills-settings-dark.png') })

  await card.getByRole('button', { name: '查看 reviewer 的详情' }).click()
  const detail = window.getByRole('dialog')
  await expect(detail).toContainText(BODY)
  await expect(detail).toContainText('notes.md')
  await expect(detail).toContainText('脚本')
  await detail.screenshot({ path: path.join(artifacts, 'skills-detail-dark.png') })
  await detail.getByRole('button', { name: '关闭' }).click()
  await expect(detail).toBeHidden()

  await list.getByRole('button', { name: '卸载 reviewer' }).click()
  const confirm = window.getByRole('dialog')
  await expect(confirm.getByRole('heading', { name: '卸载“reviewer”？' })).toBeVisible()
  await confirm.getByRole('button', { name: '卸载技能' }).click()
  await expect(confirm).toBeHidden()
  await expect(list).not.toContainText('reviewer')
  expect(existsSync(path.join(userData, 'skills', 'reviewer'))).toBe(false)
})
