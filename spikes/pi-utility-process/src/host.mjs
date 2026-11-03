// @ts-check
/**
 * 宿主入口。两种启动方式共用：
 * - Electron `utilityProcess.fork`：与应用一致，主进程经 `{ type: 'port' }` 消息转交专用 MessagePort，
 *   配置与结果都走这个端口；
 * - Node `child_process.fork`：经 IPC 通道收发（纯 Node 对照组）。
 *
 * 先安装探测（`probe.mjs`），再加载 pi 跑场景，结果为 `{ probe, scenarios }` 或 `{ probe, error }`。
 */
import { installProbe } from './probe.mjs'

const probe = installProbe()

/** @param {{ baseUrl: string, apiKey: string }} config */
async function run(config) {
  try {
    const { runScenarios } = await import('./scenario.mjs')
    return { probe: probe.report(), scenarios: await runScenarios(config) }
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)
    return { probe: probe.report(), error }
  }
}

/** 回复送出后再退出。 */
const exitSoon = () => setTimeout(() => process.exit(0), 50)

const parentPort = /** @type {any} */ (process).parentPort
if (parentPort) {
  parentPort.once('message', (/** @type {any} */ event) => {
    const port = event.ports?.[0]
    if (event.data?.type !== 'port' || !port) return
    port.once('message', async (/** @type {any} */ message) => {
      port.postMessage(await run(message.data))
      exitSoon()
    })
    port.start()
  })
} else if (process.send) {
  process.once('message', async (config) => {
    process.send?.(await run(/** @type {any} */ (config)), () => exitSoon())
  })
} else {
  console.error('host.mjs must be started by main.mjs (Electron) or cli.mjs (Node)')
  process.exit(2)
}
