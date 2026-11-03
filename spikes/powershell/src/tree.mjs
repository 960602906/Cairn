// @ts-check
/**
 * 进程树结束：PowerShell 中启动多层子进程，等它们都启动后，按不同方式结束，检查是否有残留进程。
 *
 * 场景（`fixtures/tree.mjs`）：
 * - `nested`：PowerShell → node(root) → node(mid) → node(leaf)；
 * - `orphan`：root 以 detached 启动 mid 后退出，mid、leaf 的父进程已不存在；PowerShell 继续等待；
 * - `start-process`：PowerShell 用 `Start-Process -NoNewWindow` 启动 nested 树后等待。
 *
 * 结束方式：
 * - `kill`：只结束 PowerShell 进程（`child.kill()`，对照组）；
 * - `taskkill`：`taskkill /T /F /PID <PowerShell>`，按父子关系结束；
 * - `job`：启动后立即把 PowerShell 放进 Job Object，结束时 `TerminateJobObject`；
 * - `job-close`：同上，结束时只关闭作业句柄（KILL_ON_JOB_CLOSE，模拟应用退出或崩溃）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JobObject, jobObjectsAvailable } from './job-object.mjs'
import { FIXTURES, psQuote, runPowerShell } from './powershell.mjs'

export const SCENARIOS = /** @type {const} */ (['nested', 'orphan', 'start-process'])
export const STRATEGIES = /** @type {const} */ (['kill', 'taskkill', 'job', 'job-close'])

/** 各场景在结束前应存活的角色（orphan 的 root 已自行退出）。 */
const EXPECTED = {
  nested: ['root', 'mid', 'leaf'],
  orphan: ['mid', 'leaf'],
  'start-process': ['root', 'mid', 'leaf'],
}

const alive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'
  }
}

/** @param {string} file @returns {{ role: string, pid: number }[]} */
const readPids = (file) => {
  try {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [role, pid] = line.trim().split(' ')
        return { role: /** @type {string} */ (role), pid: Number(pid) }
      })
  } catch {
    return []
  }
}

/** @param {typeof SCENARIOS[number]} scenario @param {string} pidFile */
function scenarioScript(scenario, pidFile) {
  const tree = path.join(FIXTURES, 'tree.mjs')
  const node = psQuote(process.execPath)
  if (scenario === 'start-process') {
    // Start-Process 的参数按命令行拼接，含空格的路径需要自带双引号
    const args = [`"${tree}"`, 'nested', `"${pidFile}"`].map(psQuote).join(', ')
    return `Start-Process -FilePath ${node} -ArgumentList @(${args}) -NoNewWindow\nStart-Sleep -Seconds 120`
  }
  // nested：PowerShell 等待 root（root 一直运行）；orphan：root 很快退出，PowerShell 进入等待
  return `& ${node} ${psQuote(tree)} ${scenario} ${psQuote(pidFile)}\nStart-Sleep -Seconds 120`
}

/**
 * @param {{ id: string, exe: string }} shell
 * @param {typeof SCENARIOS[number]} scenario
 * @param {typeof STRATEGIES[number]} strategy
 * @param {string} workRoot
 */
export async function runTreeCase(shell, scenario, strategy, workRoot) {
  const work = path.join(workRoot, shell.id, 'tree', `${scenario}-${strategy}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const pidFile = path.join(work, 'pids.txt')
  const usesJob = strategy === 'job' || strategy === 'job-close'
  if (usesJob && !jobObjectsAvailable()) return { ok: null, detail: '仅 Windows' }

  /** @type {JobObject | undefined} */
  let job
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child
  let assigned = false
  const done = runPowerShell(shell, scenarioScript(scenario, pidFile), {
    wrap: 'scriptblock',
    cwd: work,
    timeoutMs: 60_000,
    onSpawn: (c) => {
      child = c
      if (usesJob && c.pid !== undefined) {
        job = new JobObject()
        assigned = job.assign(c.pid)
      }
    },
  })

  // 等所有角色都启动
  const expected = EXPECTED[scenario]
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const roles = readPids(pidFile).map((p) => p.role)
    if (expected.every((r) => roles.includes(r))) break
    await sleep(100)
  }
  await sleep(300)
  const pids = readPids(pidFile)
  const inJob = job
    ? pids.filter((p) => alive(p.pid)).map((p) => `${p.role}:${job?.contains(p.pid) ? 'y' : 'n'}`)
    : []

  const started = performance.now()
  const shellPid = /** @type {number} */ (child?.pid)
  if (strategy === 'kill') child?.kill()
  else if (strategy === 'taskkill')
    spawnSync('taskkill', ['/T', '/F', '/PID', String(shellPid)], { windowsHide: true })
  else if (strategy === 'job') job?.terminate()
  else job?.close()

  // 最多等 5 秒，看还剩哪些进程
  const all = [{ role: 'shell', pid: shellPid }, ...pids]
  let left = all
  const killDeadline = Date.now() + 5_000
  while (Date.now() < killDeadline) {
    left = all.filter((p) => alive(p.pid))
    if (left.length === 0) break
    await sleep(100)
  }
  const ms = Math.round(performance.now() - started)
  // 清理残留，避免影响后续检查
  for (const p of left) spawnSync('taskkill', ['/F', '/PID', String(p.pid)], { windowsHide: true })
  await done
  if (strategy === 'job') job?.close()

  const started_ = expected.filter((r) => pids.some((p) => p.role === r))
  const ok = started_.length === expected.length && left.length === 0
  const parts = [
    started_.length === expected.length ? '' : `只启动了 ${started_.join(',')}`,
    left.length ? `残留 ${left.map((p) => p.role).join(',')}` : `${ms} ms 内全部结束`,
    usesJob ? `assign=${assigned} 作业内=${inJob.join(' ')}` : '',
  ]
  return { ok, detail: parts.filter(Boolean).join('；') }
}
