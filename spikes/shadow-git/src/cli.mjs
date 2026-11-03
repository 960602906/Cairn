// 用法：node src/cli.mjs [--source=system,bundled,isogit] [--required=system,bundled] [--files=10000]
//                       [--root=<临时目录>] [--out=result.json]
// 退出码只取决于 --required 中的来源；isomorphic-git 的已知缺陷记录在结果中，不让作业失败。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCES, runBench } from './bench.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const sources = (args.source ?? SOURCES.join(',')).split(',')
const files = Number(args.files ?? 10000)
const root = args.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shadow-git-'))
const out = args.out ?? 'result.json'

const results = []
for (const source of sources) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`)
  console.log(`== ${source} (${files} files, root ${root})`)
  results.push(await runBench({ source, root, files, log: (m) => console.log(`  ${m}`) }))
}
fs.rmSync(root, { recursive: true, force: true })
fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n')

for (const r of results) {
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name)
  console.log(
    `${r.source}: ${r.ok ? 'ok' : 'FAILED'}${failed.length ? ` (${failed.join('; ')})` : ''}${r.error ? ` error` : ''}`,
  )
}
const required = (args.required ?? 'system,bundled').split(',')
process.exitCode = results.every((r) => r.ok || !required.includes(r.source)) ? 0 : 1
