/**
 * 打开项目与模型配置的最小界面（M1-16a）：在“模型设置”中用 DeepSeek 模板添加提供方（地址改为本地 mock
 * 端点，像经代理接入），它自动成为默认模型；新建会话时用系统对话框选择项目文件夹（对话框在主进程中替换为
 * 固定返回），之后回复来自配置的端点。Linux CI 没有系统加密，界面提示无法保存 Key，mock 端点不检查 Key。
 */
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply via template provider'

test('用模板配置模型、用对话框选择项目后对话', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    const dir = projectDir(userData)
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
    }, dir)

    await window.getByRole('button', { name: '模型设置' }).click()
    const panel = window.getByRole('dialog', { name: '模型与 Key' })
    await expect(panel.getByText('还没有配置模型。选择一个模板添加。')).toBeVisible()
    await expect(panel.getByLabel('模板')).toHaveValue('deepseek')
    await panel.getByLabel('接口地址').fill(mock.baseUrl)
    await panel.getByRole('button', { name: '添加' }).click()

    const providers = panel.getByRole('list', { name: '已配置的提供方' })
    await expect(providers.getByRole('listitem')).toHaveCount(1)
    await expect(providers).toContainText('DeepSeek')
    await expect(providers).toContainText(mock.baseUrl)
    await expect(providers).toContainText('未保存 Key')
    await expect(panel.getByLabel('默认模型').locator('option:checked')).toHaveText(
      'DeepSeek / DeepSeek V4.1 Flash',
    )
    if (process.platform === 'linux') {
      await expect(panel.getByText('系统加密不可用，无法保存 Key。')).toBeVisible()
    }
    await window.getByRole('button', { name: '模型设置' }).click()
    await expect(panel).toHaveCount(0)

    await window.getByRole('button', { name: '新建会话' }).click()
    await window.getByRole('button', { name: '选择文件夹…' }).click()
    await expect(window.getByLabel('项目目录')).toHaveValue(dir)
    await expect(window.getByLabel('最近的项目').locator('option:checked')).toHaveText(
      `project — ${dir}`,
    )
    await window.getByLabel('标题（可选）').fill('模板配置')
    await window.getByRole('button', { name: '创建' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '模板配置' })).toBeVisible()

    await sendPrompt(window, '你好')
    await expectMessages(window, [
      ['你', '你好'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
    expect(mock.requests.map((r) => r.model)).toEqual(['deepseek-flash'])
  } finally {
    await mock.close()
  }
})
