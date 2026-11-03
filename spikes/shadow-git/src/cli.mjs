// 用法：node src/cli.mjs [--source=system,bundled,isogit,system:pack] [--required=system,bundled]
//                       [--files=10000] [--root=<临时目录>] [--out=result.json]
// 来源可带配置变体（`system:pack`，见 shadow-cli.mjs 的 CONFIG_VARIANTS）。
// 退出码只取决于 --required 中的来源（含其全部变体）；isomorphic-git 的已知缺陷记录在结果中，不让作业失败。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCES, runBench } from './bench.mjs'
import { CONFIG_VARIANTS } from './shadow-cli.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const specs = (args.source ?? SOURCES.join(',')).split(',')
const files = Number(args.files ?? 10000)
const root = args.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shadow-git-'))
const out = args.out ?? 'result.json'
const required = (args.required ?? 'system,bundled').split(',')

for (const spec of specs) {
  const [source, variant = 'baseline'] = spec.split(':')
  if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`)
  if (!(variant in CONFIG_VARIANTS) || (source === 'isogit' && variant !== 'baseline')) {
    throw new Error(`unknown variant ${spec}`)
  }
}

// isomorphic-git 在 Windows 上会耗尽文件句柄（EMFILE），之后的写入可能暂时失败，稍等重试。
async function save(results) {
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n')
      return
    } catch (err) {
      if (err.code !== 'EMFILE' || i >= 10) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

const results = []
for (const spec of specs) {
  console.log(`== ${spec} (${files} files, root ${root})`)
  results.push(await runBench({ spec, root, files, log: (m) => console.log(`  ${m}`) }))
  await save(results)
}
fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })

for (const r of results) {
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name)
  console.log(
    `${r.source}:${r.variant}: ${r.ok ? 'ok' : 'FAILED'}${failed.length ? ` (${failed.join('; ')})` : ''}${r.error ? ` error` : ''}`,
  )
}
process.exitCode = results.every((r) => r.ok || !required.includes(r.source)) ? 0 : 1
