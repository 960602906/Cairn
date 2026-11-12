/**
 * 输入框的 `@` 引用与 `/技能名`（ADR-0037）：候选来自工作区（遵守 .gitignore），插入后发送，
 * 模型收到文件内容或技能正文，消息里只显示用户写的文字；确认存在的引用可以点开文件。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir } from './session.js'

/** 右侧工作台：宽窗口是 complementary，窄窗口打开时是模态 dialog。 */
function sessionPanel(window: Page) {
  return window
    .getByRole('complementary', { name: '会话信息' })
    .or(window.getByRole('dialog', { name: '会话信息' }))
}

async function configure(window: Page, baseUrl: string) {
  await window.evaluate(async (baseUrl) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    await cairn.request('settings.update', {
      providers: [
        {
          id: 'local',
          kind: 'openai',
          displayName: 'Local',
          baseUrl,
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
  }, baseUrl)
  await window.reload()
}

test('@ 引用文件：选择候选、发送后模型收到文件内容', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: '看过了', title: '引用文件' })
  try {
    const project = projectDir(userData)
    mkdirSync(path.join(project, 'src'), { recursive: true })
    mkdirSync(path.join(project, '.git'), { recursive: true })
    writeFileSync(path.join(project, '.gitignore'), 'dist/\n')
    writeFileSync(path.join(project, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
    mkdirSync(path.join(project, 'dist'), { recursive: true })
    writeFileSync(path.join(project, 'dist', 'sum.mjs'), 'built\n')

    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, project, '引用文件')

    const input = window.getByRole('textbox', { name: '输入消息' })
    await input.click()
    await input.pressSequentially('解释 @sum')
    const list = window.getByRole('listbox', { name: '引用文件' })
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(list.getByRole('option')).toContainText('sum.mjs')
    await expect(list.getByRole('option')).toContainText('src')
    await input.press('Enter')
    await expect(input).toHaveValue('解释 @src/sum.mjs ')
    await expect(list).toBeHidden()
    await input.press('Enter')

    await expect(window.getByText('看过了')).toBeVisible()
    const messages = window.getByRole('list', { name: '消息' })
    await expect(messages).toContainText('解释 @src/sum.mjs')
    await expect(messages).not.toContainText('export const sum')

    // 主进程确认存在的引用是可点的：点开文件并在右侧定位
    await window.getByRole('button', { name: '@src/sum.mjs' }).click()
    const panel = sessionPanel(window)
    await expect(panel.getByRole('region', { name: '文件预览：src/sum.mjs' })).toContainText(
      'export const sum = (a, b) => a + b',
    )

    // 会话主模型的请求带着文件内容；简报等辅助请求只看用户写的文字。
    const sent = mock.requests
      .map((request) => JSON.stringify(request.messages ?? []))
      .find((body) => body.includes('<file path=\\"src/sum.mjs\\">'))
    expect(sent).toContain('export const sum = (a, b) => a + b')
    expect(sent).not.toContain('built')
  } finally {
    await mock.close()
  }
})

test('/技能名：从面板选中、写任务，模型收到技能正文', async ({ launch, userData }) => {
  const reply = '看过技能了，见 `src/sum.mjs:1`'
  const mock = await startMockModel({ reply, title: '技能指令' })
  const source = path.join(userData, 'skill-src', 'summarize')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: summarize\ndescription: Summarize the changes.\n---\nAlways answer with a summary.\n',
  )
  try {
    const project = projectDir(userData)
    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')

    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await window.evaluate(async (folder) => {
      const cairn = (
        globalThis as unknown as {
          cairn: {
            request(
              m: string,
              p: object,
            ): Promise<{ result: { installed: boolean; skill: { name: string } } }>
          }
        }
      ).cairn
      const preview = await cairn.request('skill.install', {
        source: { kind: 'directory', path: folder },
      })
      if (!preview.result.installed) {
        await cairn.request('skill.install', {
          source: { kind: 'directory', path: folder },
          confirm: true,
        })
      }
    }, source)
    await createSession(window, project, '技能指令')

    const input = window.getByRole('textbox', { name: '输入消息' })
    await input.click()
    await input.pressSequentially('/')
    const list = window.getByRole('listbox', { name: '输入指令' })
    await expect(list.getByText('指令')).toBeVisible()
    await expect(list.getByText('技能')).toBeVisible()
    await list.getByRole('option', { name: /\/summarize/ }).click()
    await expect(input).toHaveValue('/summarize ')
    await input.pressSequentially('总结一下')
    await input.press('Enter')

    const messages = window.getByRole('list', { name: '消息' })
    await expect(messages).toContainText('看过技能了')
    await expect(messages).toContainText('/summarize')
    const sent = mock.requests
      .map((request) => JSON.stringify(request.messages ?? []))
      .find((body) => body.includes('<skill name=\\"summarize\\">'))
    expect(sent).toContain('Always answer with a summary.')

    // 助手正文里的相对路径确认存在后可以点开，并滚到写出的行
    await messages.getByRole('button', { name: 'src/sum.mjs:1' }).click()
    const panel = sessionPanel(window)
    await expect(panel.getByRole('region', { name: '文件预览：src/sum.mjs' })).toContainText(
      'export const sum = (a, b) => a + b',
    )
    await expect(panel.locator('[data-line="1"]')).toHaveClass(/bg-accent-soft/)
  } finally {
    await mock.close()
  }
})
