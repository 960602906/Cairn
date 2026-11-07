/**
 * 打开项目与模型配置（M1-16a；M2-10 起在设置页“模型供应商”中）：用 DeepSeek 经第三方中转添加供应商（地址
 * 是本地 mock 端点），测试连接后保存，它自动成为默认模型；新建会话时用系统对话框选择项目文件夹（对话框在主进程中替换为
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

    // 设置页“模型供应商”（M2-10）：从侧栏卡片进入，用 DeepSeek 经中转接入
    await window.getByRole('button', { name: /^模型供应商/ }).click()
    await expect(window.getByText(/还没有配置模型供应商/)).toBeVisible()
    await window.getByRole('button', { name: '添加供应商' }).first().click()
    const card = window.getByRole('region', { name: '新供应商' })
    await card.getByRole('radio', { name: '第三方中转' }).click()
    await expect(card.getByLabel('服务')).toHaveValue('deepseek')
    await card.getByLabel('Base URL').fill(mock.baseUrl)
    if (process.platform === 'linux') {
      await expect(card.getByText('系统加密不可用，无法保存 Key。')).toBeVisible()
    }
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.getByRole('status')).toContainText('连接正常')
    await card.getByRole('button', { name: '保存' }).click()

    const providers = window.getByRole('list', { name: '已配置的供应商' })
    await expect(providers.getByRole('listitem')).toHaveCount(1)
    await expect(providers).toContainText('DeepSeek')
    await expect(providers).toContainText('第三方中转')
    await expect(providers).toContainText('默认')
    await expect(providers).toContainText('正常')
    await window.keyboard.press('Escape')
    await expect(window.getByRole('button', { name: /^模型供应商/ })).toContainText(
      '默认模型：DeepSeek · DeepSeek V4.1 Flash',
    )

    await window.getByRole('button', { name: '新对话' }).click()
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
    // 第一次是测试连接
    expect(mock.requests.map((r) => r.model)).toEqual(['deepseek-flash', 'deepseek-flash'])
  } finally {
    await mock.close()
  }
})
