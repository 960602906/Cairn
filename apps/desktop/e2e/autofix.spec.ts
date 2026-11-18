/**
 * 自动修复的设置页与活动中心（M8-05）：假 GitHub + 模拟模型跑通「CI 失败 → 开修复会话 →
 * 活动中心可见并可跳转」的整条界面链路，并验证暂停 / 恢复。
 *
 * 推送需要真实的 GitHub 远端，这里不覆盖；推送与分支守卫由 `auto-fix-service` /
 * `git-tools` 的单元测试覆盖。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { startFakeGithub } from './fake-github.js'
import { configureProvider, rpc } from './session.js'

const AUTHOR = { name: 'Cairn E2E', email: 'e2e@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
    },
  }).trim()
}

/** 本地裸仓库当作 origin，`feature` 分支就是假 PR 的 head。 */
function prepareRepo(userData: string): { projectPath: string; headSha: string } {
  const origin = path.join(userData, 'origin.git')
  git(userData, 'init', '--bare', origin)
  const projectPath = path.join(userData, 'repo')
  mkdirSync(projectPath)
  git(projectPath, 'init', '-b', 'main')
  writeFileSync(path.join(projectPath, 'app.txt'), 'one\n')
  git(projectPath, 'add', '-A')
  git(projectPath, 'commit', '-m', 'init')
  git(projectPath, 'remote', 'add', 'origin', origin)
  git(projectPath, 'push', 'origin', 'main')
  git(projectPath, 'checkout', '-b', 'feature')
  writeFileSync(path.join(projectPath, 'app.txt'), 'two\n')
  git(projectPath, 'commit', '-am', 'feature work')
  git(projectPath, 'push', 'origin', 'feature')
  const headSha = git(projectPath, 'rev-parse', 'HEAD')
  git(projectPath, 'checkout', 'main')
  return { projectPath, headSha }
}

test.skip(process.platform === 'linux', 'GitHub 令牌需要系统密钥环')

test('自动修复：CI 失败触发修复会话，活动中心可查看并暂停', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const { projectPath, headSha } = prepareRepo(userData)
  const github = await startFakeGithub({
    repo: 'o/r',
    number: 1,
    headRef: 'feature',
    headSha,
    checks: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
    log: 'TypeError: boom in the login flow',
  })
  const mock = await startMockModel({
    reply: '已修复登录检查。',
    toolCalls: [{ name: 'write_file', arguments: { path: 'app.txt', content: 'three\n' } }],
  })
  try {
    const { window } = await launch({ env: { CAIRN_GITHUB_API_URL: github.baseUrl } })
    await configureProvider(window, mock.baseUrl, 'e2e-key')
    // 注册项目，添加监视时可以从「本地仓库」里选到它。
    await rpc(window, 'session.create', { projectPath })
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    await window.getByRole('button', { name: /^设置/ }).click()
    const nav = window.getByRole('navigation', { name: '设置分类' })
    await nav.getByRole('button', { name: '自动修复' }).click()
    await expect(window.getByRole('heading', { name: '自动修复' })).toBeVisible()

    // 连接 GitHub（假服务接受任何令牌），再查一次 PR。
    await window.getByRole('textbox', { name: 'GitHub 令牌' }).fill('e2e-token')
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(window.getByText('已连接 e2e-user')).toBeVisible()

    await window.getByRole('textbox', { name: '仓库', exact: true }).fill('o/r')
    await window.getByRole('spinbutton', { name: 'PR 编号', exact: true }).fill('1')
    await window.getByRole('button', { name: '查询' }).click()
    await expect(window.getByText('Fix the failing check')).toBeVisible()
    const checks = window.getByRole('list', { name: '检查项' })
    await expect(checks.getByText('失败', { exact: true })).toBeVisible()
    await checks.getByRole('button', { name: '查看日志' }).click()
    await expect(window.getByText(/boom in the login flow/)).toBeVisible()

    // 添加监视：立即评估一次，开出修复会话。
    await window.getByRole('combobox', { name: '本地仓库' }).selectOption(projectPath)
    await window.getByRole('textbox', { name: '监视仓库' }).fill('o/r')
    await window.getByRole('spinbutton', { name: '监视 PR 编号' }).fill('1')
    await window.getByRole('button', { name: '添加监视' }).click()
    await expect(window.getByText('o/r#1')).toBeVisible()
    await expect(window.getByText(/最近：待检查/)).toBeVisible({ timeout: 40_000 })

    // 活动中心：任务可见，并可跳到修复会话。
    await window.keyboard.press('Escape')
    await window.getByRole('button', { name: '活动', exact: true }).click()
    await expect(window.getByRole('heading', { level: 2, name: '活动' })).toBeVisible()
    const autoFix = window.getByRole('region', { name: '自动修复' })
    await expect(autoFix).toBeVisible()
    const item = autoFix.getByRole('article', { name: '自动修复：o/r#1' })
    await expect(item).toBeVisible()
    await expect(item.getByText('待检查')).toBeVisible()
    await item.getByRole('button', { name: '查看' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '自动修复 o/r#1' })).toBeVisible()
    await expect(window.getByText(/失败的检查：test/)).toBeVisible()

    // 暂停全部：状态可见，恢复后回到监视中。
    await window.getByRole('button', { name: /^设置/ }).click()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '自动修复' })
      .click()
    await window.getByRole('button', { name: '暂停全部' }).click()
    await expect(window.getByText('监视已暂停')).toBeVisible()
    await window.getByRole('button', { name: '恢复全部' }).click()
    await expect(window.getByText('正在监视')).toBeVisible()

    // 假服务确实收到了带令牌的请求。
    expect(github.requests.some((request) => request.authorization?.startsWith('Bearer '))).toBe(
      true,
    )
  } finally {
    await mock.close()
    await github.close()
  }
})
