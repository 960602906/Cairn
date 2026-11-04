// @ts-check
/**
 * 启动冒烟测试（M0-12a、M1-01d）：用构建产物启动应用（需先 `pnpm build`），确认窗口加载、界面渲染、
 * 界面经 IPC 访问到会话列表、agent 宿主能完成一轮对话，并且数据目录与数据库按约定创建。数据写入临时目录，不污染开发与正式数据。
 *
 * 先确认构建产物带有第三方许可声明（`out/THIRD_PARTY_NOTICES.txt`，其中列有 pi 与 ripgrep），再依次用两种运行时各启动一次
 *（每次都会用 `out/bin/` 中打包的 ripgrep 执行一次 `search`，见 `src/main/smoke.ts`）：
 * - `fake`：FakeRuntime（默认）；
 * - `pi`：pi 适配器（`NEXUS_RUNTIME=pi`），指向本脚本启动的本地 mock 端点（`mock-model.js`），
 *   确认打包进宿主的 pi 能加载、能发出请求并完成一轮对话。
 *
 * Linux 上使用 `--ozone-platform=headless` 与 `--disable-gpu`，无需显示器；CI 的 Linux 容器不支持 Chromium 沙箱，
 * 另加 `--no-sandbox`（只用于本测试，应用本身的沙箱设置不受影响）。
 *
 * 用法：pnpm --filter @nexus/desktop smoke [-- --runtime=fake|pi]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockModel } from './mock-model.js'

const PREFIX = 'NEXUS_SMOKE_RESULT '
const TIMEOUT_MS = 90_000
/** mock 端点要求的 Key（不是真实的 Key）。 */
const SMOKE_KEY = 'smoke-test-key'

const appDir = path.resolve(import.meta.dirname, '..')
if (!existsSync(path.join(appDir, 'out/main/index.js'))) {
  console.error('smoke: out/main/index.js not found. Run `pnpm build` first.')
  process.exit(1)
}

const notices = path.join(appDir, 'out/THIRD_PARTY_NOTICES.txt')
const noticeText = existsSync(notices) ? readFileSync(notices, 'utf8') : ''
if (!noticeText.includes('@earendil-works/pi-ai@') || !noticeText.includes('\nripgrep@')) {
  console.error(
    'smoke: out/THIRD_PARTY_NOTICES.txt is missing or does not list pi and ripgrep (ADR-0014).',
  )
  process.exit(1)
}

const electron = /** @type {string} */ (createRequire(import.meta.url)('electron'))

/**
 * 启动一次应用，返回发现的问题。
 * @param {string} name
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<string[]>}
 */
function runApp(name, extraEnv) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nexus-smoke-'))
  const args = [appDir]
  if (process.platform === 'linux')
    args.push('--ozone-platform=headless', '--disable-gpu', '--no-sandbox')

  const child = spawn(electron, args, {
    env: { ...process.env, ...extraEnv, NEXUS_SMOKE: '1', NEXUS_USER_DATA_DIR: userData },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
    process.stdout.write(chunk)
  })

  const timer = setTimeout(() => {
    console.error(`smoke[${name}]: timed out after ${TIMEOUT_MS} ms`)
    child.kill()
  }, TIMEOUT_MS)

  return new Promise((resolve) => {
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
      resolve(problems)
    })
  })
}

async function smokeFake() {
  return runApp('fake', { NEXUS_RUNTIME: 'fake' })
}

async function smokePi() {
  const mock = await startMockModel({ apiKey: SMOKE_KEY, reply: 'smoke reply from pi' })
  try {
    const problems = await runApp('pi', {
      NEXUS_RUNTIME: 'pi',
      NEXUS_MODEL_KIND: 'openai',
      NEXUS_MODEL_BASE_URL: mock.baseUrl,
      NEXUS_MODEL_ID: 'smoke-model',
      NEXUS_MODEL_API_KEY: SMOKE_KEY,
    })
    if (mock.requests.length === 0) problems.push('pi sent no request to the mock endpoint')
    for (const r of mock.requests) {
      if (r.authorization !== `Bearer ${SMOKE_KEY}`) problems.push('request without the API key')
      if (r.model !== 'smoke-model') problems.push(`unexpected model ${r.model}`)
      if (!r.stream) problems.push('request was not streamed')
    }
    return problems
  } finally {
    await mock.close()
  }
}

const only = process.argv.find((a) => a.startsWith('--runtime='))?.slice('--runtime='.length)
const runs = /** @type {[string, () => Promise<string[]>][]} */ ([
  ['fake', smokeFake],
  ['pi', smokePi],
]).filter(([name]) => !only || name === only)

let failed = false
for (const [name, run] of runs) {
  const problems = await run()
  for (const p of problems) console.error(`smoke[${name}]: ${p}`)
  if (problems.length > 0) failed = true
  else console.log(`smoke[${name}]: passed`)
}
if (failed) process.exit(1)
console.log('smoke: passed')
