// 汇总结果文件：node src/summarize.mjs <结果文件...>
// 输出 Markdown 表格（CI 中追加到 $GITHUB_STEP_SUMMARY），有任何检查失败时退出码为 1。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const files = process.argv.slice(2)
const lines = [
  '| 环境 | 平台 | Node / Electron | 引擎 | SQLite | 结果 | 加载 ms | 批量写入 行/秒 | 逐条提交 行/秒 | 读 2 万行 ms | 警告 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
]
let ok = true
for (const file of files) {
  if (!existsSync(file)) {
    ok = false
    lines.push(`| ${file} | - | - | - | - | 缺少结果文件 | - | - | - | - | - |`)
    continue
  }
  const r = JSON.parse(readFileSync(file, 'utf8'))
  ok &&= r.ok
  const runtime = r.versions.electron
    ? `${r.versions.node} / ${r.versions.electron}`
    : r.versions.node
  for (const e of r.engines) {
    const failed = e.checks.filter((c) => !c.ok).map((c) => c.name)
    const m = e.metrics
    lines.push(
      `| ${r.context} | ${r.platform} | ${runtime} | ${e.engine} ${e.version ?? ''} | ${e.sqliteVersion ?? '-'} | ${
        e.ok ? '通过' : `失败：${failed.join(', ')}`
      } | ${m.loadMs ?? '-'} | ${m.batchedRowsPerSec ?? '-'} | ${m.autocommitRowsPerSec ?? '-'} | ${m.readSessionMs ?? '-'} | ${
        e.warnings.length ? e.warnings.join('; ') : '-'
      } |`,
    )
  }
}
const table = lines.join('\n') + '\n'
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)
process.exitCode = ok ? 0 : 1
