// @ts-check
/**
 * S7 入口：`node src/cli.mjs [--out=result.json] [--only=encoding|tree] [--shells=powershell,pwsh]`。
 *
 * 对每个可用的 PowerShell 运行编码检查（三种包装方式）、长脚本回退、启动耗时与进程树结束检查，
 * 结果写入 JSON。`required` 的检查项失败时退出码为 1。
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEncodingCases, runFileFallback, startupMs } from './encoding.mjs'
import { findShells, runPowerShell, text } from './powershell.mjs'
import { runTreeCase, SCENARIOS, STRATEGIES } from './tree.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const out = args['out'] ?? 'result.json'
const only = args['only']
const wanted = args['shells']?.split(',')
const work = path.resolve('work')

/** 必须通过的进程树检查：作业对象两种方式全部场景；taskkill 只要求有父子关系的场景。 */
const treeRequired = (/** @type {string} */ scenario, /** @type {string} */ strategy) =>
  strategy === 'job' ||
  strategy === 'job-close' ||
  (strategy === 'taskkill' && scenario !== 'orphan')

const shells = findShells().filter((s) => !wanted || wanted.includes(s.id))
if (shells.length === 0) {
  console.error('没有找到 PowerShell')
  process.exit(1)
}

const chcp =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8' }).stdout.trim()
    : ''
const result = {
  platform: `${os.type()} ${os.release()} ${os.arch()}`,
  node: process.version,
  consoleCodePage: chcp,
  hasConsole: process.stdout.isTTY ?? false,
  shells: /** @type {unknown[]} */ ([]),
}

let failed = 0
for (const shell of shells) {
  const info = await runPowerShell(
    shell,
    "Write-Output ('ACP=' + [System.Text.Encoding]::Default.CodePage + ' OEM=' + [Console]::OutputEncoding.CodePage + ' culture=' + (Get-Culture).Name + ' ui=' + (Get-UICulture).Name)",
    { wrap: 'raw' },
  )
  /** @type {Record<string, unknown>} */
  const entry = { id: shell.id, version: shell.version, locale: text(info.stdout) }
  console.log(`== ${shell.id} ${shell.version} (${entry.locale})`)

  if (!only || only === 'encoding') {
    entry.startupMs = await startupMs(shell)
    const rows = await runEncodingCases(shell, work)
    entry.encoding = rows
    for (const row of rows) {
      const rec = row.results['recommended']
      const mark = (/** @type {{ ok: boolean } | null | undefined} */ r) =>
        r == null ? '-' : r.ok ? 'ok' : 'FAIL'
      console.log(
        `  ${row.id.padEnd(22)} raw=${mark(row.results['raw'])} prelude=${mark(row.results['prelude'])} recommended=${mark(rec)} ${rec && !rec.ok ? rec.detail : ''}`,
      )
      if (row.required && rec && !rec.ok) failed++
    }
    const fallback = await runFileFallback(shell, path.join(work, shell.id))
    entry.fileFallback = fallback
    console.log(`  file-fallback          ${fallback.ok ? 'ok' : 'FAIL'} ${fallback.detail}`)
    if (!fallback.ok) failed++
  }

  if ((!only || only === 'tree') && process.platform === 'win32') {
    /** @type {Record<string, unknown>[]} */
    const tree = []
    for (const scenario of SCENARIOS) {
      for (const strategy of STRATEGIES) {
        const r = await runTreeCase(shell, scenario, strategy, work)
        const required = treeRequired(scenario, strategy)
        tree.push({ scenario, strategy, required, ...r })
        console.log(
          `  tree ${scenario.padEnd(14)} ${strategy.padEnd(10)} ${r.ok ? 'ok' : 'FAIL'} ${r.detail}`,
        )
        if (required && !r.ok) failed++
      }
    }
    entry.tree = tree
  }
  result.shells.push(entry)
}

writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
console.log(failed ? `${failed} 项必须通过的检查失败` : '必须通过的检查全部通过')
process.exit(failed ? 1 : 0)
