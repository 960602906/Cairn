// @ts-check
/**
 * 进程树夹具：`node tree.mjs <mode> <pidFile> [role]`。每个进程把 `<role> <pid>` 追加到 pidFile 后一直等待。
 *
 * - `nested`：root → mid → leaf，三层都是普通子进程；
 * - `orphan`：root 以 detached 方式启动 mid（mid 再启动 leaf）后立即退出，mid、leaf 成为孤儿进程
 *   （父进程已不存在，`taskkill /T` 按父子关系找不到它们）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [mode = 'nested', pidFile = 'pids.txt', role = 'root'] = process.argv.slice(2)
appendFileSync(pidFile, `${role} ${process.pid}\n`)

const child = (/** @type {string} */ next, /** @type {boolean} */ detached) => {
  const c = spawn(process.execPath, [import.meta.filename, mode, pidFile, next], {
    stdio: 'ignore',
    detached,
    windowsHide: true,
  })
  if (detached) c.unref()
}

if (role === 'root') {
  child('mid', mode === 'orphan')
  if (mode === 'orphan') setTimeout(() => process.exit(0), 300)
} else if (role === 'mid') {
  child('leaf', false)
}
setInterval(() => {}, 60_000)
