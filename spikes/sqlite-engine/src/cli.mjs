// 在纯 Node 中运行：node src/cli.mjs [结果文件]
import { writeFileSync } from 'node:fs'
import { runAll } from './bench.mjs'

const out = process.argv[2]
const result = await runAll('node')
const json = JSON.stringify(result, null, 2)
if (out) writeFileSync(out, json)
console.log(json)
process.exitCode = result.ok ? 0 : 1
