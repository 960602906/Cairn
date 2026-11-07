/**
 * 按块撤销（M3-06）：一次改动里有两块，撤销其中一块后文件只恢复这一块。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const LINES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
const BEFORE = `${LINES.join('\n')}\n`
const AFTER = BEFORE.replace('\nc\n', '\nC\n').replace('\nk\n', '\nK\n')
const ONLY_SECOND = BEFORE.replace('\nk\n', '\nK\n')

test('一次改动两处，撤销其中一块只恢复这一块', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: '两处都改了',
    toolCall: { name: 'write_file', arguments: { path: 'notes.txt', content: AFTER } },
  })
  try {
    const { window } = await launch()
    await window.evaluate(async (url) => {
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
            baseUrl: url,
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
    }, mock.baseUrl)

    const dir = projectDir(userData)
    const file = path.join(dir, 'notes.txt')
    writeFileSync(file, BEFORE)

    await createSession(window, dir, '改两处')
    await sendPrompt(window, '把两处字母改成大写')
    await window.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText('两处都改了')).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    expect(readFileSync(file, 'utf8')).toBe(AFTER)

    const turn = window.getByRole('region', { name: '本轮变更' })
    await turn.getByRole('button', { name: /notes\.txt/ }).click()
    const diff = window.getByRole('figure', { name: '差异：notes.txt' })
    await expect(diff).toBeVisible()
    const revertButtons = diff.getByRole('button', { name: '撤销此块' })
    await expect(revertButtons).toHaveCount(2)

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
    const header = diff.getByText(/^@@ /).first()
    await header.hover()
    await setTheme('light')
    await diff.screenshot({ path: path.join(artifacts, 'hunk-revert-light.png') })
    await setTheme('dark')
    await header.hover()
    await diff.screenshot({ path: path.join(artifacts, 'hunk-revert-dark.png') })

    await revertButtons.first().click()
    await expect(diff.getByText('已撤销 1/2 块')).toBeVisible()
    await expect(turn.getByRole('button', { name: /已撤销 1\/2 块/ })).toBeVisible()
    await expect(diff.getByText('已撤销', { exact: true })).toBeVisible()
    expect(readFileSync(file, 'utf8')).toBe(ONLY_SECOND)
    await header.hover()
    await diff.screenshot({ path: path.join(artifacts, 'hunk-revert-reverted-dark.png') })
    await setTheme('light')
    await diff.screenshot({ path: path.join(artifacts, 'hunk-revert-reverted-light.png') })
  } finally {
    await mock.close()
  }
})
