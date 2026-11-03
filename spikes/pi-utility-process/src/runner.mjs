// @ts-check
/**
 * 一次运行：启动 mock 端点，用空目录作为宿主的 HOME / USERPROFILE，启动宿主跑场景，判定并写出结果。
 * 宿主的启动方式（Node / Electron）由调用方提供。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { evaluate } from './checks.mjs'
import { API_KEY, startMockServer } from './mock-server.mjs'

const TIMEOUT_MS = 60_000

/**
 * @typedef {object} HostConfig
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {Record<string, string | undefined>} env 宿主进程的环境变量
 */

/**
 * @param {object} options
 * @param {string} options.label 结果中的环境名称
 * @param {(config: HostConfig) => Promise<unknown>} options.start 启动宿主，resolve 为宿主回传的结果
 * @param {string | undefined} options.out 结果文件
 */
export async function runSpike({ label, start, out }) {
  const mock = await startMockServer()
  const home = mkdtempSync(path.join(tmpdir(), 'pi-spike-home-'))
  /** @type {any} */
  let observed
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`host timed out after ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      )
    })
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    observed = await Promise.race([start({ baseUrl: mock.baseUrl, apiKey: API_KEY, env }), timeout])
  } catch (e) {
    observed = { error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
  const checks = evaluate({ observed, requests: mock.requests, baseUrl: mock.baseUrl, home })
  await mock.close()
  rmSync(home, { recursive: true, force: true })

  const result = {
    label,
    ok: checks.every((c) => c.ok),
    checks,
    probe: observed?.probe ?? null,
    scenarios: observed?.scenarios ?? null,
    error: observed?.error ?? null,
    requests: mock.requests,
  }
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`,
    )
  }
  if (result.error) console.log(`host error: ${result.error}`)
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** 解析 `--name=value` 形式的参数。 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) args[match[1]] = match[2]
  }
  return args
}
