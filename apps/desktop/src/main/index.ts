/**
 * 主进程入口（M5-01，ADR-0035）：只做应用身份与单实例裁决，然后加载 `startup.ts`。
 *
 * 顺序是硬约束：先确定数据目录 → 设置 AppUserModelID → 取得单实例锁。第二实例不加载启动模块，
 * 因此不会创建窗口，也不会打开 SQLite 数据库。启动模块在锁内动态导入，避免模块级副作用先于锁执行。
 */
import { homedir } from 'node:os'
import { redact } from '@cairn/core'
import { app } from 'electron'
import { resolveAppPaths } from './app-paths.js'
import { appUserModelId } from './app-identity.js'
import { configureElectronRuntime } from './electron-runtime.js'

configureElectronRuntime(process.env, app.commandLine)

const paths = resolveAppPaths({
  appData: app.getPath('appData'),
  dev: !app.isPackaged,
  env: process.env,
})

// 单实例锁按 userData 区分：开发版与安装版、以及不同 CAIRN_USER_DATA_DIR 互不干扰。
app.setPath('userData', paths.root)
app.setPath('sessionData', paths.session)
app.setAppUserModelId(appUserModelId(app.isPackaged))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const startup = import('./startup.js')
  startup.catch((error: unknown) => {
    console.error('[cairn]', redact(error, { homeDirs: [homedir()], secrets: [] }))
    app.quit()
  })
  app.on('second-instance', () => {
    void startup.then((module) => module.focusPrimaryWindow()).catch(() => {})
  })
}
