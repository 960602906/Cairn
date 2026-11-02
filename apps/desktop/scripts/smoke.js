// @ts-check
/**
 * 启动冒烟测试（M0-12a）：用构建产物启动应用（需先 `pnpm build`），确认窗口加载、界面渲染、
 * agent 宿主能启动、界面经 IPC 访问到会话列表，并且数据目录与数据库按约定创建。数据写入临时目录，不污染开发与正式数据。
 *
 * Linux 上使用 `--ozone-platform=headless` 与 `--disable-gpu`，无需显示器；CI 的 Linux 容器不支持 Chromium 沙箱，
 * 另加 `--no-sandbox`（只用于本测试，应用本身的沙箱设置不受影响）。
 *
 * 用法：pnpm --filter @nexus/desktop smoke
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PREFIX = 'NEXUS_SMOKE_RESULT '
const TIMEOUT_MS = 90_000

const appDir = path.resolve(import.meta.dirname, '..')
if (!existsSync(path.join(appDir, 'out/main/index.js'))) {
  console.error('smoke: out/main/index.js not found. Run `pnpm build` first.')
  process.exit(1)
}

const electron = /** @type {string} */ (createRequire(import.meta.url)('electron'))
const userData = mkdtempSync(path.join(tmpdir(), 'nexus-smoke-'))
const args = [appDir]
if (process.platform === 'linux')
  args.push('--ozone-platform=headless', '--disable-gpu', '--no-sandbox')

const child = spawn(electron, args, {
  env: { ...process.env, NEXUS_SMOKE: '1', NEXUS_USER_DATA_DIR: userData },
  stdio: ['ignore', 'pipe', 'inherit'],
})

let output = ''
child.stdout.on('data', (chunk) => {
  output += String(chunk)
  process.stdout.write(chunk)
})

const timer = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS} ms`)
  child.kill()
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  const line = output.split(/\r?\n/).find((l) => l.startsWith(PREFIX))
  const problems = []
  if (!line) problems.push('no smoke result was printed')
  else if (!JSON.parse(line.slice(PREFIX.length)).ok) problems.push('smoke checks failed')
  if (code !== 0) problems.push(`electron exited with code ${code} (signal ${signal})`)
  for (const dir of ['data', 'data/blobs', 'checkpoints', 'logs']) {
    if (!existsSync(path.join(userData, dir))) problems.push(`missing directory ${dir}`)
  }
  if (!existsSync(path.join(userData, 'data/nexus.db')))
    problems.push('missing database data/nexus.db')
  rmSync(userData, { recursive: true, force: true })

  if (problems.length > 0) {
    for (const p of problems) console.error(`smoke: ${p}`)
    process.exit(1)
  }
  console.log('smoke: passed')
})
