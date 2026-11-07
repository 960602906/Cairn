/**
 * 项目说明（M3-02）：项目根目录有 AGENTS.md 时，第一轮发给模型的系统提示词包含它，
 * 顶栏显示已加载的标记。项目内 `.agents/skills/` 的技能不用打开开关，默认进入技能索引。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply from configured provider'
const INSTRUCTIONS = 'Always mention the cairn marker when answering.'

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

async function configure(window: Page, baseUrl: string) {
  return window.evaluate(
    async ({ baseUrl, capabilities }) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      await cairn.ready()
      return cairn.request('settings.update', {
        providers: [
          {
            id: 'local',
            kind: 'openai',
            displayName: 'Local',
            baseUrl,
            models: [{ id: 'e2e-model', ...capabilities }],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
      })
    },
    { baseUrl, capabilities },
  )
}

test('项目里的 AGENTS.md 进入模型请求，顶栏显示标记', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY, title: '项目说明' })
  const dir = projectDir(userData)
  writeFileSync(path.join(dir, 'agents.md'), `${INSTRUCTIONS}\n`)
  const skillDir = path.join(dir, '.agents', 'skills', 'release-notes')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: release-notes\ndescription: Writes release notes for this project.\n---\nSteps.\n',
  )
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    expect(await configure(window, mock.baseUrl)).toMatchObject({ ok: true })
    await window.getByRole('button', { name: '新对话' }).click()
    await window.getByLabel('项目目录').fill(dir)
    await window.getByLabel('标题（可选）').fill('项目说明')
    await window.getByRole('button', { name: '创建' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '项目说明' })).toBeVisible()

    await sendPrompt(window, '你好')
    await expectMessages(window, [
      ['你', '你好'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
    await expect(window.getByLabel('已加载项目说明 AGENTS.md（1 行）')).toBeVisible()

    const chat = chatRequests(mock.requests)
    expect(chat).toHaveLength(1)
    const messages = JSON.stringify(chat[0]!.messages)
    expect(messages).toContain('# Project instructions (AGENTS.md)')
    expect(messages).toContain(INSTRUCTIONS)
    expect(messages).toContain('- release-notes: Writes release notes for this project.')
  } finally {
    await mock.close()
  }
})
