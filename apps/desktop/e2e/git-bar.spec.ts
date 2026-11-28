/**
 * 输入框上方上下文条里的工作空间与 Git 分支：新对话首页显示两个下拉，可以切换分支、
 * 新建分支、拉取；外部终端切换分支后窗口重新获得焦点时刷新。
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './app.js'
import { projectDir } from './session.js'

function git(dir: string, ...args: readonly string[]) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

test('新对话输入框上方显示工作空间与分支，支持新建分支与焦点刷新', async ({ launch, userData }) => {
  const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const dir = projectDir(userData)
  git(dir, 'init')
  git(dir, 'checkout', '-b', 'feature/git-bar')
  git(dir, 'config', 'user.email', 'e2e@cairn.test')
  git(dir, 'config', 'user.name', 'Cairn E2E')
  git(dir, 'commit', '--allow-empty', '-m', 'init')
  git(dir, 'branch', 'release/next')
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git')

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
  }, dir)

  // 还没有会话时主区直接就是新对话输入框；默认项目已选中，这里切换到测试目录
  await window.getByRole('button', { name: '工作空间：默认项目' }).click()
  await window.getByRole('menuitem', { name: '选择文件夹…' }).click()

  const context = window.getByRole('group', { name: '工作空间与分支' })
  const branchButton = (name: string) => context.getByRole('button', { name })
  await expect(context.getByRole('button', { name: '工作空间：project' })).toBeVisible()
  await expect(branchButton('当前分支：feature/git-bar')).toBeVisible()

  await branchButton('当前分支：feature/git-bar').click()
  await expect(window.getByRole('img', { name: '远端：github.com' })).toBeVisible()
  await window.getByRole('menuitem', { name: 'release/next' }).click()
  await expect(branchButton('当前分支：release/next')).toBeVisible()

  // 新建分支：从当前分支切出，建好后触发器显示新分支。
  await branchButton('当前分支：release/next').click()
  await window.getByRole('menuitem', { name: '新建分支' }).click()
  await window.getByLabel('分支名称').fill('feature/from-menu')
  await window.getByRole('button', { name: '新建并切换' }).click()
  await expect(branchButton('当前分支：feature/from-menu')).toBeVisible()

  // 没有远端时拉取会立刻失败（不访问网络），Git 的说明显示在上下文条里。
  git(dir, 'remote', 'remove', 'origin')
  await branchButton('当前分支：feature/from-menu').click()
  await window.getByRole('menuitem', { name: '拉取' }).click()
  await expect(context.getByRole('alert')).toContainText('拉取失败')

  git(dir, 'checkout', '-b', 'fix/focus-refresh')
  await window.evaluate("window.dispatchEvent(new Event('focus'))")
  await expect(branchButton('当前分支：fix/focus-refresh')).toBeVisible()
})
