/**
 * 多步骤工具调用归组（#186、#188）：同一轮的多个工具步骤收进一个活动分组。
 * 默认折叠为一行“做过什么”的摘要；等待审批、失败或取消时自动展开；用户可以手动开合。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt, sessionPanel } from './session.js'

const REPLY = 'done，见 b.txt、notes.md 和 pic.png'
/** 1×1 的透明 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('多步骤工具调用归组：审批时展开，结束后收起，可手动开合', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCalls: [
      { name: 'read_file', arguments: { path: 'a.txt' } },
      { name: 'write_file', arguments: { path: 'b.txt', content: 'hi\n' } },
    ],
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
    writeFileSync(path.join(dir, 'a.txt'), 'original\n')
    writeFileSync(path.join(dir, 'notes.md'), '# 笔记\n\n正文\n')
    writeFileSync(path.join(dir, 'pic.png'), PNG)
    await createSession(window, dir, '归组测试')
    await sendPrompt(window, '读一下再写一个文件')

    // 等待审批时分组自动展开：已完成的读文件与待审批的写文件都在可访问树里。
    const approval = window.getByRole('article', { name: '需要审批：write_file' })
    await expect(approval).toBeVisible()
    const group = window.locator('[data-activity-group]')
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(window.getByRole('region', { name: '调用工具：read_file' })).toBeVisible()

    await approval.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    // 轮次正常结束后收起：步骤不再出现在可访问树里，只剩一行分组摘要。
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByRole('region', { name: '调用工具：read_file' })).toHaveCount(0)
    await expect(window.getByRole('region', { name: '调用工具：write_file' })).toHaveCount(0)

    // 手动展开后两步都可见；再次点击收起。
    await group.click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(window.getByRole('region', { name: '调用工具：read_file' })).toContainText('完成')
    await expect(window.getByRole('region', { name: '调用工具：write_file' })).toContainText('完成')

    // 文件类工具的对象可以点开：右侧工作台打开这个文件，写过的文件直接显示改动。
    await window
      .getByRole('region', { name: '调用工具：write_file' })
      .getByTitle('在右侧打开 b.txt')
      .click()
    await expect(
      sessionPanel(window).getByRole('region', { name: /文件(预览|改动)：b\.txt/ }),
    ).toBeVisible()
    // 窄窗口下工作台是浮层：关掉它再继续操作对话列。
    await window.keyboard.press('Escape')

    await group.click()
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByRole('region', { name: '调用工具：read_file' })).toHaveCount(0)

    // 正文里提到的文件名也能点开（回复写的是“见 b.txt”），这一轮改过的文件直接显示改动。
    await window.getByRole('button', { name: 'b.txt', exact: true }).click()
    await expect(
      sessionPanel(window).getByRole('region', { name: /文件(预览|改动)：b\.txt/ }),
    ).toBeVisible()
    await window.keyboard.press('Escape')

    // Markdown 文件按文本预览；图片直接显示预览图，而不是“二进制文件”。
    await window.getByRole('button', { name: 'notes.md', exact: true }).click()
    await expect(
      sessionPanel(window).getByRole('region', { name: '文件预览：notes.md' }),
    ).toContainText('正文')
    await window.keyboard.press('Escape')

    await window.getByRole('button', { name: 'pic.png', exact: true }).click()
    const image = sessionPanel(window).getByRole('region', { name: '文件预览：pic.png' })
    await expect(image.getByRole('img', { name: 'pic.png' })).toBeVisible()
    await expect(image).not.toContainText('二进制文件')
    await window.keyboard.press('Escape')

    // 「本轮变更」里的文件同样是去右侧打开。
    await window.getByRole('region', { name: '本轮变更' }).getByTitle('在右侧打开 b.txt').click()
    await expect(
      sessionPanel(window).getByRole('region', { name: /文件(预览|改动)：b\.txt/ }),
    ).toBeVisible()
    await window.keyboard.press('Escape')
  } finally {
    await mock.close()
  }
})
