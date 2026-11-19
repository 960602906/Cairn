/**
 * 自动修复的触发与活动中心（M8-05）：假 GitHub + 模拟模型跑通「CI 失败 → 开修复会话 →
 * 活动中心可见并可跳转」的整条界面链路。监视由会话里的 Agent 开启（`watch_pull_request`）；
 * GitHub 令牌经 `GH_TOKEN` 静默解析，设置页不再有自动修复分类。
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
    const { window } = await launch({
      env: { CAIRN_GITHUB_API_URL: github.baseUrl, GH_TOKEN: 'e2e-token' },
    })
    await configureProvider(window, mock.baseUrl, 'e2e-key')
    // 注册项目，添加监视时可以从「本地仓库」里选到它。
    await rpc(window, 'session.create', { projectPath })
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    // 设置页没有自动修复分类：令牌自动解析，监视由会话开启。
    await window.getByRole('button', { name: /^设置/ }).click()
    const nav = window.getByRole('navigation', { name: '设置分类' })
    await expect(nav.getByRole('button', { name: '自动修复' })).toHaveCount(0)
    await window.keyboard.press('Escape')

    // 会话里开启监视（Agent 的 watch_pull_request 走同一个入口）：立即评估一次，开出修复会话。
    await rpc(window, 'autofix.watch.add', {
      repo: 'o/r',
      prNumber: 1,
      projectPath,
      triggers: ['ci', 'conflict'],
    })

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

    // 回到活动中心，可以停止监视。
    await window.getByRole('button', { name: '活动', exact: true }).click()
    const row = window.getByRole('article', { name: '自动修复：o/r#1' })
    await row.getByRole('button', { name: '停止监视' }).click()
    await expect(row).toHaveCount(0)

    // 假服务确实收到了带令牌的请求。
    expect(github.requests.some((request) => request.authorization?.startsWith('Bearer '))).toBe(
      true,
    )
  } finally {
    await mock.close()
    await github.close()
  }
})
