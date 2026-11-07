/**
 * Key 不外泄（M1 完成检查）：保存 Key 并用它完成一轮带工具调用的对话，确认模型端点收到了这个 Key；
 * 之后渲染进程的页面与请求返回值、应用进程的标准输出与标准错误、数据目录中的所有文件（数据库、日志、
 * 检查点、凭据文件等）都不含 Key 的明文。
 *
 * 需要系统加密保存 Key：Linux CI 容器没有密钥环，跳过（Windows CI 运行）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const SECRET = 'sk-e2e-leak-check-0123456789abcdef'
const REPLY = 'reply after listing files'

/** 目录下所有文件（递归）。 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
}

test('Key 只发给模型端点，不出现在渲染进程、进程输出与数据目录中', async ({ launch, userData }) => {
  const mock = await startMockModel({
    apiKey: SECRET,
    reply: REPLY,
    toolCall: { name: 'list_dir', arguments: { path: '.' } },
  })
  try {
    const running = await launch()
    const { app, window } = running
    let output = ''
    app.process().stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    app.process().stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))

    const request = (method: string, params: object) =>
      window.evaluate(
        async ([m, p]) => {
          const cairn = (
            globalThis as unknown as {
              cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
            }
          ).cairn
          await cairn.ready()
          return cairn.request(m, p)
        },
        [method, params] as const,
      )
    const replies: unknown[] = []
    const send = async (method: string, params: object) => {
      const reply = await request(method, params)
      replies.push(reply)
      return reply
    }

    const status = (await send('credentials.status', { ref: 'local' })) as {
      ok: boolean
      result?: { available: boolean }
    }
    test.skip(status.result?.available !== true, '系统加密不可用（Linux CI 没有密钥环）')

    expect(await send('credentials.set', { ref: 'local', secret: SECRET })).toEqual({
      ok: true,
      result: {},
    })
    expect(
      await send('settings.update', {
        providers: [
          {
            id: 'local',
            kind: 'openai',
            displayName: 'Local',
            baseUrl: mock.baseUrl,
            credentialRef: 'local',
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
      }),
    ).toMatchObject({ ok: true })

    await createSession(window, projectDir(userData), 'Key 检查')
    await sendPrompt(window, '列出文件')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    // Key 确实用于请求模型：调用工具、回复，以及轮次结束后的会话要点。
    await expect
      .poll(() => mock.requests.map((request) => request.authorization))
      .toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`, `Bearer ${SECRET}`])
    expect(JSON.stringify(mock.requests[2]?.messages)).toContain('You keep a session brief.')

    expect(await window.content()).not.toContain(SECRET)
    expect(JSON.stringify(replies)).not.toContain(SECRET)

    // 正常退出后数据库等文件已写完
    await running.close()
    expect(output).not.toContain(SECRET)
    const files = filesUnder(userData)
    expect(files.some((file) => file.endsWith('credentials.json'))).toBe(true)
    const leaked = files.filter((file) => readFileSync(file).includes(SECRET))
    expect(leaked).toEqual([])
  } finally {
    await mock.close()
  }
})
