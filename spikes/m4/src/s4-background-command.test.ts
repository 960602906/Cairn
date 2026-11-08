/**
 * S4：后台命令的进程树清理。
 *
 * 假设：现有的 Job Object（Windows）/ 进程组（其他平台）在“应用退出”等价于关闭作业句柄时，
 * 能结束命令启动的整个进程树；取消一个运行不会留下孤儿进程。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProcessTree, runCommand, selectShell } from '@cairn/shell'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-m4-s4-'))
  roots.push(root)
  return root
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error('timed out waiting for condition')
}

describe('S4 进程树清理', () => {
  it('关闭作业句柄（应用退出）会结束整个进程树', async () => {
    const tree = await createProcessTree()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    tree.attach(child.pid!)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    tree.dispose()
    await Promise.race([exited, sleep(10_000).then(() => Promise.reject(new Error('not killed')))])
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(tree.mechanism).toMatch(/job-object|process-group/)
    console.log(
      `M4_S4_RESULT ${JSON.stringify({ platform: process.platform, mechanism: tree.mechanism })}`,
    )
  })

  it('取消命令会结束命令及其子进程', async () => {
    const root = tempRoot()
    const pidFile = path.join(root, 'pid.txt')
    const fixture = path.join(import.meta.dirname, 'fixtures', 'long-running.mjs')
    const shell = await selectShell()
    const controller = new AbortController()
    const running = runCommand(shell, `node "${fixture}" "${pidFile}"`, {
      cwd: root,
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    await waitFor(() => fs.existsSync(pidFile))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(pid)).toBe(true)
    expect(alive(pid)).toBe(true)

    controller.abort()
    const result = await running
    expect(result.aborted).toBe(true)
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })
})
