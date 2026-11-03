// @ts-check
/**
 * 纯 Node 对照组：用 `child_process.fork` 启动宿主（IPC 通道收发）。
 *
 * 用法：node src/cli.mjs --out=result-node.json [--host=source|bundled]
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { parseArgs, runSpike } from './runner.mjs'

const args = parseArgs(process.argv.slice(2))
const bundled = args['host'] === 'bundled'
const root = path.resolve(import.meta.dirname, '..')
const entry = path.join(root, bundled ? 'dist/host.mjs' : 'src/host.mjs')

const result = await runSpike({
  label: `node${bundled ? ' (bundled)' : ''}`,
  out: args['out'],
  start: ({ baseUrl, apiKey, env }) =>
    new Promise((resolve, reject) => {
      const child = fork(entry, [], { env, stdio: 'inherit' })
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`host exited with code ${code}`)))
      child.send({ baseUrl, apiKey })
    }),
})
process.exit(result.ok ? 0 : 1)
