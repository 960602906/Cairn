/**
 * 主进程入口（ADR-0002、ADR-0003，架构 §4、§17）。只做启动引导：确定数据目录、应用安全基线、创建窗口。
 * 服务（存储、日志、宿主管理、IPC）在 M0-13 接入。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, shell, utilityProcess } from 'electron'
import { requiredDirectories, resolveAppPaths } from './app-paths.js'
import {
  hardenWebContents,
  restrictPermissions,
  secureWebPreferences,
  type NavigationPolicy,
  type WebContentsLike,
} from './security.js'
import { isSmokeRun, RENDERER_PROBE_SCRIPT, runSmokeChecks, type RendererProbe } from './smoke.js'

const paths = resolveAppPaths({
  appData: app.getPath('appData'),
  dev: !app.isPackaged,
  env: process.env,
})
app.setPath('userData', paths.root)
app.setPath('sessionData', paths.session)
for (const dir of requiredDirectories(paths)) mkdirSync(dir, { recursive: true })

const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const navigationPolicy: NavigationPolicy = {
  rendererUrl: pathToFileURL(rendererFile).href,
  devServerUrl,
}

// 对所有 WebContents（含将来的子窗口、DevTools 之外的页面）拦截导航、新窗口与 <webview>
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents as unknown as WebContentsLike, {
    policy: navigationPolicy,
    openExternal: (url) => void shell.openExternal(url),
  })
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: secureWebPreferences(join(import.meta.dirname, '../preload/index.cjs')),
  })
  window.once('ready-to-show', () => window.show())
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(rendererFile)
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
    probeRenderer: async () =>
      (await webContents.executeJavaScript(RENDERER_PROBE_SCRIPT)) as RendererProbe,
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
  restrictPermissions(session.defaultSession)
  const window = createWindow()
  if (isSmokeRun(process.env)) startSmoke(window)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
