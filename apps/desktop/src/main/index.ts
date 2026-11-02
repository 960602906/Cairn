/**
 * 主进程入口（ADR-0002、ADR-0003，架构 §4）。只做启动引导：确定数据目录、创建窗口。
 * 服务（存储、日志、宿主管理、IPC）在 M0-13 接入；窗口安全基线与 CSP 在 M0-12b 完善。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, utilityProcess } from 'electron'
import { requiredDirectories, resolveAppPaths } from './app-paths.js'
import { isSmokeRun, runSmokeChecks } from './smoke.js'

const paths = resolveAppPaths({
  appData: app.getPath('appData'),
  dev: !app.isPackaged,
  env: process.env,
})
app.setPath('userData', paths.root)
app.setPath('sessionData', paths.session)
for (const dir of requiredDirectories(paths)) mkdirSync(dir, { recursive: true })

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return window
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** 冒烟检查（`NEXUS_SMOKE=1`）的 Electron 部分，流程见 `smoke.ts`。 */
function startSmoke(window: BrowserWindow): void {
  const { webContents } = window
  void runSmokeChecks({
    waitForLoad: () =>
      webContents.isLoading()
        ? new Promise((resolve) => webContents.once('did-finish-load', () => resolve()))
        : Promise.resolve(),
    readRendererText: async () =>
      (await webContents.executeJavaScript(
        "document.getElementById('root')?.textContent ?? null",
      )) as string | null,
    startHost: () =>
      new Promise((resolve, reject) => {
        const host = utilityProcess.fork(join(import.meta.dirname, 'agent-host.js'), [], {
          serviceName: 'NEXUS-OS Agent Host',
        })
        host.once('message', (message: { type?: string }) => {
          if (message.type === 'host.started') resolve()
          host.kill()
        })
        host.once('exit', (code) => reject(new Error(`agent host exited with code ${code}`)))
      }),
    expectedText: 'NEXUS-OS',
    userData: app.getPath('userData'),
    report: (line) => process.stdout.write(`${line}\n`),
    exit: (code) => app.exit(code),
  })
}

void app.whenReady().then(() => {
  const window = createWindow()
  if (isSmokeRun(process.env)) startSmoke(window)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
