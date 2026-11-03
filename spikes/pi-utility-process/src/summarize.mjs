// @ts-check
/**
 * 把若干结果文件汇总为 Markdown 表格，输出到标准输出；在 GitHub Actions 中同时写入作业摘要。
 *
 * 用法：node src/summarize.mjs result-*.json
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const files = process.argv.slice(2).filter((file) => existsSync(file))
const results = files.map((file) => JSON.parse(readFileSync(file, 'utf8')))

const lines = []
if (results.length === 0) {
  lines.push('没有结果文件。')
} else {
  lines.push(
    '| 环境 | 进程类型 | 版本 | 结果 | 加载 pi ms | 工具调用一轮 ms | 中止后结束 ms | 读取的环境变量 | 新增全局变量 |',
    '|---|---|---|---|---|---|---|---|---|',
  )
  for (const r of results) {
    const p = r.probe
    const s = r.scenarios
    const passed = r.checks.filter((c) => c.ok).length
    const version = p
      ? p.versions.electron
        ? `Electron ${p.versions.electron}`
        : `Node ${p.versions.node}`
      : '-'
    lines.push(
      [
        r.label,
        p?.processType ?? '-',
        version,
        `${r.ok ? '通过' : '失败'} ${passed}/${r.checks.length}`,
        s ? s.loadMs.toFixed(1) : '-',
        s ? s.tool.ms.toFixed(0) : '-',
        s?.abort.settleMsAfterAbort == null ? '-' : s.abort.settleMsAfterAbort.toFixed(1),
        p ? p.envReads.join(', ') || '-' : '-',
        p ? p.addedGlobals.join(', ') || '-' : '-',
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    )
  }
  const failed = results.flatMap((r) =>
    r.checks
      .filter((c) => !c.ok)
      .map((c) => `- ${r.label}：${c.name} ${JSON.stringify(c.detail ?? '')}`),
  )
  const errors = results.filter((r) => r.error).map((r) => `- ${r.label}：${r.error}`)
  if (failed.length > 0 || errors.length > 0) lines.push('', '失败项：', ...failed, ...errors)
}

const text = `${lines.join('\n')}\n`
process.stdout.write(text)
const summary = process.env['GITHUB_STEP_SUMMARY']
if (summary)
  appendFileSync(summary, `## S1 pi in utilityProcess (${process.platform})\n\n${text}\n`)
