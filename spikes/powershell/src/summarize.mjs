// @ts-check
/**
 * 把 cli.mjs 的结果汇总为 Markdown 表格（写入 GitHub Actions 作业摘要）。
 * `node src/summarize.mjs result-a.json [result-b.json ...]`
 */
import { appendFileSync, readFileSync } from 'node:fs'

const mark = (/** @type {{ ok: boolean | null, detail?: string } | null | undefined} */ r) =>
  r == null || r.ok === null ? '—' : `${r.ok ? '✅' : '❌'}${r.detail ? ` ${r.detail}` : ''}`

const lines = []
for (const file of process.argv.slice(2)) {
  const result = JSON.parse(readFileSync(file, 'utf8'))
  lines.push(
    `## ${file}`,
    '',
    `${result.platform}，Node ${result.node}，控制台：${result.consoleCodePage || '无'}`,
    '',
  )
  for (const shell of result.shells) {
    lines.push(
      `### ${shell.id} ${shell.version}（${shell.locale}），启动约 ${shell.startupMs ?? '—'} ms`,
      '',
    )
    if (shell.encoding) {
      lines.push('| 检查 | 必须 | raw | prelude | recommended |', '|---|---|---|---|---|')
      for (const row of shell.encoding) {
        const r = row.results
        lines.push(
          `| ${row.title} | ${row.required ? '是' : ''} | ${mark(r.raw)} | ${mark(r.prelude)} | ${mark(r.recommended)} |`,
        )
      }
      lines.push(
        `| 长脚本回退（-File，带 BOM 的 UTF-8） | 是 | | | ${mark(shell.fileFallback)} |`,
        '',
      )
    }
    if (shell.tree) {
      lines.push('| 场景 | 结束方式 | 必须 | 结果 |', '|---|---|---|---|')
      for (const t of shell.tree)
        lines.push(`| ${t.scenario} | ${t.strategy} | ${t.required ? '是' : ''} | ${mark(t)} |`)
      lines.push('')
    }
  }
}
const md = `${lines.join('\n')}\n`
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], md)
console.log(md)
