// @ts-check
/**
 * Electron 主进程：与应用相同，用 `utilityProcess.fork` 启动宿主，经 `MessageChannelMain` 的专用端口
 * 收发。mock 端点运行在主进程中，宿主经 127.0.0.1 访问。不创建窗口。
 *
 * 用法：electron . --out=result-electron.json [--host=source|bundled]
 * 打包后：<可执行文件> --out=result-packaged.json（宿主从 app.asar 中加载）
 */
import path from 'node:path'
import { app, MessageChannelMain, utilityProcess } from 'electron'
import { parseArgs, runSpike } from './runner.mjs'

const args = parseArgs(process.argv.slice(1))
const bundled = args['host'] === 'bundled'
const entry = path.join(app.getAppPath(), bundled ? 'dist/host.mjs' : 'src/host.mjs')
const label = `${app.isPackaged ? 'packaged' : 'electron'}${bundled ? ' (bundled)' : ''}`

app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  const result = await runSpike({
    label,
    out: args['out'] && path.resolve(process.cwd(), args['out']),
    start: ({ baseUrl, apiKey, env }) =>
      new Promise((resolve, reject) => {
        const child = utilityProcess.fork(entry, [], {
          serviceName: 'pi spike host',
          env,
          stdio: 'inherit',
        })
        const { port1, port2 } = new MessageChannelMain()
        port1.once('message', (event) => resolve(event.data))
        port1.start()
        child.once('exit', (code) => reject(new Error(`host exited with code ${code}`)))
        child.postMessage({ type: 'port' }, [port2])
        port1.postMessage({ baseUrl, apiKey })
      }),
  })
  app.exit(result.ok ? 0 : 1)
})
