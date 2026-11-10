/**
 * 单实例（M5-01）：同一数据目录只允许一个应用实例。第二个进程必须退出，不加载启动模块，
 * 因此不会运行冒烟检查、创建窗口或打开数据库。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { APP_DIR, expect, test } from './app.js'

const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const PLATFORM_ARGS = process.platform === 'linux' ? ['--disable-gpu', '--no-sandbox'] : []
const SMOKE_PREFIX = 'CAIRN_SMOKE_RESULT'

test('第二个实例只聚焦主窗口，不启动界面或数据库', async ({ launch, userData }) => {
  const first = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  await expect(first.window.getByRole('region', { name: '工作空间' })).toContainText('默认项目')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CAIRN_USER_DATA_DIR: userData,
    CAIRN_RUNTIME: 'fake',
    CAIRN_SMOKE: '1',
  }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']

  const child = spawn(electronPath, [APP_DIR, ...PLATFORM_ARGS], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`second instance did not exit within 20s:\n${output}`))
      }, 20_000)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    },
  )

  expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null })
  expect(output).not.toContain(SMOKE_PREFIX)
  expect(
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1)
  await expect(first.window.getByRole('region', { name: '工作空间' })).toContainText('默认项目')
})
