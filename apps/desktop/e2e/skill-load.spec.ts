/**
 * 技能（M3-07）：安装一份技能后，模型请求带上索引；mock 模型调用 load_skill，下一轮请求里有正文。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'loaded the skill'
const DESCRIPTION = 'A skill installed during the end-to-end test.'
const BODY = 'The installed skill says installed-skill-body.'

test('安装技能后，模型调用 load_skill 能拿到正文', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCall: { name: 'load_skill', arguments: { name: 'marker' } },
  })
  const source = path.join(userData, 'skill-src', 'marker')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    path.join(source, 'SKILL.md'),
    `---\nname: marker\ndescription: ${DESCRIPTION}\n---\n${BODY}\n`,
  )
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

    const installed = await window.evaluate(async (folder) => {
      const cairn = (
        globalThis as unknown as {
          cairn: {
            request(
              m: string,
              p: object,
            ): Promise<{ ok: boolean; result: { installed: boolean; skill: { name: string } } }>
          }
        }
      ).cairn
      const preview = await cairn.request('skill.install', {
        source: { kind: 'directory', path: folder },
      })
      if (preview.result.installed) return preview
      return cairn.request('skill.install', {
        source: { kind: 'directory', path: folder },
        confirm: true,
      })
    }, source)
    expect(installed).toMatchObject({
      ok: true,
      result: { installed: true, skill: { name: 'marker' } },
    })

    await createSession(window, projectDir(userData), '技能')
    await sendPrompt(window, '用一下 marker 技能')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    const chat = chatRequests(mock.requests)
    expect(chat.length).toBeGreaterThanOrEqual(2)
    const first = JSON.stringify(chat[0]!.messages)
    const second = JSON.stringify(chat[1]!.messages)
    expect(first).toContain('# Skills')
    expect(first).toContain(DESCRIPTION)
    expect(first).not.toContain('installed-skill-body')
    expect(second).toContain('installed-skill-body')
  } finally {
    await mock.close()
  }
})
