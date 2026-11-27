/**
 * 输入框卡片工具栏里的工作空间与 Git 分支：新对话首页显示「工作空间 · 分支」，可以分别切换；
 * 外部终端切换分支后窗口重新获得焦点时刷新。
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './app.js'
import { projectDir } from './session.js'

function git(dir: string, ...args: readonly string[]) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

test('新对话输入框工具栏显示工作空间与分支，焦点回来后刷新分支', async ({ launch, userData }) => {
  const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const dir = projectDir(userData)
  git(dir, 'init')
  git(dir, 'checkout', '-b', 'feature/git-bar')
  git(dir, 'config', 'user.email', 'e2e@cairn.test')
  git(dir, 'config', 'user.name', 'Cairn E2E')
  git(dir, 'commit', '--allow-empty', '-m', 'init')
  git(dir, 'branch', 'release/next')

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
  }, dir)

  // 还没有会话时主区直接就是新对话输入框；默认项目已选中，这里切换到测试目录
  await window.getByRole('button', { name: '工作空间：默认项目' }).click()
  await window.getByRole('menuitem', { name: '选择文件夹…' }).click()

  const workspace = window.getByRole('group', { name: '当前工作区' })
  const trigger = workspace.getByRole('button', {
    name: '工作空间：project，分支：feature/git-bar',
  })
  await expect(trigger).toBeVisible()
  await expect(workspace.getByText('project', { exact: true })).toBeVisible()

  await trigger.click()
  await window.getByRole('menuitem', { name: 'release/next' }).click()
  await expect(
    workspace.getByRole('button', { name: '工作空间：project，分支：release/next' }),
  ).toBeVisible()

  git(dir, 'checkout', '-b', 'fix/focus-refresh')
  await window.evaluate("window.dispatchEvent(new Event('focus'))")
  await expect(
    workspace.getByRole('button', { name: '工作空间：project，分支：fix/focus-refresh' }),
  ).toBeVisible()
})
