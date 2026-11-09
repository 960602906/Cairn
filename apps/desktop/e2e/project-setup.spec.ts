/**
 * 打开项目与模型配置（M1-16a；M2-10 起在设置页“模型供应商”中）：选择 OpenAI 接口格式，填写本地 mock
 * 端点和模型，测试连接后保存并成为默认模型；新建会话时用系统对话框选择项目文件夹（对话框在主进程中替换为
 * 固定返回），之后回复来自配置的端点。Linux CI 没有系统加密，界面提示无法保存 Key，mock 端点不检查 Key。
 */
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply via template provider'

test('用模板配置模型、用对话框选择项目后对话', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    const dir = projectDir(userData)
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
    }, dir)

    // 设置页“模型供应商”（M2-10）：从侧栏设置进入，用 OpenAI 兼容端点接入
    await window.getByRole('button', { name: /^设置/ }).click()
    await window.getByRole('button', { name: /^模型供应商/ }).click()
    await expect(window.getByText('这个接口格式还没有供应商。')).toBeVisible()
    await window.getByRole('button', { name: '添加供应商' }).first().click()

    const picker = window.getByRole('dialog')
    await picker.getByRole('radio', { name: /OpenAI/ }).click()
    await picker.getByRole('button', { name: '下一步' }).click()

    const card = window.getByRole('dialog')
    await card.getByLabel('Base URL').fill(mock.baseUrl)
    await card.getByRole('button', { name: '手动添加' }).click()
    await card.getByLabel('模型名称，例如 deepseek-chat').fill('deepseek-flash')
    await card.getByRole('button', { name: '添加', exact: true }).click()
    if (process.platform === 'linux') {
      await expect(card.getByText('系统加密不可用，无法保存 Key。')).toBeVisible()
    }
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.getByRole('status')).toContainText('连接正常')
    await card.getByRole('button', { name: '保存' }).click()

    const providers = window.getByRole('list', { name: '已配置的供应商' })
    await expect(providers.getByRole('listitem')).toHaveCount(1)
    await expect(providers).toContainText('自定义供应商')
    await expect(providers).toContainText('默认')
    await expect(providers).toContainText('正常')
    await window.keyboard.press('Escape')

    await window
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '新对话' })
      .click()
    await window.getByRole('button', { name: '选择文件夹…' }).click()
    await expect(window.getByLabel('项目目录')).toHaveValue(dir)
    const recent = window.getByRole('region', { name: '最近的项目' })
    const selected = recent.getByRole('button', { name: /project/ })
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await expect(selected).toContainText(dir)
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
    expect(chatRequests(mock.requests).map((r) => r.model)).toEqual([
      'deepseek-flash',
      'deepseek-flash',
    ])
  } finally {
    await mock.close()
  }
})
