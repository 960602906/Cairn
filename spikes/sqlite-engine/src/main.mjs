// Electron 主进程入口：开发时 `electron src/main.mjs`，打包后直接运行应用。
// 参数 `--out=<文件>` 指定结果文件；不传时写到 userData 目录。
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { runAll } from './bench.mjs'

const outArg = process.argv.find((a) => a.startsWith('--out='))

app.whenReady().then(async () => {
  let code = 1
  try {
    const result = await runAll(app.isPackaged ? 'electron-packaged' : 'electron')
    const out = outArg
      ? path.resolve(outArg.slice('--out='.length))
      : path.join(app.getPath('userData'), 's4-result.json')
    const json = JSON.stringify(result, null, 2)
    writeFileSync(out, json)
    console.log(json)
    code = result.ok ? 0 : 1
  } catch (error) {
    console.error(error)
  }
  app.exit(code)
})
