// 汇总结果文件：node src/summarize.mjs <结果文件...>
// 输出 Markdown 表格（CI 中追加到 $GITHUB_STEP_SUMMARY）。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const ms = (v) => (v === undefined || Number.isNaN(v) ? '-' : Math.round(v).toLocaleString('en-US'))
const mb = (b) => (b === undefined ? '-' : (b / 1024 / 1024).toFixed(1))

const timing = [
  '| 平台 | 来源 | 结果 | 首次检查点 | 无改动 | 小改动（中位） | 全部只改时间 | 大改动 | 恢复（中位） | 撤销恢复（中位） | 预览 diff |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
]
const behavior = [
  '| 平台 | 来源 | 版本 | 进程启动 ms | 分发体积 MB | 嵌套仓库 | 恢复后空目录 | 影子仓库 MB（gc 后） | gc ms | 失败的检查 |',
  '|---|---|---|---|---|---|---|---|---|---|',
]
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) {
    timing.push(`| ${file} | - | 缺少结果文件 | - | - | - | - | - | - | - | - |`)
    continue
  }
  for (const r of JSON.parse(readFileSync(file, 'utf8'))) {
    const s = r.steps
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name)
    const result = r.error ? '出错' : r.ok ? '通过' : '有失败项'
    timing.push(
      `| ${r.platform} | ${r.source} | ${result} | ${ms(s['checkpoint.initial']?.ms.total)} | ${ms(
        s['checkpoint.nochange']?.ms.total,
      )} | ${ms(s['checkpoint.small']?.ms.total)} | ${ms(s['checkpoint.touchAll']?.ms.total)} | ${ms(
        s['checkpoint.large']?.ms.total,
      )} | ${ms(s['restore.toInitial']?.ms.total)} | ${ms(s['restore.undo']?.ms.total)} | ${ms(
        s['restore.toInitial']?.ms.diff,
      )} |`,
    )
    const si = r.sourceInfo ?? {}
    const nested = Object.entries(r.info.nestedRepos ?? {})
      .map(([repo, kind]) => `${repo.split('/').pop()}: ${kind}`)
      .join('<br>')
    const empty = r.info.emptyDirsAfterRestore
    const shadow = r.info.shadowAfterGc ?? r.info.shadowBefore
    behavior.push(
      `| ${r.platform} | ${r.source} | ${si.version ?? '-'} | ${si.spawnMs?.toFixed(1) ?? '-'} | ${mb(
        si.install?.bytes,
      )} | ${nested || '-'} | ${empty ? empty.length : '-'} | ${mb(shadow?.bytes)} | ${ms(
        r.info.gcMs,
      )} | ${failed.length ? failed.join('; ') : '-'} |`,
    )
  }
}
const text = [
  '耗时单位 ms；1 万个文件，小改动为改 20 / 增 5 / 删 5，大改动为改 1000 / 增 500 / 删 500。',
  '',
  timing.join('\n'),
  '',
  behavior.join('\n'),
  '',
].join('\n')
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
